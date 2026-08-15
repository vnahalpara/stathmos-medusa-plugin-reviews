import { model } from '@medusajs/framework/utils'

/**
 * A single "helpful" vote on a review. Cast by a signed-in customer or a
 * pseudonymous guest, never both for the same row - `customer_id` is set
 * for the former and left null for the latter, with `voter_hash`
 * (`sha256(ip + userAgent + salt)`, see `src/settings/voter-hash.ts`)
 * standing in as the guest's dedup key.
 */
export const ReviewVote = model
  .define('review_vote', {
    id: model.id({ prefix: 'rvot' }).primaryKey(),
    review_id: model.text(),
    customer_id: model.text().nullable(),
    voter_hash: model.text(),
  })
  .indexes([
    { on: ['review_id'] },
    // Two partial unique indexes, not one: a signed-in customer is
    // deduped by account, a guest by pseudonymous hash. Partial on
    // deleted_at so the HARD delete used for unvote (spec §4) is not the
    // only thing standing between a re-vote and a constraint violation.
    {
      on: ['review_id', 'customer_id'],
      unique: true,
      where: 'customer_id IS NOT NULL AND deleted_at IS NULL',
    },
    {
      on: ['review_id', 'voter_hash'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ])
