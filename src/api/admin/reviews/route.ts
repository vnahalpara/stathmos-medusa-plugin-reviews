import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../modules/review'
import { ListAdminReviewsSchema } from './middlewares'

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { status, product_id, rating, limit, offset } =
    req.validatedQuery as ListAdminReviewsSchema

  const filters: Record<string, unknown> = {}

  if (status) {
    filters.status = status
  }

  if (product_id) {
    filters.product_id = product_id
  }

  if (rating) {
    filters.rating = rating
  }

  const service = req.scope.resolve(REVIEW_MODULE)

  const [reviews, count] = await service.listAndCountReviews(filters, {
    take: limit ?? 20,
    skip: offset ?? 0,
    order: { created_at: 'DESC' },
  })

  // Unlike the store list route, the admin route intentionally returns the
  // full record - including a guest reviewer's email - rather than an
  // allow-listed subset. Moderating spam requires seeing who sent it; that
  // is correct here, not a leak.
  res.json({ reviews, count, limit: limit ?? 20, offset: offset ?? 0 })
}
