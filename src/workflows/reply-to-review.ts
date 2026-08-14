import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { upsertReviewReplyStep } from './steps/upsert-review-reply'

export type ReplyToReviewInput = {
  review_id: string
  content: string
  replied_by?: string
}

export const replyToReviewWorkflow = createWorkflow(
  'reply-to-review',
  function (input: ReplyToReviewInput) {
    const result = upsertReviewReplyStep(input)

    // Two distinct events, deliberately not collapsed into one. A first
    // reply and an edit to an already-published one are materially
    // different for any subscriber - a "you got a reply" notification email
    // must fire once, not again every time a merchant fixes a typo.
    emitEventStep(
      transform({ input, result }, (data) => ({
        eventName: data.result.created ? 'review.reply.created' : 'review.reply.updated',
        data: { review_id: data.input.review_id },
      }))
    )

    return new WorkflowResponse(result)
  }
)
