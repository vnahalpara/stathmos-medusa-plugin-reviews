import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../../../modules/review'
import { GALLERY_DEFAULT_LIMIT, GalleryFilters } from '../../../../modules/review/service'
import { getReviewSettings } from '../../../../settings/get-review-settings'
import { GalleryQuerySchema } from '../middlewares'

/**
 * The response never has a per-shopper component - it is the same page of
 * the same public gallery for every caller for a given product_id/type/
 * limit/offset, unlike GET /store/products/:id/reviews which this plugin
 * does not cache (that response can start including a caller's own
 * pending review in a future phase). `max-age=0` keeps a shopper's own
 * browser revalidating on every visit rather than pinning a stale copy
 * locally for minutes; `s-maxage=60` is what actually absorbs load, on a
 * shared cache/CDN in front of this - the highest-volume public read in
 * the plugin (task brief) - for up to a minute, which is short enough
 * that an admin hiding a reported photo (Task 5) or a newly approved
 * review's media both surface within that same minute, and long enough to
 * take real read pressure off the database. `stale-while-revalidate=300`
 * lets a shared cache keep serving its last copy instantly for another 5
 * minutes while it revalidates in the background, so a slow origin
 * request never becomes a slow gallery load - worst-case staleness after
 * that window is still bounded by the next request re-triggering
 * revalidation, not unbounded.
 */
const GALLERY_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const settings = await getReviewSettings(req.scope)

  // The master `enabled` switch is checked first, same rule/status/message
  // as every other store route (GET /store/products/:id/reviews,
  // POST/DELETE /store/reviews/:id/vote): a merchant who switches reviews
  // off store-wide must not keep serving every approved review's photos
  // and videos from the one store route with no product or review scope
  // at all. `gallery_enabled` is then checked as its own, narrower switch
  // - it can take the gallery down without disabling reviews entirely, but
  // it cannot keep the gallery up once `enabled` is off.
  if (!settings.enabled || !settings.gallery_enabled) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Gallery is disabled')
  }

  const { product_id, type, limit, offset } = req.validatedQuery as GalleryQuerySchema

  const filters: GalleryFilters = {
    ...(product_id ? { product_id } : {}),
    // `type=all` and an omitted `type` are the same request - both leave
    // the filter out entirely so buildGalleryQuery() (service.ts) never
    // adds a `type` predicate.
    ...(type && type !== 'all' ? { type } : {}),
  }

  const service = req.scope.resolve(REVIEW_MODULE)

  // Approval, `hidden_at`, and every filter below run inside the
  // database, in one joined query each - never a JS filter over an
  // unbounded fetch. Both calls share the exact same WHERE clause (see
  // buildGalleryQuery() in service.ts), which is what keeps `count` from
  // ever disagreeing with the rows `media` actually returns.
  const media = await service.listGalleryMedia({ ...filters, limit, offset })
  const count = await service.countGalleryMedia(filters)

  res.set('Cache-Control', GALLERY_CACHE_CONTROL)

  // Field-by-field response, not the model row: this is a JOIN across
  // review_media and review, and an explicit allow-list is what keeps a
  // column added to either table in a later phase - `email`,
  // `customer_id`, `replied_by` chief among them - from ever reaching a
  // public, unauthenticated response by accident.
  res.json({
    media: media.map((item) => ({
      id: item.id,
      review_id: item.review_id,
      type: item.type,
      url: item.url,
      thumbnail_url: item.thumbnail_url,
      pinned_at: item.pinned_at,
      created_at: item.created_at,
      rating: item.rating,
      display_name: item.display_name,
      product_id: item.product_id,
    })),
    count,
    limit: limit ?? GALLERY_DEFAULT_LIMIT,
    offset: offset ?? 0,
  })
}
