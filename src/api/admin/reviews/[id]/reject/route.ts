import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { moderateReviewsWorkflow } from '../../../../../workflows/moderate-reviews'
import { deleteMediaForRejectedReviews } from '../../../../../workflows/delete-rejected-review-media'
import { RejectReviewSchema } from '../../middlewares'

export async function POST(
  req: AuthenticatedMedusaRequest<RejectReviewSchema>,
  res: MedusaResponse
) {
  const { result } = await moderateReviewsWorkflow(req.scope).run({
    input: {
      ids: [req.params.id],
      status: 'rejected',
      rejection_reason: req.validatedBody.rejection_reason,
    },
  })

  // Runs only after the status change above has committed, in its own
  // separate workflow run - see delete-rejected-review-media.ts for why a
  // media-deletion failure here must never be able to revert this review
  // back to pending.
  await deleteMediaForRejectedReviews(
    req.scope,
    result.reviews.map((review) => review.id)
  )

  res.json({ review: result.reviews[0] })
}
