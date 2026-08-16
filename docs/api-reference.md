# API reference

Every route this plugin ships, checked directly against source
(`src/api/**/route.ts` and each route family's `middlewares.ts`) rather
than transcribed from the design spec — the spec is a sketch in places and
disagrees with the shipped code at least once (its gallery example shows a
nested response shape; the code responds flat, as documented below). If
this document and the source ever disagree, trust the source; file an
issue against this document.

All request/response bodies are JSON unless noted. All `/admin/*` routes
require an authenticated admin session — Medusa core protects every
`/admin/*` route automatically, so none of these declare their own auth
middleware.

**Error shape.** Every thrown error is a `MedusaError`, which the
framework maps to an HTTP status by `type`:

| `MedusaError.Types` | HTTP status | Response body's `type` field |
|---|---|---|
| `NOT_FOUND` | 404 | `not_found` |
| `INVALID_DATA` | 400 | `invalid_data` |
| `NOT_ALLOWED` | 400 | `not_allowed` |
| `UNAUTHORIZED` | 401 | `unauthorized` |
| `FORBIDDEN` | 403 | `forbidden` |
| `CONFLICT` | 409 | `conflict` |

`NOT_ALLOWED` and `INVALID_DATA` are both HTTP 400 — a caller that needs
to distinguish "the store's settings forbid this" from "your input is
malformed" has to read the JSON body's `type` field, not the status code.

---

## Store routes

### `POST /store/reviews`

Submit a review. Works for guests and signed-in customers — a
`session`/`bearer` token is optional (`authenticate('customer', [...], { allowUnauthenticated: true })`);
when present, the review is attributed to that customer for
verified-purchase checks and the one-review-per-customer rule.

**Body** (`CreateReviewSchema`, `.strict()` — unknown fields are rejected):

| Field | Type | Required | Notes |
|---|---|---|---|
| `product_id` | `string` | yes | |
| `rating` | `integer` | yes | 1–5 |
| `content` | `string` | yes | 1–20000 chars, but see `min_content_length`/`max_content_length` settings — these are enforced separately and can be tighter |
| `title` | `string` | no | ≤200 chars |
| `display_name` | `string` | no | ≤100 chars |
| `email` | `string` | no | must be a valid email; guest-only in practice |
| `media_ids` | `string[]` | no | ≤20 ids, from `POST /store/reviews/uploads` |

**Response `201`:**

```json
{
  "review": {
    "id": "rev_...",
    "product_id": "prod_...",
    "rating": 5,
    "title": "Great fit",
    "content": "...",
    "display_name": "Anonymous",
    "status": "pending",
    "is_verified_purchase": false,
    "helpful_count": 0,
    "created_at": "2026-08-16T...",
    "media": [ { "id": "rmed_...", "type": "image", "url": "...", "thumbnail_url": null } ]
  }
}
```

`status` is `"pending"` or `"approved"` depending on the store's
`require_approval` setting — the storefront should read this field rather
than assume either outcome. The response is field-by-field allow-listed,
never the raw row: **`email` and `customer_id` are never present**, even
though the review may be attributed to a customer internally.

**Failure modes** (all documented, none thrown raw):

| Condition | Status | `type` | Message |
|---|---|---|---|
| Reviews disabled (`enabled: false`) | 404 | `not_found` | `Reviews are disabled` |
| No session and `allow_guest: false` | 401 | `unauthorized` | `You must be signed in to leave a review` |
| `verified_only: true` and not verified | 400 | `not_allowed` | `Only customers who purchased this product can review it` |
| Content too short | 400 | `invalid_data` | `Review must be at least N characters` |
| Content too long | 400 | `invalid_data` | `Review must be at most N characters` |
| `one_review_per_customer: true` and already reviewed | 400 | `not_allowed` | `You have already reviewed this product` |
| `media_ids` unknown or already attached | 404 | `not_found` | `Unknown or unavailable media` (deliberately the same message/status for both cases — see below) |
| Attaching media would exceed `max_media_per_review` | 400 | `invalid_data` | `A review may have at most N media item(s)` |
| `allow_media: false` and `media_ids` given | 400 | `not_allowed` | `Media uploads are disabled` |
| `allow_video: false` and a `media_ids` item is a video | 400 | `not_allowed` | `Video uploads are disabled` |

The "unknown or unavailable media" message is intentionally identical for
"that id doesn't exist" and "that id is already attached to another
review" — closing an existence oracle over the id space. Media ids are
80-bit ULIDs, so this isn't exploitable in practice, but the plugin closes
it anyway since it costs nothing.

---

### `GET /store/products/:id/reviews`

List a product's **approved** reviews, with their media and merchant reply.
404s when `enabled` is off; otherwise always 200, including for a product
with zero reviews (`count: 0`).

**Query** (`ListProductReviewsSchema`, `.strict()`):

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer | 20 | 1–100 |
| `offset` | integer | 0 | ≥0 |
| `sort` | `newest` \| `highest` \| `lowest` \| `most_helpful` | `newest` | |
| `rating` | integer | — | 1–5, exact match |
| `verified` | boolean (`"true"`) | — | filters to `is_verified_purchase: true` |

**Response `200`:**

```json
{
  "reviews": [
    {
      "id": "rev_...",
      "product_id": "prod_...",
      "rating": 4,
      "title": "...",
      "content": "...",
      "display_name": "...",
      "status": "approved",
      "is_verified_purchase": true,
      "helpful_count": 3,
      "created_at": "...",
      "edited_at": null,
      "media": [ { "id": "rmed_...", "type": "image", "url": "...", "thumbnail_url": null } ],
      "reply": { "content": "...", "created_at": "...", "author": "Your Store Name" }
    }
  ],
  "count": 16,
  "limit": 20,
  "offset": 0
}
```

`reply` is `null` when nobody has replied. `author` is always the store's
name (resolved once per request from the Store module), **never** the
admin user's id — `replied_by` on the underlying row is never exposed
anywhere. `edited_at` is `null` until the first edit, non-null afterward.

**Never present:** `email`, `customer_id`, `replied_by` — field-by-field
allow-listed, not the raw model row, specifically so a column added to
the schema in a future phase can't leak here by accident. Media and
replies are re-derived from the reviews table on every read (visibility is
the service layer's rule, not this route's filter), so a status filter
change on this route cannot leak a pending/rejected review's media or
reply either.

**Failure:** `enabled: false` → 404, `not_found`, `Reviews are disabled`.

---

### `GET /store/products/:id/reviews/stats`

Denormalized rating summary for one product. Never 404s for "no
reviews" — that's a normal, zeroed response, not an error.

**Response `200`:**

```json
{
  "count": 16,
  "average": 3.38,
  "media_count": 4,
  "breakdown": { "5": 4, "4": 5, "3": 2, "2": 3, "1": 2 }
}
```

`media_count` counts only visible (approved, non-hidden) media, matching
the `media` array shoppers actually see — not the true attached count an
admin would see.

**Failure:** `enabled: false` → 404, `not_found`, `Reviews are disabled`.

---

### `POST /store/reviews/uploads`

Upload review photos/videos ahead of submission (multipart, field name
`files`). Returns media ids to pass as `media_ids` on `POST /store/reviews`.
No customer authentication required — only a valid publishable API key
(same as review submission when guests are allowed). **Not rate-limited in
this phase** — treat it as an effectively unauthenticated write to object
storage, bounded only by the format/size/count checks below, until
per-endpoint rate limiting ships.

**Body:** `multipart/form-data`, one or more files under the `files`
field. No other form fields are accepted.

**Response `201`:**

```json
{
  "media": [
    { "id": "rmed_...", "type": "image", "url": "...", "thumbnail_url": null, "mime_type": "image/jpeg" }
  ]
}
```

**Hard ceilings** (transport layer, before this plugin's own checks run):
100MB per file, 20 files per request, 250MB aggregate request body, no
non-file form fields. **Format-level checks** (this plugin's own,
content-sniffed from bytes, never from filename or client `Content-Type`):
JPEG/PNG/WebP/AVIF/MP4/WebM accepted; HEIC and MOV (iPhone defaults)
rejected. Merchant-configurable, live-reloadable ceilings:
`max_media_per_review`, `max_image_size_mb`, `max_video_size_mb` — see
[settings.md](./settings.md). Full detail, including the exact
`Content-Type` served back per format and the WebM/Matroska sniffing
caveat, is in the main [README](../README.md#photo-and-video-uploads).

**Failure modes** include a `400` `invalid_data` for a tripped
transport-layer limit (converted from a bare `multer.MulterError` into an
actionable message naming the limit), and `400` `not_allowed`/`invalid_data`
for format/setting rejections at attachment time (see `POST /store/reviews`
above — the same checks run again when media is attached to a review, not
only at upload time).

---

### `POST /store/reviews/:id`

Edit your own review. **Signed-in customers only** — see
[storefront-nextjs.md](./storefront-nextjs.md#review-editing-edit-review-formtsx--own-reviewsts)
for why this is safe to call as a `"use server"` action, unlike voting.

**Body** (`UpdateReviewSchema`, `.strict()`, at least one field required):

| Field | Type | Notes |
|---|---|---|
| `rating` | integer, 1–5 | optional |
| `title` | `string` \| `null` | optional; `""`/`null` clears a previously-set title, omitted leaves it unchanged |
| `content` | `string`, 1–20000 chars | optional |

An empty body (`{}`) is rejected with a 400 — not silently accepted as a
no-op.

**Response `200`:** same shape as `POST /store/reviews`'s response, plus
`edited_at` (now set to the edit time). Media is untouched by an edit and
echoed back unchanged.

**Failure modes:**

| Condition | Status | `type` | Message |
|---|---|---|---|
| Reviews disabled | 404 | `not_found` | `Reviews are disabled` |
| `allow_edit: false` | 400 | `not_allowed` | `Editing reviews is not enabled for this store` |
| Guest (no session) | 403 | `forbidden` | `A guest submission cannot be edited: there is no account to verify it belongs to you. Sign in with the account you used, if any.` |
| Review not found | 404 | `not_found` | `Review not found` |
| Signed-in but not the owner | 403 | `forbidden` | `You may only edit your own review` |
| Content too short/long | 400 | `invalid_data` | same messages as create |

**Status transition:** with `require_approval: true`, an edit returns the
review to `pending` (removed from the storefront immediately, rating
summary recomputed in the same request). **Editing a `rejected` review
always lands in `pending`**, even when `require_approval` is `false` — a
store-wide auto-approval policy is never allowed to silently overturn a
specific moderator judgment. See [README's Review editing section](../README.md#review-editing)
for the full reasoning.

---

### `POST /store/reviews/:id/vote`

Cast a "helpful" vote on an **approved** review. Guest or signed-in
customer (`allowUnauthenticated: true`); no body.

**⚠️ Storefront implementers: read [storefront-nextjs.md](./storefront-nextjs.md#helpful-votes-must-be-cast-from-the-browser-never-from-a-server-action)
before wiring this up.** This route derives a guest voter's identity from
`req.ip` + `req.headers['user-agent']`; calling it from a server-side
wrapper collapses every guest to one identity.

**Response `201`:**

```json
{
  "vote": { "id": "rvote_...", "review_id": "rev_..." },
  "helpful_count": 4
}
```

**Failure modes:**

| Condition | Status | `type` | Message |
|---|---|---|---|
| Reviews disabled | 404 | `not_found` | `Reviews are disabled` |
| Review not found | 404 | `not_found` | `Review not found` |
| Review not `approved` | 400 | `not_allowed` | `Cannot vote on a review that has not been approved` |
| Duplicate vote from the same identity | 409 | `conflict` | `You have already voted this review as helpful.` |

A signed-in customer is deduped by `customer_id`; a guest by `voter_hash`
(`sha256(ip + user-agent + salt)`). Never both for the same row — enforced
by two disjoint partial unique indexes in Postgres, not application code,
so a race between two concurrent requests from the same identity can never
create two live votes.

---

### `DELETE /store/reviews/:id/vote`

Withdraw your own vote. Same auth shape as the `POST`, no body.

**Response `200`:**

```json
{ "id": "rvote_...", "object": "review_vote", "deleted": true, "helpful_count": 3 }
```

**Failure modes:**

| Condition | Status | `type` | Message |
|---|---|---|---|
| Reviews disabled | 404 | `not_found` | `Reviews are disabled` |
| No matching vote for this identity | 404 | `not_found` | `Vote not found` |

---

### `GET /store/reviews/gallery`

The customer media gallery — every approved, non-hidden review's photo or
video, product-scoped or site-wide. **The response is flat: `{ media, count, limit, offset }`.**
If you're working from a spec sketch that shows a nested `items` shape,
that sketch is wrong — this was checked directly against
`src/api/store/reviews/gallery/route.ts`.

**Query** (`GalleryQuerySchema`, `.strict()`):

| Param | Type | Default | Notes |
|---|---|---|---|
| `product_id` | `string` | — | scope to one product; omitted = site-wide |
| `type` | `image` \| `video` \| `all` | `all` | an omitted `type` and `type=all` are the same request |
| `limit` | integer | 20 | 1–100 (`GALLERY_MAX_LIMIT`) |
| `offset` | integer | 0 | ≥0 |

**Response `200`:**

```json
{
  "media": [
    {
      "id": "rmed_...",
      "review_id": "rev_...",
      "type": "image",
      "url": "...",
      "thumbnail_url": null,
      "pinned_at": null,
      "created_at": "...",
      "rating": 5,
      "display_name": "...",
      "product_id": "prod_..."
    }
  ],
  "count": 8,
  "limit": 20,
  "offset": 0
}
```

**`thumbnail_url` is always `null` in this plugin version** — no poster
generation exists yet. **Never present:** `email`, `customer_id`,
`replied_by`.

**Ordering:** pinned media first, then newest —
`pinned_at DESC NULLS LAST, created_at DESC`. `NULLS LAST` is load-bearing;
Postgres's default `DESC` sort treats `NULL` as the largest value, which
would otherwise put every *unpinned* item ahead of pinned ones.

**Cache-Control header** (this route only; no other store route sets one):

```
public, max-age=0, s-maxage=60, stale-while-revalidate=300
```

`max-age=0` keeps a shopper's own browser revalidating on every visit;
`s-maxage=60` bounds a shared cache/CDN to 60 seconds; `stale-while-revalidate=300`
lets that cache serve stale for up to another 300 seconds while
revalidating in the background. **Real worst-case staleness is ~360
seconds (~6 minutes), not 60** — see [revalidation.md](./revalidation.md)
for how to shrink this with an event subscriber.

**Failure:** `enabled: false` **or** `gallery_enabled: false` → 404,
`not_found`, `Gallery is disabled`. The master `enabled` switch is checked
first — turning reviews off entirely takes the gallery down too, even if
`gallery_enabled` is still `true`.

---

## Admin routes

Every route below requires an authenticated admin session (enforced by
Medusa core, not this plugin). None returns a public-safe allow-listed
subset — the admin routes intentionally return the **full** record,
including a guest reviewer's `email`, since moderating spam requires
seeing who sent it.

### `GET /admin/reviews`

List/filter reviews for the moderation queue.

**Query** (`ListAdminReviewsSchema`, `.strict()`):

| Param | Type | Notes |
|---|---|---|
| `status` | `pending` \| `approved` \| `rejected` | optional |
| `product_id` | `string` | optional |
| `rating` | integer, 1–5 | optional |
| `q` | `string`, ≤200 chars | free-text, case-insensitive `ILIKE`-OR across `display_name`/`email`/`title`/`content`, applied as a real WHERE clause (not a post-fetch filter) |
| `limit` | integer, 1–100 | default 20 |
| `offset` | integer, ≥0 | default 0 |

**Response `200`:** `{ reviews: [...full rows, plus media_count], count, limit, offset }`,
ordered newest first. Each row includes `media_count` (one grouped query
for the whole page — includes hidden media, since a moderator needs the
true attached count).

---

### `POST /admin/reviews/:id/approve`

Approve one review. No body. **Response `200`:** `{ review: {...full row} }`.
Emits `review.approved` (see [revalidation.md](./revalidation.md)).

### `POST /admin/reviews/:id/reject`

Reject one review, deleting its media (irreversible — see the
[README](../README.md#photo-and-video-uploads) for the full reasoning).

**Body** (`RejectReviewSchema`): `{ rejection_reason?: string }` (≤500 chars).

**Response `200`:** `{ review: {...full row} }`. Emits `review.rejected`.

### `POST /admin/reviews/batch/status`

Bulk approve/reject/reset by id.

**Body** (`BatchStatusSchema`):

```json
{ "ids": ["rev_...", "..."], "status": "approved" | "rejected" | "pending", "rejection_reason": "..." }
```

`ids`: 1–100. `status: "rejected"` deletes media for every review in the
batch. `status: "pending"` emits `review.updated`, **not** `review.rejected`
— see [revalidation.md](./revalidation.md#reviewupdated-means-three-different-things)
for why this distinction matters beyond caching.

**Response `200`:** `{ reviews: [...full rows] }`.

**Known limitation:** the public rating summary is recomputed for only the
**first** product among the batch's reviews. A batch scoped to one product
(the normal admin-UI case) is fully correct; a batch spanning multiple
products leaves every product after the first stale until its next write.

---

### `GET /admin/reviews/:id/media`

List a review's media, **including items already hidden** by curation —
unlike every store-facing media list, which excludes hidden items. A
moderator needs to see and delete already-hidden media, or it becomes
unreachable through the admin UI.

**Response `200`:**

```json
{
  "media": [
    {
      "id": "rmed_...", "type": "image", "url": "...", "thumbnail_url": null,
      "mime_type": "image/jpeg", "sort_order": 0, "pinned_at": null, "hidden_at": null
    }
  ]
}
```

### `DELETE /admin/reviews/media/:id`

Permanently delete one media item — the stored file itself, not just the
row. Irreversible; use curation (`hidden: true`) instead if you want a
reversible take-down.

**Response `200`:** `{ id, object: "review_media", deleted: true }`. Emits
`review.media.deleted` (only if the media had a resolvable product — an
unattached upload has never been on any storefront page).

### `POST /admin/reviews/media/:id/curation`

Pin and/or hide a media item — the reversible counterpart to `DELETE`.

**Body** (`CurateMediaSchema`, at least one field required):

```json
{ "pinned": true, "hidden": false }
```

**Response `200`:** `{ media: { id, pinned_at, hidden_at } }`. Emits
`review.media.curated` — the most time-critical event this plugin emits,
since the gallery route's cache means hiding can otherwise take ~6 minutes
to actually stop being served.

---

### `POST /admin/reviews/:id/reply`

Create or overwrite the merchant reply (one live reply per review — no
history, no threading). Atomic
`INSERT ... ON CONFLICT (review_id) ... DO UPDATE`.

**Body** (`ReplyToReviewSchema`): `{ content: string }` (1–5000 chars).

**Response `200`:** `{ reply: { id, review_id, content, created_at, updated_at } }`.
`replied_by` (the admin user's id) is recorded on the row but **never**
appears in this or any other response.

### `GET /admin/reviews/:id/reply`

Read the current reply. **`{ reply: null }` with a `200`**, not a 404,
when nobody has replied — that's a normal state.

### `DELETE /admin/reviews/:id/reply`

Remove the reply. **Response `200`:** `{ id, object: "review_reply", deleted: true }`.

---

### `GET /admin/reviews/stats/:product_id`

Rating summary for one product, admin-side. **Not gated by the `enabled`
setting** — a merchant can still see data they already have even with
reviews switched off. Same response shape as the store stats route.

### `GET /admin/reviews/settings`

Read the current settings row (merged with defaults — see
[settings.md](./settings.md)).

**Response `200`:** `{ settings: {...all 14 fields} }`.

### `POST /admin/reviews/settings`

Update settings, partially — send only the fields you want to change.
Takes effect immediately (a 5-minute settings cache is invalidated on
every successful write).

**Body** (`UpdateReviewSettingsSchema`, `.strict()`, every field optional):
see [settings.md](./settings.md) for the full field list, defaults, and
bounds.

**Response `200`:** `{ settings: {...all 14 fields, post-update} }`.
Emits `review.settings.updated` (not part of the [revalidation recipe](./revalidation.md) —
settings changes aren't per-product cache state).
