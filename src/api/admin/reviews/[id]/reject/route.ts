import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { moderateReviewsWorkflow } from '../../../../../workflows/moderate-reviews'
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

  res.json({ review: result.reviews[0] })
}
