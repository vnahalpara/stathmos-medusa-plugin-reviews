import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../../../../modules/review'
import { getReviewSettings } from '../../../../../settings/get-review-settings'
import { ListProductReviewsSchema } from '../../../reviews/middlewares'

const ORDER_BY = {
  newest: { created_at: 'DESC' },
  highest: { rating: 'DESC' },
  lowest: { rating: 'ASC' },
  most_helpful: { helpful_count: 'DESC' },
} as const

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const settings = await getReviewSettings(req.scope)

  if (!settings.enabled) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Reviews are disabled')
  }

  const { limit, offset, sort, rating, verified } =
    req.validatedQuery as ListProductReviewsSchema

  const service = req.scope.resolve(REVIEW_MODULE)

  // Approved-only is enforced here, in the query filter that reaches the
  // database - never by fetching every review and filtering in JS. A JS
  // filter would still load pending/rejected content into memory, one
  // refactor away from being serialised into a public response.
  const filters: Record<string, unknown> = {
    product_id: req.params.id,
    status: 'approved',
  }

  if (rating) {
    filters.rating = rating
  }

  if (verified) {
    filters.is_verified_purchase = true
  }

  const [reviews, count] = await service.listAndCountReviews(filters, {
    take: limit ?? 20,
    skip: offset ?? 0,
    order: ORDER_BY[sort ?? 'newest'],
  })

  // Media is fetched only for reviews already filtered to `approved` above,
  // in a single query keyed by the whole id set - not one query per review.
  // That keeps visibility derived from the parent review (there is no
  // status column on review_media to drift out of sync) and keeps this
  // route from issuing an N+1 query against a review list.
  const media = reviews.length
    ? await service.listReviewMedias({
        review_id: reviews.map((r) => r.id),
        hidden_at: null,
      })
    : []

  const mediaByReview = new Map<string, typeof media>()

  for (const item of media) {
    const list = mediaByReview.get(item.review_id!) ?? []
    list.push(item)
    mediaByReview.set(item.review_id!, list)
  }

  res.json({
    // Field-by-field response, not the model: email and customer_id must
    // never reach a store response, and an explicit allow-list cannot leak
    // a column added in a later phase.
    reviews: reviews.map((review) => ({
      id: review.id,
      product_id: review.product_id,
      rating: review.rating,
      title: review.title,
      content: review.content,
      display_name: review.display_name,
      status: review.status,
      is_verified_purchase: review.is_verified_purchase,
      helpful_count: review.helpful_count,
      created_at: review.created_at,
      media: (mediaByReview.get(review.id) ?? [])
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((m) => ({
          id: m.id,
          type: m.type,
          url: m.url,
          thumbnail_url: m.thumbnail_url,
        })),
    })),
    count,
    limit: limit ?? 20,
    offset: offset ?? 0,
  })
}
