import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { curateReviewMediaWorkflow } from '../../../../../../workflows/curate-review-media'
import { CurateMediaSchema } from '../../../middlewares'

// No explicit auth middleware here - Medusa core auto-protects every
// /admin/* route (same reasoning documented on every other admin/reviews
// route in this plugin, e.g. src/api/admin/reviews/[id]/reply/route.ts).
//
// Path sits directly under the pre-existing `DELETE /admin/reviews/media/:id`
// (src/api/admin/reviews/media/[id]/route.ts) with one more static segment
// after the id - see admin-media-curation.spec.ts's own route-collision
// test (the same class of check Phase 3 needed for
// GET /admin/reviews/:id/media alongside that same DELETE) for proof this
// resolves independently rather than merely assumed to.
export async function POST(
  req: AuthenticatedMedusaRequest<CurateMediaSchema>,
  res: MedusaResponse
) {
  const { result } = await curateReviewMediaWorkflow(req.scope).run({
    input: {
      id: req.params.id,
      ...req.validatedBody,
    },
  })

  // Allow-listed fields, not the row - matches this plugin's convention for
  // every response that touches review_media directly.
  res.json({
    media: {
      id: result.id,
      pinned_at: result.pinned_at,
      hidden_at: result.hidden_at,
    },
  })
}
