import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { applyReviewEditStep } from './steps/apply-review-edit'
import { recomputeReviewStatsStep } from './steps/recompute-review-stats'

export type UpdateReviewInput = {
  review_id: string
  customer_id: string | null
  rating?: number
  title?: string | null
  content?: string
}

export const updateReviewWorkflow = createWorkflow(
  'update-review',
  function (input: UpdateReviewInput) {
    const result = applyReviewEditStep(input)

    // Same reasoning as moderateReviewsWorkflow: an edit that returns the
    // review to `pending` must stop counting toward the product's average
    // by the time this workflow returns, not on some later write - an
    // edited-and-unapproved review must never keep contributing to a
    // summary the storefront reads on every product page.
    recomputeReviewStatsStep(
      transform({ result }, (data) => ({ product_id: data.result.product_id }))
    )

    // Emitted for every edit, including one that only fixes a typo and
    // leaves the review approved. The transition that makes this event
    // load-bearing is the other one: under `require_approval`, an edit
    // sends an approved review back to `pending`, which REMOVES it from
    // the storefront. Without an event, a host on ISR keeps serving the
    // old text - and the whole review - for its full cache window, the
    // same class of failure as a rejection that never invalidates.
    //
    // Emitted after recomputeReviewStatsStep, not before: a subscriber
    // that revalidates a product page must not be able to re-fetch stats
    // that still count a review this workflow has just unpublished.
    //
    // `product_id` because that is the only thing a cache-invalidating
    // subscriber can act on - the review id alone would make every host
    // look the product up again.
    emitEventStep(
      transform({ result }, (data) => ({
        eventName: 'review.updated',
        data: { id: data.result.review.id, product_id: data.result.product_id },
      }))
    )

    return new WorkflowResponse(result.review)
  }
)
