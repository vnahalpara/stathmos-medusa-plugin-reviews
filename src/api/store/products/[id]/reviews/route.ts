import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { MedusaError, Modules } from '@medusajs/framework/utils'
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
  //
  // This filter decides which REVIEWS this route lists. It is no longer
  // what protects their MEDIA: that rule lives in
  // service.listVisibleReviewMedias() and is re-derived there from the
  // reviews table, so removing or loosening this filter cannot leak a
  // non-approved review's media (spec §6 - enforced in the service layer,
  // not per-route).
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

  // Media visibility is the service's rule, not this route's: one query
  // keyed by the whole id set (never N+1), with approved-only and
  // not-hidden both applied inside listVisibleReviewMedias(). Passing ids
  // that are already approved is belt-and-braces, not the guarantee.
  const media = await service.listVisibleReviewMedias(reviews.map((r) => r.id))

  const mediaByReview = new Map<string, typeof media>()

  for (const item of media) {
    const list = mediaByReview.get(item.review_id!) ?? []
    list.push(item)
    mediaByReview.set(item.review_id!, list)
  }

  // Reply visibility is the service's rule, not this route's - same
  // reasoning as media above: listVisibleReviewReplies() re-derives
  // approval from the reviews table itself, so this route cannot leak a
  // reply attached to a pending/rejected review even though `reviews` here
  // is already filtered to approved ones.
  const replies = await service.listVisibleReviewReplies(reviews.map((r) => r.id))
  const replyByReview = new Map(replies.map((r) => [r.review_id, r]))

  // Fetched once per request, not per review: the store's name is the
  // same for every reply in this response.
  // Falls back to a literal rather than null so `author` is always a
  // string. A storefront that renders the field without a null guard
  // would print "null" next to the merchant's reply - and the zero-store
  // case that produces it is essentially unreachable, since Store is a
  // required core module, so the guard would never be exercised in
  // development and would fail in the one situation nobody tested.
  const storeModule = req.scope.resolve(Modules.STORE)
  const [store] = await storeModule.listStores({}, { take: 1 })
  const author = store?.name ?? 'Store'

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
      // Explicit allow-list, not the model row: `replied_by` holds the
      // admin user's id and must never reach a store route (spec decision
      // #3). The public author is always the store's name.
      reply: replyByReview.has(review.id)
        ? {
            content: replyByReview.get(review.id)!.content,
            created_at: replyByReview.get(review.id)!.created_at,
            author,
          }
        : null,
    })),
    count,
    limit: limit ?? 20,
    offset: offset ?? 0,
  })
}
