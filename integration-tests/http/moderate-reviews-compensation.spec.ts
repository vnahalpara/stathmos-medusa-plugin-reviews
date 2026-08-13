import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { REVIEW_MODULE } from '../../src/modules/review'
import { moderateReviewsStep } from '../../src/workflows/steps/moderate-reviews'
import { ModerateReviewsInput } from '../../src/workflows/moderate-reviews'

/**
 * moderateReviewsWorkflow runs recomputeReviewStatsStep and emitEventStep
 * after moderateReviewsStep, so a downstream failure in production already
 * exercises this compensation path. This test forces that same shape of
 * failure - a later step throwing after moderateReviewsStep has committed -
 * to prove the compensation restores each review to its own prior state
 * rather than resetting the whole batch to one value.
 *
 * A plain injected failing step is used instead of forcing a failure inside
 * the real emitEventStep, for the same reliability reason documented in
 * update-review-settings-compensation.spec.ts: emitEventStep's event is
 * deferred/buffered, and forcing a throw there was flaky in this local
 * workflow engine. A plain createStep reproduces the same "downstream step
 * fails after the moderation step committed" shape deterministically.
 */
const alwaysFail = createStep('always-fail-after-moderation', async () => {
  throw new Error('forced failure for compensation test')
})

const workflowUnderTest = createWorkflow(
  'moderate-reviews-compensation-test',
  function (input: ModerateReviewsInput) {
    const result = moderateReviewsStep(input)
    // No data dependency on `result`: ordering between plain (non-
    // emitEventStep) steps is sequential regardless, and threading `result`
    // through only to satisfy a type signature would misleadingly imply the
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
    describe('moderateReviewsStep compensation', () => {
      it('restores each review to its own previous status/reason individually, and never touches a review outside the batch', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const alreadyApproved = await service.createReviews({
          product_id: 'prod_comp',
          display_name: 'Already approved',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const previouslyRejected = await service.createReviews({
          product_id: 'prod_comp',
          display_name: 'Previously rejected',
          rating: 2,
          content: 'x'.repeat(10),
          status: 'rejected',
          rejection_reason: 'Spam',
        })

        const untouched = await service.createReviews({
          product_id: 'prod_comp',
          display_name: 'Not in this batch',
          rating: 3,
          content: 'x'.repeat(10),
          status: 'pending',
        })

        await runAndExpectRejection(
          workflowUnderTest(container).run({
            input: { ids: [alreadyApproved.id, previouslyRejected.id], status: 'approved' },
          }),
          'forced failure for compensation test'
        )

        const restoredApproved = await service.retrieveReview(alreadyApproved.id)
        expect(restoredApproved.status).toEqual('approved')
        expect(restoredApproved.rejection_reason).toBeNull()

        // The load-bearing assertion: this review must come back to its own
        // prior state (rejected, with its own reason) rather than being left
        // approved (the failed write) or blanket-reset to some shared value.
        const restoredRejected = await service.retrieveReview(previouslyRejected.id)
        expect(restoredRejected.status).toEqual('rejected')
        expect(restoredRejected.rejection_reason).toEqual('Spam')

        // Never part of the batch - must be exactly as created.
        const stillUntouched = await service.retrieveReview(untouched.id)
        expect(stillUntouched.status).toEqual('pending')
        expect(stillUntouched.rejection_reason).toBeNull()
      })
    })
  },
})
