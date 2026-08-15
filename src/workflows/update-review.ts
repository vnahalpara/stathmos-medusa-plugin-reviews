import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
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

    return new WorkflowResponse(result.review)
  }
)
