import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { REVIEW_MODULE } from '../../src/modules/review'
import { upsertReviewReplyStep } from '../../src/workflows/steps/upsert-review-reply'
import { ReplyToReviewInput } from '../../src/workflows/reply-to-review'

/**
 * replyToReviewWorkflow runs emitEventStep after upsertReviewReplyStep, so a
 * live event-bus failure already exercises this compensation path in
 * production, not just in some hypothetical future workflow. These tests
 * force that same shape of failure - a downstream step failing after
 * upsertReviewReplyStep has committed - to prove its compensation actually
 * hard-deletes a freshly created reply, and restores the previous text
 * rather than deleting it, when the step it rolls back was an edit.
 *
 * A plain injected failing step is used instead of forcing a failure inside
 * the real emitEventStep, for the same reliability reason documented in
 * update-review-settings-compensation.spec.ts and
 * moderate-reviews-compensation.spec.ts: emitEventStep's event is
 * deferred/buffered, and forcing a throw there was flaky in this local
 * workflow engine. replyToReviewWorkflow's shape (one write step +
 * emitEventStep) is structurally identical to updateReviewSettingsWorkflow's
 * and moderateReviewsWorkflow's, so the injected failing step goes after
 * upsertReviewReplyStep exactly the way it goes after
 * updateReviewSettingsStep/moderateReviewsStep in those files.
 */
const alwaysFail = createStep('always-fail-after-reply', async () => {
  throw new Error('forced failure for compensation test')
})

const workflowUnderTest = createWorkflow(
  'upsert-review-reply-compensation-test',
  function (input: ReplyToReviewInput) {
    const result = upsertReviewReplyStep(input)
    // No data dependency on `result`: ordering between plain (non-
    // emitEventStep) steps is sequential regardless - same reasoning as the
    // other *-compensation.spec.ts files - and threading `result` through
    // only to satisfy a type signature would misleadingly imply the
    // ordering depends on it.
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
    describe('upsertReviewReplyStep compensation', () => {
      it('hard-deletes a freshly created reply when a downstream step fails after a create', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_reply_comp',
          display_name: 'Comp A',
          rating: 5,
          content: 'x'.repeat(10),
        })

        await runAndExpectRejection(
          workflowUnderTest(container).run({
            input: { review_id: review.id, content: 'First reply', replied_by: 'usr_test' },
          }),
          'forced failure for compensation test'
        )

        // The load-bearing assertion: nothing was ever published for anyone
        // to see as canon, so rollback must leave zero rows behind - not a
        // soft-deleted row still occupying the partial unique index.
        expect(await service.listReviewReplies({ review_id: review.id })).toHaveLength(0)
      })

      it('restores the previous text when a downstream step fails after an edit', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_reply_comp_2',
          display_name: 'Comp B',
          rating: 4,
          content: 'y'.repeat(10),
        })

        const original = await service.createReviewReplies({
          review_id: review.id,
          content: 'Original reply',
          replied_by: 'usr_test',
        })

        await runAndExpectRejection(
          workflowUnderTest(container).run({
            input: { review_id: review.id, content: 'Edited reply', replied_by: 'usr_test' },
          }),
          'forced failure for compensation test'
        )

        // The load-bearing assertion: an edit that fails downstream must
        // roll back to what was live before it, not erase the merchant's
        // already-published reply and not leave the failed edit in place.
        const restored = await service.retrieveReviewReply(original.id)
        expect(restored.content).toEqual('Original reply')
      })
    })
  },
})
