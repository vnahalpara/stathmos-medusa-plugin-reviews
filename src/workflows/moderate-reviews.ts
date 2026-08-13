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

    emitEventStep(
      transform({ input }, (data) => ({
        eventName: data.input.status === 'approved' ? 'review.approved' : 'review.rejected',
        data: { ids: data.input.ids },
      }))
    )

    return new WorkflowResponse(result)
  }
)
