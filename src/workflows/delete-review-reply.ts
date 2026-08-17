import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { deleteReviewReplyStep } from './steps/delete-review-reply'

/**
 * Emits `review.reply.deleted`.
 *
 * This workflow deliberately emitted NOTHING until Phase 5, and the
 * argument for that is worth recording rather than deleting, because it
 * was sound when it was written and it is the changed circumstances, not
 * the reasoning, that superseded it. It ran: removing a row is not an
 * event-worthy transition here, only creating or editing one is; the spec
 * named no subscriber for a reply deletion; and the only consumer in sight
 * (Task 4's public reply exposure) needed the reply's current
 * presence/absence via a GET, not a delta. It closed with the condition
 * under which it should be revisited - "add `review.reply.deleted` later
 * if a concrete consumer needs it".
 *
 * Phase 5 shipped that consumer. A storefront now caches the reply as part
 * of the review list it renders on the product page, so "the row is gone"
 * and "shoppers stop seeing it" are no longer the same moment. A merchant
 * deleting a reply - the thing they do when they posted it in error, to
 * the wrong review, or said something they should not have - would leave
 * it on a cached PDP for the whole ISR window with nothing able to
 * invalidate it. That is the same failure `review.media.deleted` closed
 * for photos, one surface over, and the "no consumer" premise no longer
 * holds.
 *
 * `product_id` is what a subscriber acts on (the reply lives on a product
 * page); `review_id` identifies which review lost its reply.
 *
 * `when`, for the same reason as the media events: with no product there
 * is no page to invalidate. Unlike media, that case is not reachable today
 * - a reply cannot outlive its review while nothing can delete a review -
 * so this is a guard against a null payload, not a supported path.
 */
export const deleteReviewReplyWorkflow = createWorkflow(
  'delete-review-reply',
  function (input: { review_id: string }) {
    const result = deleteReviewReplyStep(input)

    when({ result }, (data) => Boolean(data.result.product_id)).then(() => {
      emitEventStep(
        transform({ result }, (data) => ({
          eventName: 'review.reply.deleted',
          data: {
            review_id: data.result.review_id,
            product_id: data.result.product_id,
          },
        }))
      )
    })

    return new WorkflowResponse(result)
  }
)
