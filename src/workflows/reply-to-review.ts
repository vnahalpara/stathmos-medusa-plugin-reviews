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
    //
    // Both carry `product_id` as well as `review_id`. A reply is rendered
    // inside its review on the product page, so publishing or changing one
    // changes what that page shows - and a subscriber invalidating a cache
    // can only act on a product. Without it, every host would have to read
    // the review back just to learn which page went stale, which is the
    // same tax the moderation events used to charge before they carried
    // `product_ids`. `review_id` stays for subscribers that want the reply
    // itself.
    emitEventStep(
      transform({ input, result }, (data) => ({
        eventName: data.result.created ? 'review.reply.created' : 'review.reply.updated',
        data: { review_id: data.input.review_id, product_id: data.result.product_id },
      }))
    )

    return new WorkflowResponse(result)
  }
)
