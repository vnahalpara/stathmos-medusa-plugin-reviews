import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../../../modules/review'

/**
 * Lists every non-deleted media item attached to one review, for the
 * detail drawer's media strip/lightbox (Task 9's own gap - see that
 * task's report). Deliberately returns media the review's own reviewer
 * (or an earlier moderator) has already hidden (`hidden_at` set) -
 * the same rule as countMediaByReview() in
 * src/modules/review/service.ts (Task 7), and NOT the store-facing
 * listVisibleReviewMedias() rule (approved review + not hidden). A
 * moderator needs to see - and be able to delete - media that is already
 * hidden; excluding it here would make already-hidden media unreachable
 * and undeletable through the admin UI. Keep this consistent with
 * countMediaByReview() if either changes: the two are meant to answer the
 * same "what's actually attached" question for the same audience, one as
 * a count and one as a list.
 *
 * No Zod schema/middleware entry: a GET with no query parameters, same as
 * this route family's other single-review GETs (approve/reject take none
 * either).
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service = req.scope.resolve(REVIEW_MODULE)

  // The generated list method already excludes soft-deleted rows by
  // default (no `withDeleted`) - it does NOT filter on `hidden_at`, which
  // is exactly what keeps hidden media in this response. See the
  // docstring above for why that's correct here and not in the store
  // route.
  const media = await service.listReviewMedias(
    { review_id: req.params.id },
    { order: { sort_order: 'ASC' } }
  )

  // Allow-listed fields, not a spread - matches this module's existing
  // convention for every response that touches review_media (see the
  // store route's own comment) so a column added later can't leak here by
  // accident.
  res.json({
    media: media.map((item) => ({
      id: item.id,
      type: item.type,
      url: item.url,
      thumbnail_url: item.thumbnail_url,
      mime_type: item.mime_type,
      sort_order: item.sort_order,
      hidden_at: item.hidden_at,
    })),
  })
}
