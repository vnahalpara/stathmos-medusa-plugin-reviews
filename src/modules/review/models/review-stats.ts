import { model } from '@medusajs/framework/utils'

/**
 * Denormalized per-product summary. The stats endpoint is called on every
 * product detail page; aggregating the whole review table per request does
 * not survive contact with a real catalogue.
 */
export const ReviewStats = model
  .define('review_stats', {
    id: model.id({ prefix: 'rsta' }).primaryKey(),
    product_id: model.text(),
    count: model.number().default(0),
    // model.number() maps to an integer column, which cannot hold a
    // two-decimal-place average (e.g. 4.5) — it silently rounds on write.
    // model.float() is Medusa's decimal-places property type; use it here
    // instead of the number() shown in the brief so the rounding-to-two-
    // decimal-places requirement actually survives a write.
    average: model.float().default(0),
    breakdown_1: model.number().default(0),
    breakdown_2: model.number().default(0),
    breakdown_3: model.number().default(0),
    breakdown_4: model.number().default(0),
    breakdown_5: model.number().default(0),
    media_count: model.number().default(0),
  })
  .indexes([{ on: ['product_id'], unique: true, where: 'deleted_at IS NULL' }])
