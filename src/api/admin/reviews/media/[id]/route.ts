import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../../../modules/review'
import { deleteReviewMediaWorkflow } from '../../../../../workflows/delete-review-media'
import { recomputeReviewStats } from '../../../../../workflows/steps/recompute-review-stats'

export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { result } = await deleteReviewMediaWorkflow(req.scope).run({
    input: { id: req.params.id },
  })

  // Keeps the public summary honest after the deletion. The workflow only
  // knows review_id, not product_id, so the review is resolved here and
  // recomputeReviewStats is called directly - see delete-review-media.ts.
  if (result.review_id) {
    const service = req.scope.resolve(REVIEW_MODULE)
    const [review] = await service.listReviews({ id: result.review_id })

    if (review) {
      await recomputeReviewStats(req.scope, review.product_id)
    }
  }

  res.json({ id: result.id, object: 'review_media', deleted: true })
}
