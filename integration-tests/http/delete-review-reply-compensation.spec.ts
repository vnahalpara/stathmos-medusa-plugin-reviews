import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { REVIEW_MODULE } from '../../src/modules/review'
import { deleteReviewReplyStep } from '../../src/workflows/steps/delete-review-reply'

/**
 * deleteReviewReplyWorkflow today is a single step with no downstream step
 * after it, so nothing in production yet exercises this compensation path.
 * That is exactly why it needs its own test: an unexercised compensation
 * path is the one most likely to silently rot (e.g. if a future task adds
 * a step after deleteReviewReplyStep - notifying a subscriber, say - and
 * that step can fail). This test forces that same shape of failure - a
 * downstream step throwing after deleteReviewReplyStep has committed - to
 * prove the compensation actually recreates the deleted reply rather than
 * leaving the merchant's published response gone.
 *
 * Same reliability reasoning as the other *-compensation.spec.ts files: a
 * plain injected failing step reproduces "downstream step fails after this
 * step committed" deterministically, without relying on forcing a throw
 * inside a real framework step.
 */
const alwaysFail = createStep('always-fail-after-delete', async () => {
  throw new Error('forced failure for compensation test')
})

const workflowUnderTest = createWorkflow(
  'delete-review-reply-compensation-test',
  function (input: { review_id: string }) {
    const result = deleteReviewReplyStep(input)
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
    describe('deleteReviewReplyStep compensation', () => {
      it('recreates the deleted reply when a downstream step fails', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_reply_delete_comp',
          display_name: 'Comp C',
          rating: 5,
          content: 'x'.repeat(10),
        })

        await service.createReviewReplies({
          review_id: review.id,
          content: 'Original reply',
          replied_by: 'usr_test',
        })

        await runAndExpectRejection(
          workflowUnderTest(container).run({ input: { review_id: review.id } }),
          'forced failure for compensation test'
        )

        // The load-bearing assertion: the merchant's reply must come back
        // with its original content - a later, unrelated step failing must
        // not be the reason a published response silently disappears.
        const restored = await service.listReviewReplies({ review_id: review.id })
        expect(restored).toHaveLength(1)
        expect(restored[0].content).toEqual('Original reply')
        expect(restored[0].replied_by).toEqual('usr_test')
      })

      it('leaves nothing behind when the review has no reply to delete', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_reply_delete_comp_2',
          display_name: 'Comp D',
          rating: 4,
          content: 'y'.repeat(10),
        })

        // deleteReviewReplyStep throws NOT_FOUND before returning a
        // StepResponse, so there is no compensation payload to run - this
        // proves that failure mode doesn't crash the rollback path.
        await runAndExpectRejection(
          workflowUnderTest(container).run({ input: { review_id: review.id } }),
          'Reply not found'
        )

        expect(await service.listReviewReplies({ review_id: review.id })).toHaveLength(0)
      })
    })
  },
})
