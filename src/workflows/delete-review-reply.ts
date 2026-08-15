import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { deleteReviewReplyStep } from './steps/delete-review-reply'

/**
 * No emitEventStep here. Every other mutation in this plugin's replies
 * surface (create, update) restores or edits a row that could be inspected
 * afterwards, and deletion of moderation content elsewhere in this plugin
 * (`deleteReviewMediaWorkflow`) sets the same precedent: removing a row is
 * not an event-worthy state transition here, only its creation/edit is.
 * Nothing in this task's spec names a subscriber for a delete event, and
 * Task 4 (exposing replies publicly) only needs the reply's current
 * presence/absence via a GET, not a delta notification. Add
 * `review.reply.deleted` later if a concrete consumer needs it - see the
 * report for the full reasoning.
 */
export const deleteReviewReplyWorkflow = createWorkflow(
  'delete-review-reply',
  function (input: { review_id: string }) {
    return new WorkflowResponse(deleteReviewReplyStep(input))
  }
)
