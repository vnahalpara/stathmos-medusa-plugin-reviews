import { model } from '@medusajs/framework/utils'

export const Review = model
  .define('review', {
    id: model.id({ prefix: 'rev' }).primaryKey(),
    product_id: model.text(),
    customer_id: model.text().nullable(),
    order_id: model.text().nullable(),
    // `.searchable()` is metadata read by MikroORM's generated free-text
    // filter (@medusajs/utils's mikroOrmFreeTextSearchFilterOptionsFactory)
    // - it adds no column and needs no migration. It is what lets
    // `listAndCountReviews({ q: '...' }, ...)` build a case-insensitive
    // `ILIKE` OR across exactly these four columns. See GET /admin/reviews
    // in src/api/admin/reviews/route.ts, the only caller that passes `q`.
    display_name: model.text().searchable(),
    email: model.text().searchable().nullable(),
    rating: model.number(),
    title: model.text().searchable().nullable(),
    content: model.text().searchable(),
    status: model
      .enum(['pending', 'approved', 'rejected'])
      .default('pending'),
    rejection_reason: model.text().nullable(),
    is_verified_purchase: model.boolean().default(false),
    helpful_count: model.number().default(0),
    edited_at: model.dateTime().nullable(),
  })
  .indexes([
    { on: ['product_id'] },
    { on: ['status'] },
    // One review per customer per product. Partial so guests (null
    // customer_id) are exempt and soft-deleted rows do not block a resubmit.
    {
      on: ['product_id', 'customer_id'],
      unique: true,
      where: 'customer_id IS NOT NULL AND deleted_at IS NULL',
    },
  ])
