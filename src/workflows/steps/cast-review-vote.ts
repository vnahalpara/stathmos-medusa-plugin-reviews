import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = {
  review_id: string
  customer_id: string | null
  voter_hash: string | null
}

/**
 * Casts one "helpful" vote: insert the row, then bump `helpful_count` - two
 * separate atomic statements (service.castVote() then
 * service.adjustHelpfulCount()), not one combined statement, mirroring how
 * attachReviewMediaStep composes claimMediaForReview() with a follow-up
 * write. Each individual statement is atomic on its own; nothing here needs
 * them to be atomic *together*, since a failure between the two leaves
 * nothing for a concurrent request to race against (the vote row already
 * exists and already blocks a second vote from the same identity, whether
 * or not the counter increment that follows it has run yet).
 *
 * Both checks below run before any row is written, so a refusal here never
 * leaves anything to compensate:
 *
 *   1. the review must exist - re-derived from the reviews table, not
 *      trusted from the route, so a garbage or deleted id 404s instead of
 *      inserting a vote that points at nothing;
 *   2. the review must be `approved` - an unmoderated review must not
 *      accumulate social proof. If it is later rejected, the votes were
 *      spent on content nobody but the reviewer and staff ever saw. This
 *      is a spec rule Task 1 does not and cannot enforce at the database
 *      level (review_vote has no FK into review's status column), so it
 *      belongs here.
 */
export const castReviewVoteStep = createStep(
  'cast-review-vote',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)

    const [review] = await service.listReviews({ id: input.review_id }, { take: 1 })

    if (!review) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Review not found')
    }

    if (review.status !== 'approved') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Cannot vote on a review that has not been approved'
      )
    }

    // A unique-constraint violation (a second vote from this identity)
    // surfaces from service.castVote() as MedusaError.Types.CONFLICT, not a
    // raw driver error - see that method's docstring in
    // src/modules/review/service.ts. It propagates untouched from here.
    const vote = await service.castVote({
      review_id: input.review_id,
      customer_id: input.customer_id,
      voter_hash: input.voter_hash,
    })

    const helpfulCount = await service.adjustHelpfulCount(input.review_id, 1)

    return new StepResponse(
      { vote, helpful_count: helpfulCount },
      { vote_id: vote.id, review_id: input.review_id }
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)

    // Hard delete, not soft: a vote that never went live for anyone to
    // rely on (this workflow run failed before completing) should not
    // leave a permanently orphaned row sitting under Task 1's partial
    // unique indexes for no benefit - same reasoning as
    // upsertReviewReplyStep's identical compensation for a fresh create.
    await service.deleteReviewVotes(compensation.vote_id)
    await service.adjustHelpfulCount(compensation.review_id, -1)
  }
)
