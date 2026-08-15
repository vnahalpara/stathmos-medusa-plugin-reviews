import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../../../modules/review'
import ReviewModuleService from '../../../../../modules/review/service'
import { voterHash } from '../../../../../settings/voter-hash'
import { castReviewVoteWorkflow, withdrawReviewVoteWorkflow } from '../../../../../workflows/vote-review'

/**
 * Resolves who is voting into exactly the shape Task 1's two partial
 * unique indexes expect: a signed-in customer sets `customer_id` and
 * leaves `voter_hash` null, a guest sets `voter_hash` and leaves
 * `customer_id` null - never both (see review-vote.ts's model docstring
 * for why that split is load-bearing, not cosmetic).
 *
 * `req.auth_context?.actor_id` is only ever populated because both routes
 * below run `authenticate('customer', ['session', 'bearer'], {
 * allowUnauthenticated: true })` ahead of the handler - the same pattern
 * POST /store/reviews already uses to let a guest through while still
 * attributing a signed-in customer. A guest never reaches voterHash() with
 * a computed identity at all if a customer id is present, which is what
 * keeps this method from ever deriving a hash for someone Task 1's review
 * proved must be deduped by account instead.
 *
 * voterHash() itself throws a MedusaError (mapped to a 500, not a silent
 * fallback) if `service.getVoteSalt()` returns undefined - see that
 * function's docstring and resolveVoteSalt()'s in
 * src/settings/vote-salt.ts. This function does not duplicate that guard;
 * it only ever reaches voterHash() for a guest, so a store that only
 * expects authenticated voters and never configures a salt is unaffected.
 */
async function resolveVoterIdentity(
  req: AuthenticatedMedusaRequest,
  service: ReviewModuleService
): Promise<{ customer_id: string | null; voter_hash: string | null }> {
  const customerId = req.auth_context?.actor_id

  if (customerId) {
    return { customer_id: customerId, voter_hash: null }
  }

  const salt = await service.getVoteSalt()
  const hash = voterHash(req.ip ?? '', req.headers['user-agent'] ?? '', salt ?? '')

  return { customer_id: null, voter_hash: hash }
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service = req.scope.resolve(REVIEW_MODULE)
  const identity = await resolveVoterIdentity(req, service)

  const { result } = await castReviewVoteWorkflow(req.scope).run({
    input: { review_id: req.params.id, ...identity },
  })

  res.status(201).json({
    vote: { id: result.vote.id, review_id: result.vote.review_id },
    helpful_count: result.helpful_count,
  })
}

export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service = req.scope.resolve(REVIEW_MODULE)
  const identity = await resolveVoterIdentity(req, service)

  const { result } = await withdrawReviewVoteWorkflow(req.scope).run({
    input: { review_id: req.params.id, ...identity },
  })

  res.json({ id: result.id, object: 'review_vote', deleted: true, helpful_count: result.helpful_count })
}
