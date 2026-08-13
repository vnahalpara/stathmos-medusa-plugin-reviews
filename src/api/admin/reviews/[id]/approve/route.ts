import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { moderateReviewsWorkflow } from '../../../../../workflows/moderate-reviews'

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { result } = await moderateReviewsWorkflow(req.scope).run({
    input: { ids: [req.params.id], status: 'approved' },
  })

  res.json({ review: result.reviews[0] })
}
