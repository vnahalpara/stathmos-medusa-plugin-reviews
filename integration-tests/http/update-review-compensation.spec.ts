import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { REVIEW_MODULE } from '../../src/modules/review'
import { applyReviewEditStep } from '../../src/workflows/steps/apply-review-edit'
import { UpdateReviewInput } from '../../src/workflows/update-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'

/**
 * updateReviewWorkflow runs recomputeReviewStatsStep after
 * applyReviewEditStep, so a downstream failure in production already
 * exercises this compensation path. A plain injected failing step, run
 * immediately after the real one, reproduces "a downstream step fails
 * after this step committed" deterministically - the same technique every
 * other *-compensation.spec.ts file in this repo uses (see
 * update-review-settings-compensation.spec.ts's docstring for why a real
 * framework step like emitEventStep was flaky to force a throw inside,
 * and moderate-reviews-/vote-review-compensation.spec.ts for the same
 * plain-injected-step pattern applied to a step with no emitEventStep at
 * all, which is this workflow's actual shape).
 */
const alwaysFail = createStep('always-fail-after-edit', async () => {
  throw new Error('forced failure for compensation test')
})

const workflowUnderTest = createWorkflow(
  'update-review-compensation-test',
  function (input: UpdateReviewInput) {
    const result = applyReviewEditStep(input)
    // No data dependency on `result`: ordering between plain (non-
    // emitEventStep) steps is sequential regardless - same reasoning as
    // the other *-compensation.spec.ts files - and threading `result`
    // through only to satisfy a type signature would misleadingly imply
    // the ordering depends on it.
    alwaysFail()
    return new WorkflowResponse(result)
  }
)

async function runAndExpectRejection(promise: Promise<unknown>, messageIncludes: string) {
  let threw = false
  try {
    await promise
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain(messageIncludes)
  }
  expect(threw).toBe(true)
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('applyReviewEditStep compensation', () => {
      afterEach(async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const rows = await service.listReviewSettings()
        if (rows.length) {
          await service.deleteReviewSettings(rows.map((r) => r.id))
        }
        await updateReviewSettingsWorkflow(getContainer()).run({ input: {} })
      })

      it('restores rating, title, content, status and edited_at when a downstream step fails after an edit that stays approved', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: false },
        })

        const review = await service.createReviews({
          product_id: 'prod_edit_comp_stays_approved',
          customer_id: 'cus_edit_comp_owner',
          display_name: 'Comp Owner',
          rating: 3,
          title: 'Original title',
          content: 'Original content that must come back exactly as it was.',
          status: 'approved',
        })
        expect(review.edited_at).toBeNull()

        // A second, unrelated review - never named in the input below -
        // proves the compensation restores only the one row it snapshotted,
        // not a blanket write across the table.
        const untouched = await service.createReviews({
          product_id: 'prod_edit_comp_decoy',
          customer_id: 'cus_edit_comp_decoy',
          display_name: 'Decoy',
          rating: 1,
          title: 'Decoy title',
          content: 'Decoy content that this compensation must never touch.',
          status: 'approved',
        })

        await runAndExpectRejection(
          workflowUnderTest(container).run({
            input: {
              review_id: review.id,
              customer_id: 'cus_edit_comp_owner',
              rating: 5,
              title: 'Attempted new title',
              content: 'Attempted new content that must never be persisted.',
            },
          }),
          'forced failure for compensation test'
        )

        const restored = await service.retrieveReview(review.id)
        expect(restored.rating).toEqual(3)
        expect(restored.title).toEqual('Original title')
        expect(restored.content).toEqual(
          'Original content that must come back exactly as it was.'
        )
        expect(restored.status).toEqual('approved')
        // The load-bearing assertion the brief calls out specifically: a
        // review left with a non-null edited_at for an edit that never
        // actually happened is a visible lie in the UI ("edited" shown on
        // content that is, in fact, entirely original).
        expect(restored.edited_at).toBeNull()

        const stillUntouched = await service.retrieveReview(untouched.id)
        expect(stillUntouched.rating).toEqual(1)
        expect(stillUntouched.title).toEqual('Decoy title')
        expect(stillUntouched.content).toEqual(
          'Decoy content that this compensation must never touch.'
        )
        expect(stillUntouched.edited_at).toBeNull()
      })

      it('restores an approved review to approved (not left pending) when a downstream step fails after an edit that would have triggered re-moderation', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: true },
        })

        const review = await service.createReviews({
          product_id: 'prod_edit_comp_remoderation',
          customer_id: 'cus_edit_comp_remod_owner',
          display_name: 'Comp Owner',
          rating: 4,
          content: 'Content that must stay approved if the edit never actually completes.',
          status: 'approved',
        })

        await runAndExpectRejection(
          workflowUnderTest(container).run({
            input: {
              review_id: review.id,
              customer_id: 'cus_edit_comp_remod_owner',
              content: 'Edited content that would have sent this back to pending.',
            },
          }),
          'forced failure for compensation test'
        )

        const restored = await service.retrieveReview(review.id)
        expect(restored.status).toEqual('approved')
        expect(restored.content).toEqual(
          'Content that must stay approved if the edit never actually completes.'
        )
        expect(restored.edited_at).toBeNull()
      })
    })
  },
})
