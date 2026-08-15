---
'@stathmos/medusa-plugin-reviews': minor
---

Add merchant replies and a bundled admin UI.

One live reply per review, created or updated atomically via
`POST /admin/reviews/:id/reply`, read via `GET /admin/reviews/:id/reply`,
and removed via `DELETE /admin/reviews/:id/reply`. A reply is exposed on
`GET /store/products/:id/reviews` only once its review is approved, and its
public author is always the store's name, never the admin user who wrote
it. Three more admin endpoints: `GET /admin/reviews/stats/:product_id`,
`GET /admin/reviews/:id/media` (includes hidden media, unlike the
store-facing equivalent), and free-text search (`q`) plus a `media_count`
field on `GET /admin/reviews`.

The admin dashboard now bundles a "Reviews" sidebar route: a moderation
queue with tabs, server-side search and pagination; bulk approve/reject
with a reason prompt; a detail drawer with a media lightbox and per-media
delete; a merchant reply composer; a product-detail widget; and a settings
page covering all 14 settings, including two (`allow_edit`,
`gallery_enabled`) that are present but not yet functional.
