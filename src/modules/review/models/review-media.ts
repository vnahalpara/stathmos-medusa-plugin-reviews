import { model } from '@medusajs/framework/utils'

/**
 * A reference to a file in Medusa's File Module — this plugin never stores
 * bytes itself.
 *
 * `review_id` is nullable because media is uploaded before the review that
 * will own it exists. Rows that are never attached are deleted by the
 * orphan sweep job, otherwise every abandoned review form would leak a
 * stored file forever.
 *
 * There is deliberately NO status column: visibility is derived from the
 * parent review, so approval logic lives in exactly one place and cannot
 * drift.
 */
export const ReviewMedia = model
  .define('review_media', {
    id: model.id({ prefix: 'rmed' }).primaryKey(),
    review_id: model.text().nullable(),
    type: model.enum(['image', 'video']),
    file_id: model.text(),
    url: model.text(),
    thumbnail_url: model.text().nullable(),
    mime_type: model.text(),
    size_bytes: model.number(),
    sort_order: model.number().default(0),
    // Gallery curation columns ship now; the admin UI for them is Phase 4.
    // Adding columns later is a migration; declaring them now is free.
    pinned_at: model.dateTime().nullable(),
    hidden_at: model.dateTime().nullable(),
  })
  .indexes([{ on: ['review_id'] }, { on: ['file_id'] }])
