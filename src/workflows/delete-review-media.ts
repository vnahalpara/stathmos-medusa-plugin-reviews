import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { deleteReviewMediaStep } from './steps/delete-review-media'

// Deliberately does not recompute review stats here: this step only knows
// the media's review_id, not its product_id, and a second lookup inside a
// composition function is illegal (composition functions cannot run
// arbitrary async code, only wire steps together). Adding a whole step just
// to resolve a product id for this one caller is not worth it, so the route
// resolves the review and calls recomputeReviewStats(container, productId)
// directly after this workflow returns.
export const deleteReviewMediaWorkflow = createWorkflow(
  'delete-review-media',
  function (input: { id: string }) {
    const deleted = deleteReviewMediaStep(input)

    return new WorkflowResponse(deleted)
  }
)
