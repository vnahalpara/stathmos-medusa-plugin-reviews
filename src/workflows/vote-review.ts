import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { castReviewVoteStep } from './steps/cast-review-vote'
import { withdrawReviewVoteStep } from './steps/withdraw-review-vote'

export type CastReviewVoteInput = {
  review_id: string
  customer_id: string | null
  voter_hash: string | null
}

/**
 * No emitEventStep here, same reasoning as deleteReviewReplyWorkflow: a
 * vote is not a moderation-relevant content event the way a review or
 * reply create/edit is, and nothing in this task's spec names a subscriber
 * for one. Add `review.vote.cast` later if a concrete consumer needs it.
 */
export const castReviewVoteWorkflow = createWorkflow(
  'cast-review-vote',
  function (input: CastReviewVoteInput) {
    return new WorkflowResponse(castReviewVoteStep(input))
  }
)

export type WithdrawReviewVoteInput = {
  review_id: string
  customer_id: string | null
  voter_hash: string | null
}

export const withdrawReviewVoteWorkflow = createWorkflow(
  'withdraw-review-vote',
  function (input: WithdrawReviewVoteInput) {
    return new WorkflowResponse(withdrawReviewVoteStep(input))
  }
)
