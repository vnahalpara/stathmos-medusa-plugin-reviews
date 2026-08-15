import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../../modules/review'
import { updateReviewWorkflow } from '../../../../workflows/update-review'
import { UpdateReviewSchema } from '../middlewares'

export async function POST(
  req: AuthenticatedMedusaRequest<UpdateReviewSchema>,
  res: MedusaResponse
) {
  const { result } = await updateReviewWorkflow(req.scope).run({
    input: {
      review_id: req.params.id,
      customer_id: req.auth_context?.actor_id ?? null,
      ...req.validatedBody,
    },
  })

  const service = req.scope.resolve(REVIEW_MODULE)

  // Same deliberate exception as POST /store/reviews's response: the owner
  // reviewing their own submission immediately afterwards, whether it is
  // still `approved` or was just sent back to `pending` for re-moderation,
  // is not "a shopper reading someone else's review" - it is the point of
  // this response. Requirement #6 (media survives an edit) means there is
  // nothing new to attach here; this only echoes what already exists.
  const media = await service.listOwnSubmissionMedia(result.id)

  // Field-by-field response, not the model - same reasoning as every other
  // store route in this plugin: email and customer_id must never reach a
  // store response, and an explicit allow-list cannot leak a column added
  // in a later phase.
  res.json({
    review: {
      id: result.id,
      product_id: result.product_id,
      rating: result.rating,
      title: result.title,
      content: result.content,
      display_name: result.display_name,
      status: result.status,
      is_verified_purchase: result.is_verified_purchase,
      helpful_count: result.helpful_count,
      edited_at: result.edited_at,
      created_at: result.created_at,
      media: media
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((m) => ({
          id: m.id,
          type: m.type,
          url: m.url,
          thumbnail_url: m.thumbnail_url,
        })),
    },
  })
}
