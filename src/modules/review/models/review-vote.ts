import { model } from '@medusajs/framework/utils'

/**
 * A single "helpful" vote on a review. Cast by a signed-in customer or a
 * pseudonymous guest, never both for the same row - `customer_id` is set
 * for the former and left null for the latter, with `voter_hash`
 * (`sha256(ip + userAgent + salt)`, see `src/settings/voter-hash.ts`)
 * standing in as the guest's dedup key and left null on a customer row.
 *
 * `voter_hash` is nullable deliberately, not just permissively: a naive
 * design that stores a hash on every row (customer votes included) makes
 * `(review_id, voter_hash)` collide for two different customers who share
 * an IP and user agent - an ordinary office, household or VPN, not an
 * edge case. Leaving it null for customer rows means the two dedup rules
 * below are disjoint by construction (a NULL never satisfies either
 * partial index's `IS NOT NULL` predicate), rather than merely expected
 * not to interfere. It is also the GDPR-conscious choice per spec §9:
 * there is no reason to derive and store pseudonymous personal data for a
 * voter we can already identify by account.
 */
export const ReviewVote = model
  .define('review_vote', {
    id: model.id({ prefix: 'rvot' }).primaryKey(),
    review_id: model.text(),
    customer_id: model.text().nullable(),
    voter_hash: model.text().nullable(),
  })
  .indexes([
    { on: ['review_id'] },
    // Two partial unique indexes, not one: a signed-in customer is
    // deduped by account, a guest by pseudonymous hash. Partial on
    // deleted_at so the HARD delete used for unvote (spec §4) is not the
    // only thing standing between a re-vote and a constraint violation.
    // Also partial on each own column's IS NOT NULL - see the model
    // comment above for why that is what keeps the two rules disjoint.
    {
      on: ['review_id', 'customer_id'],
      unique: true,
      where: 'customer_id IS NOT NULL AND deleted_at IS NULL',
    },
    {
      on: ['review_id', 'voter_hash'],
      unique: true,
      where: 'voter_hash IS NOT NULL AND deleted_at IS NULL',
    },
  ])
