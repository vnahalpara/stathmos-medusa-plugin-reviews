import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'
import { getReviewSettings } from '../../settings/get-review-settings'

type Input = {
  review_id: string
  customer_id: string | null
  voter_hash: string | null
}

/**
 * Withdraws the caller's own vote: hard-delete the row, then reverse
 * `helpful_count` - the mirror image of castReviewVoteStep, same two
 * separate atomic statements (service.withdrawVote() then
 * service.adjustHelpfulCount() with delta -1).
 *
 * Gated on `settings.enabled` first, same rule/status/message as
 * castReviewVoteStep and the store read/submit routes - a merchant who
 * switches reviews off should not be able to un-see a vote disappear on
 * the one endpoint that kept working. This runs before
 * service.withdrawVote() ever touches a row, so a vote cast while the
 * feature was enabled is left exactly as it was, not silently removed as
 * a side effect of the feature being off.
 *
 * No existence/approval check on the review itself beyond that, unlike
 * castReviewVoteStep - deliberately. There is no case where a vote exists
 * on a review that does not exist or was never approved (castVote already
 * refuses both), so service.withdrawVote()'s own "no matching row" ->
 * MedusaError.Types.NOT_FOUND already covers every way this can fail
 * without a redundant read.
 */
export const withdrawReviewVoteStep = createStep(
  'withdraw-review-vote',
  async (input: Input, { container }) => {
    const settings = await getReviewSettings(container)

    if (!settings.enabled) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Reviews are disabled')
    }

    const service = container.resolve(REVIEW_MODULE)

    // No vote found for this identity/review surfaces as
    // MedusaError.Types.NOT_FOUND from here - see withdrawVote()'s
    // docstring in src/modules/review/service.ts. Propagates untouched.
    const deleted = await service.withdrawVote({
      review_id: input.review_id,
      customer_id: input.customer_id,
      voter_hash: input.voter_hash,
    })

    const helpfulCount = await service.adjustHelpfulCount(input.review_id, -1)

    return new StepResponse(
      { id: deleted.id, helpful_count: helpfulCount },
      {
        review_id: deleted.review_id,
        customer_id: deleted.customer_id,
        voter_hash: deleted.voter_hash,
      }
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)

    // Recreates the vote a downstream failure should not have let vanish -
    // the shopper asked for their vote to be removed, not for it to
    // disappear as a side effect of something unrelated failing later in
    // this workflow. Not a perfect restore (a fresh id and timestamps, the
    // same caveat delete-review-reply.ts documents for its own recreate),
    // accepted for the same reason: withdrawReviewVoteWorkflow has only
    // this one step today, so nothing downstream can trigger it in
    // production.
    await service.createReviewVotes(compensation)
    await service.adjustHelpfulCount(compensation.review_id, 1)
  }
)
