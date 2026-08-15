import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../modules/review'
import { ListAdminReviewsSchema } from './middlewares'

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { status, product_id, rating, q, limit, offset } =
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

  // `q` is a magic key: MedusaService's generated listAndCountReviews()
  // recognises `filters.q` itself and turns it into a case-insensitive
  // ILIKE-OR across every column marked `.searchable()` on the Review
  // model (display_name, email, title, content), applied as a real WHERE
  // clause before `take`/`skip` - not a post-fetch JS filter. That means
  // `count` below reflects the filtered total and a match past the first
  // page is still found. See the model comment for why no migration is
  // needed for this.
  if (q) {
    filters.q = q
  }

  const service = req.scope.resolve(REVIEW_MODULE)

  const [reviews, count] = await service.listAndCountReviews(filters, {
    take: limit ?? 20,
    skip: offset ?? 0,
    order: { created_at: 'DESC' },
  })

  // One grouped query for the whole page, not a count per row - see
  // countMediaByReview()'s own doc for why this must NOT reuse
  // countVisibleReviewMedias(): that enforces the store-facing "approved +
  // not hidden" rule, while a moderator needs the true attached count,
  // including media that has already been hidden.
  const mediaCounts = await service.countMediaByReview(reviews.map((review) => review.id))

  const reviewsWithMediaCount = reviews.map((review) => ({
    ...review,
    media_count: mediaCounts[review.id] ?? 0,
  }))

  // Unlike the store list route, the admin route intentionally returns the
  // full record - including a guest reviewer's email - rather than an
  // allow-listed subset. Moderating spam requires seeing who sent it; that
  // is correct here, not a leak.
  res.json({ reviews: reviewsWithMediaCount, count, limit: limit ?? 20, offset: offset ?? 0 })
}
