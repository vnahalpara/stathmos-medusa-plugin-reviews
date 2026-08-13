import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../../../../../modules/review'
import { getReviewSettings } from '../../../../../../settings/get-review-settings'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const settings = await getReviewSettings(req.scope)

  if (!settings.enabled) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Reviews are disabled')
  }

  const service = req.scope.resolve(REVIEW_MODULE)
  const [stats] = await service.listReviewStats({ product_id: req.params.id })

  // A product nobody has reviewed is not an error; it has an empty summary.
  // Storefronts render this directly, so a 404 or a crash here would break
  // every unreviewed product detail page.
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
