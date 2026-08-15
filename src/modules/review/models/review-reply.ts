import { model } from '@medusajs/framework/utils'

/**
 * The merchant's response to a review. One per review in v1.
 *
 * `replied_by` holds the admin user's id for audit only. It is NEVER
 * exposed on a store route - spec decision #3 is that the public author
 * is the store's name, not the staff member's, both because merchants
 * want brand voice and because publishing staff identities on a
 * storefront is a privacy leak nobody asked for. Any store-facing
 * serialiser must allow-list fields rather than spread this row.
 */
export const ReviewReply = model
  .define('review_reply', {
    id: model.id({ prefix: 'rrep' }).primaryKey(),
    review_id: model.text(),
    content: model.text(),
    replied_by: model.text().nullable(),
  })
  .indexes([
    // One reply per review. Partial so a soft-deleted reply does not
    // block writing a new one - same shape as review's
    // one-review-per-customer index.
    {
      on: ['review_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ])
