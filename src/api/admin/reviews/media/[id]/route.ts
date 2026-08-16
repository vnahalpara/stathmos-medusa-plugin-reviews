import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { deleteReviewMediaWorkflow } from '../../../../../workflows/delete-review-media'
import { recomputeReviewStats } from '../../../../../workflows/steps/recompute-review-stats'

export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { result } = await deleteReviewMediaWorkflow(req.scope).run({
    input: { id: req.params.id },
  })

  // Keeps the public summary honest after the deletion. The workflow cannot
  // do this itself (a composition function cannot make service calls), so
  // it happens here - see delete-review-media.ts. The product id comes from
  // the step, which resolves it before destroying the row; re-resolving it
  // here would repeat a query whose subject no longer exists.
  if (result.product_id) {
    await recomputeReviewStats(req.scope, result.product_id)
  }

  res.json({ id: result.id, object: 'review_media', deleted: true })
}
