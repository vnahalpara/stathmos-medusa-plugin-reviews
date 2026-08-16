import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { moderateReviewsStep } from './steps/moderate-reviews'
import { recomputeReviewStatsStep } from './steps/recompute-review-stats'

export type ModerateReviewsInput = {
  ids: string[]
  status: 'approved' | 'rejected' | 'pending'
  rejection_reason?: string | null
}

export const moderateReviewsWorkflow = createWorkflow(
  'moderate-reviews',
  function (input: ModerateReviewsInput) {
    const result = moderateReviewsStep(input)

    // Approving/rejecting must be reflected in the public summary by the
    // time this workflow returns, not on some later write - so the recompute
    // runs inline here rather than being left to a subscriber.
    //
    // Known limitation: recomputeReviewStatsStep recomputes exactly one
    // product per invocation, so this only ever refreshes product_ids[0].
    // A single-product moderation (approve/reject one review, or a batch
    // action scoped to one product - the normal admin-UI case) is fully
    // correct. A batch action spanning several products in one call will
    // leave every product after the first with a stale summary until it is
    // next recomputed by another write. Deliberately accepted for Phase 1;
    // not silently "handled" - only the first product is ever touched.
    recomputeReviewStatsStep(
      transform({ result }, (data) => ({ product_id: data.result.product_ids[0] }))
    )

    // `product_ids` is additive: `ids` is unchanged, so anything already
    // subscribed keeps working. It exists for the same reason the newer
    // events carry `product_id` - a subscriber invalidating a cache needs
    // to know WHICH product page changed, and a batch moderation is the
    // one place in this plugin where that is legitimately a set rather
    // than a single value (deduped by moderateReviewsStep). Without it,
    // every host following the revalidation recipe would have to re-read
    // the reviews it was just told about purely to learn their products.
    emitEventStep(
      transform({ input, result }, (data) => ({
        eventName: data.input.status === 'approved' ? 'review.approved' : 'review.rejected',
        data: { ids: data.input.ids, product_ids: data.result.product_ids },
      }))
    )

    return new WorkflowResponse(result)
  }
)
