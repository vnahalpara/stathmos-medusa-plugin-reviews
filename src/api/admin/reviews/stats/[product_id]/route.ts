import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../../../modules/review'

// No explicit auth middleware here - Medusa core auto-protects every
// /admin/* route, so an unauthenticated request never reaches this handler.
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service = req.scope.resolve(REVIEW_MODULE)
  const [stats] = await service.listReviewStats({ product_id: req.params.product_id })

  // A product nobody has reviewed is not an error; it has an empty summary,
  // mirroring the store-side stats route this is modelled on.
  res.json({
    count: stats?.count ?? 0,
    average: stats?.average ?? 0,
    media_count: stats?.media_count ?? 0,
    breakdown: {
      5: stats?.breakdown_5 ?? 0,
      4: stats?.breakdown_4 ?? 0,
      3: stats?.breakdown_3 ?? 0,
      2: stats?.breakdown_2 ?? 0,
      1: stats?.breakdown_1 ?? 0,
    },
  })
}
