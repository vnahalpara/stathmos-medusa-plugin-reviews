import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { moderateReviewsWorkflow } from '../../../../../workflows/moderate-reviews'
import { BatchStatusSchema } from '../../middlewares'

export async function POST(
  req: AuthenticatedMedusaRequest<BatchStatusSchema>,
  res: MedusaResponse
) {
  const { result } = await moderateReviewsWorkflow(req.scope).run({
    input: req.validatedBody,
  })

  res.json({ reviews: result.reviews })
}
