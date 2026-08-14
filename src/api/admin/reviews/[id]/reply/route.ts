import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../../../modules/review'
import { replyToReviewWorkflow } from '../../../../../workflows/reply-to-review'
import { deleteReviewReplyWorkflow } from '../../../../../workflows/delete-review-reply'
import { ReplyToReviewInput } from '../../middlewares'

// No explicit auth middleware here either, same reasoning as POST/DELETE
// below. No query params, so no Zod schema and no middlewares.ts entry.
//
// Backs the admin reply composer (Task 10): the composer needs to know,
// on open, whether a review already has a reply and what it says - there
// was previously no way to answer that short of the composer starting
// blank every time and warning that saving might silently overwrite an
// existing reply. That warning is now gone from the UI because this
// route makes it false.
//
// Returns `{ reply: null }` with a 200, not a 404, when the review has no
// reply - "no reply yet" is a normal answer for a review that has never
// been replied to, not an error condition. A 404 here would force the
// composer to treat an ordinary empty state as a failure and would risk
// toasting an error at a merchant for the unremarkable act of opening the
// drawer on a review nobody has replied to yet.
//
// Allow-listed fields, not the row: `replied_by` holds the admin user's
// id and must NOT appear here. Spec decision #3 keeps staff identity out
// of every reply-facing surface, admin included - the composer already
// shows the store's name as the author (see reply-composer.tsx), and
// there is no legitimate reason for this screen to need who on staff
// wrote it. Do not add it back "for completeness" - see
// store/products/[id]/reviews/route.ts's identical warning on the same
// field.
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service = req.scope.resolve(REVIEW_MODULE)

  const [reply] = await service.listReviewReplies(
    { review_id: req.params.id },
    { take: 1 }
  )

  res.json({
    reply: reply
      ? {
          id: reply.id,
          review_id: reply.review_id,
          content: reply.content,
          created_at: reply.created_at,
          updated_at: reply.updated_at,
        }
      : null,
  })
}

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

// No explicit auth middleware here either, same reasoning as POST above.
// No body, so no Zod schema and no middlewares.ts entry - see
// src/api/admin/reviews/media/[id]/route.ts for the existing DELETE
// precedent this follows, including its response shape.
export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { result } = await deleteReviewReplyWorkflow(req.scope).run({
    input: { review_id: req.params.id },
  })

  res.json({ id: result.id, object: 'review_reply', deleted: true })
}
