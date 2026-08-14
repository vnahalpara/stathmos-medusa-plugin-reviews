import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { replyToReviewWorkflow } from '../../../../../workflows/reply-to-review'
import { ReplyToReviewInput } from '../../middlewares'

// No explicit auth middleware here - Medusa core auto-protects every
// /admin/* route, so an unauthenticated request never reaches this handler.
export async function POST(
  req: AuthenticatedMedusaRequest<ReplyToReviewInput>,
  res: MedusaResponse
) {
  const { result } = await replyToReviewWorkflow(req.scope).run({
    input: {
      review_id: req.params.id,
      content: req.validatedBody.content,
      replied_by: req.auth_context?.actor_id,
    },
  })

  res.json({
    reply: {
      id: result.reply.id,
      review_id: result.reply.review_id,
      content: result.reply.content,
      created_at: result.reply.created_at,
      updated_at: result.reply.updated_at,
    },
  })
}
