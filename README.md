# @stathmos/medusa-plugin-reviews

Product reviews for [Medusa v2](https://medusajs.com) with photo and video
support, a customer media gallery API, merchant replies, helpful votes, and
moderation settings a merchant can change from the admin without a redeploy.

> **Status: pre-release (Phase 4).** The core review module, photo/video
> media, merchant replies, a bundled admin UI, helpful votes, the customer
> media gallery API, gallery curation and review editing have shipped:
> submitting, listing, moderating and summarizing reviews; DB-backed
> settings editable from the admin without a redeploy; photo/video uploads
> with content-sniffed validation, EXIF stripping, merchant-configurable
> size/count limits, and an hourly sweep of never-attached uploads; a
> merchant reply on each review, visible on the storefront only once the
> review is approved; a "Reviews" admin dashboard route with a moderation
> queue, bulk actions, a media lightbox (now with pin/hide curation
> controls), a reply composer and a settings page; helpful votes with
> database-enforced de-duplication (see
> [Helpful votes](#helpful-votes) for the guest-dedup caveat); a
> product-scoped or global customer media gallery
> (see [Customer media gallery](#customer-media-gallery)); and
> customer-editable reviews with re-moderation (see
> [Review editing](#review-editing)). **Not yet implemented: a storefront
> rendering recipe/JSON-LD and per-endpoint rate limiting** — see
> [Roadmap](#roadmap) for what's next. Do not install this from npm yet;
> it is still pre-release. See [API](#api) for what works today.

## Why another reviews plugin

Three community reviews plugins exist for Medusa, all offering basic CRUD plus
moderation. None offers a **media gallery API**, video, DB-backed live
settings, merchant replies, or helpful votes on v2. Those are the features that
make review apps like Loox and Judge.me worth paying for, and they are what
this plugin sets out to cover.

## Planned features (v1)

- ⭐ Ratings 1–5 with title and body, verified-purchase badges
- 📷 Photo **and video** reviews via Medusa's File Module (S3/R2 in production)
- 🖼️ **Customer gallery API** — UGC strips on product pages, or a site-wide
  gallery, product-scoped or global
- ✅ Moderation queue with bulk approve/reject and rejection reasons
- 🖥️ **Bundled admin UI** — a "Reviews" dashboard route with a moderation
  queue (tabs, server-side search, pagination), bulk approve/reject, a
  detail drawer with a media lightbox and per-media delete, a merchant
  reply composer, a product-detail widget, and a settings page
- 💬 Merchant replies, visible on the storefront once their review is
  approved, attributed to the store's name
- 👍 Helpful votes with de-duplication
- ⚙️ **Live settings** — approval, guests, verified-only, media caps and more,
  all editable from Settings → Reviews with no redeploy
- 📊 Rating summary and histogram endpoint, backed by a denormalized per-product
  summary so product pages stay fast
- 🔍 JSON-LD rich snippets recipe for the storefront

Deferred to v2: review-request emails, CSV import/export, incentives, Q&A,
auto-approve rules, profanity filtering.

## Requirements

| | |
|---|---|
| Medusa | 2.18 and later 2.x |
| Node | 20–24 |
| Database | PostgreSQL |

## Installation

```sh
npm install @stathmos/medusa-plugin-reviews
```

Register it in `medusa-config.ts`:

```ts
module.exports = defineConfig({
  plugins: [
    {
      resolve: '@stathmos/medusa-plugin-reviews',
      options: {},
    },
  ],
})
```

Then run migrations:

```sh
npx medusa db:migrate
```

### Installing in a pnpm project

pnpm's default isolated linker hides plugins from Medusa. Medusa resolves
plugin modules from inside `@medusajs/utils`, which lives in pnpm's virtual
store and cannot see your app's `node_modules`, so migration fails with:

```
Cannot find module '@stathmos/medusa-plugin-reviews/.medusa/server/src/modules/…'
```

Hoist the package in your `.npmrc` and reinstall:

```ini
public-hoist-pattern[]=@stathmos/*
```

npm and yarn need no such workaround. This is a pnpm/Medusa interaction, not
specific to this plugin — it affects any Medusa plugin that ships a module.

### Upgrading from a pre-release build with the `review`/`product` link

An early, unreleased commit on the Phase 1 branch briefly added a
`review`/`product` module link, later withdrawn (see the CHANGELOG's
Unreleased section) because it let Medusa's core `/store/products` routes
leak raw review rows — guest emails and unmoderated content — to anyone
with a publishable API key. If you never ran that commit's `db:migrate`
against your database, there is nothing to do. If you did, your database
has a leftover `review_review_product_product` table that this version no
longer manages. Running `npx medusa db:migrate` again detects the removed
link and interactively prompts you to select it for deletion:

```
? Select the tables to DELETE. The following links have been removed
❯◯ review.review <> product.product (review_review_product_product)
```

Select it (space, then enter) to drop the table. This prompt needs an
interactive terminal — running `db:migrate` unattended (CI, a scripted
deploy) will leave the prompt waiting on stdin, so run it interactively at
least once after upgrading. Leaving the table unconfirmed is inert (nothing
in this plugin reads or writes it once the link definition is gone) but it
is safe and recommended to clean it up.

## API

Twenty-one endpoints ship across Phases 1–4:

```
POST   /store/reviews                        Submit a review (guest or customer, per settings)
GET    /store/products/:id/reviews           List a product's approved reviews, with their media and reply
GET    /store/products/:id/reviews/stats     Denormalized rating summary + breakdown
POST   /store/reviews/uploads                Upload review photos/videos (multipart, field name "files")
POST   /store/reviews/:id                    Edit your own review (signed-in customers only)
POST   /store/reviews/:id/vote               Cast a "helpful" vote on an approved review (guest or customer)
DELETE /store/reviews/:id/vote               Withdraw your helpful vote
GET    /store/reviews/gallery                Customer media gallery, product-scoped or global
GET    /admin/reviews                        List/filter reviews (status, product_id, rating, free-text q); each row includes media_count
POST   /admin/reviews/:id/approve            Approve one review
POST   /admin/reviews/:id/reject             Reject one review, with a reason (permanently deletes its media)
POST   /admin/reviews/batch/status           Bulk approve/reject/reset by id (rejecting deletes media)
DELETE /admin/reviews/media/:id              Remove a single media item
POST   /admin/reviews/media/:id/curation     Pin or hide a media item (gallery curation)
GET    /admin/reviews/:id/media              List a review's media, including items a moderator has hidden
GET    /admin/reviews/stats/:product_id      Rating summary + breakdown for one product (admin; not gated by the enabled setting)
POST   /admin/reviews/:id/reply              Create or update the merchant reply to a review
GET    /admin/reviews/:id/reply              Read the current reply, or { reply: null } if there isn't one
DELETE /admin/reviews/:id/reply              Delete the merchant reply
GET    /admin/reviews/settings               Read the current settings
POST   /admin/reviews/settings               Update settings (partial, no redeploy)
```

The three review-facing `/store/*` routes above (`POST /store/reviews`,
`GET /store/products/:id/reviews`, `GET /store/products/:id/reviews/stats`)
404 outright when the `enabled` setting is off. `POST /store/reviews/uploads`
is gated the same way but responds **400**, not 404, when reviews or media
uploads are disabled. Both routes respond 400 for their respective checks,
but not through the same error type: "reviews disabled" and "video uploads
disabled" respond with `NOT_ALLOWED`, while unsupported format, too many
files, an oversized file and an undecodable or over-budget image all
respond with `INVALID_DATA`. The HTTP
status code is 400 either way, but a caller inspecting the JSON response
body's `type` field will see `not_allowed` for the first two and
`invalid_data` for the rest. Verified-purchase status requires an
authenticated customer — matching a guest's self-supplied email would make
the badge forgeable.

**`POST /store/reviews/uploads` needs only a valid publishable API key, not
customer authentication** — the same as review submission itself when guest
reviews are allowed. Until per-endpoint rate limiting ships (Phase 6), this
is effectively an unauthenticated write to object storage, bounded only by
the checks below (format, size, count). Put it behind your own rate limiting
if that matters for your storefront before Phase 6 ships.

**Phase 4 adds five endpoints** to the list above: review editing
(`POST /store/reviews/:id`), helpful votes
(`POST`/`DELETE /store/reviews/:id/vote`), the customer media gallery
(`GET /store/reviews/gallery`), and admin gallery curation
(`POST /admin/reviews/media/:id/curation`). `allow_edit`
and `gallery_enabled` (see [Admin settings](#admin-settings) below) now
both gate real behaviour, where in Phases 1–3 they existed in the settings
schema but did nothing. See [Helpful votes](#helpful-votes),
[Customer media gallery](#customer-media-gallery) and
[Review editing](#review-editing) below for the detail, and
[Roadmap](#roadmap) for what's still ahead.

### Admin settings

All 14 settings below are read via `GET /admin/reviews/settings`, written
(partially — send only the fields you want to change) via
`POST /admin/reviews/settings`, and take effect immediately, with no
redeploy: a 5-minute cache is invalidated on every successful write. The
bundled admin UI's settings page (Settings → Reviews) exposes all 14.

| Setting | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch. The three review-facing `/store/*` routes 404 when off. |
| `require_approval` | `true` | New reviews start `pending` instead of `approved`. |
| `allow_guest` | `false` | Lets unauthenticated shoppers submit reviews. |
| `verified_only` | `false` | **Restricts submission to signed-in customers with a verified purchase.** Read that as written: with this on, a guest's submission is **rejected outright** at `POST /store/reviews`, not merely accepted and left without a "verified" badge. |
| `allow_media` | `true` | Lets shoppers attach photos. Turning this off also blocks video, regardless of `allow_video`. |
| `allow_video` | `true` | Lets shoppers attach video, in addition to photos. Has no effect while `allow_media` is off. |
| `max_media_per_review` | `5` | 0–20. |
| `max_image_size_mb` | `5` | 1–50. |
| `max_video_size_mb` | `50` | 1–100. **Values above 100 have no effect.** Uploads are capped at 100MB per file at the transport layer regardless of what this is set to — see [Photo and video uploads](#photo-and-video-uploads). |
| `allow_edit` | `true` | Lets a signed-in customer edit their own review's rating, title and content after submitting it — see [Review editing](#review-editing). Guests can never edit, regardless of this setting. **The `true` default applies only to a fresh install that has never saved a settings row.** `mergeSettings()` copies a stored value over the new default, so a store that saved settings at any point before Phase 4 keeps its stored `false` and must switch this on itself in Settings → Reviews to enable editing. This is the safe outcome, not an oversight: it is exactly what keeps the riskier `allow_edit: true` + `require_approval: false` pairing from ever appearing silently on an upgrade — that pairing can only exist because a merchant explicitly turned both settings on. |
| `one_review_per_customer` | `true` | A signed-in customer may submit only one review per product. |
| `min_content_length` | `10` | 0–1000. |
| `max_content_length` | `5000` | 1–20000. |
| `gallery_enabled` | `true` | Gates `GET /store/reviews/gallery` (see [Customer media gallery](#customer-media-gallery)) — off means that endpoint 404s. It does not affect the photos already shown on individual reviews, which are governed by `allow_media`/`allow_video` above, not this one. |

### Merchant replies

- **One live reply per review.** `POST /admin/reviews/:id/reply` creates a
  reply if none exists or overwrites the existing one — there is no reply
  history or threading in v1. The write is a single atomic
  `INSERT ... ON CONFLICT (review_id) WHERE deleted_at IS NULL DO UPDATE`
  against a partial unique index, so two concurrent saves to the same
  review can never produce two live rows. `GET /admin/reviews/:id/reply`
  returns `{ reply: null }` with a **200**, not a 404, when nobody has
  replied yet — that's a normal state, not an error. `DELETE
  /admin/reviews/:id/reply` removes it; the review can be replied to again
  afterward.
- **A reply is visible to shoppers only once its review is approved.**
  `GET /store/products/:id/reviews` re-derives approval from the reviews
  table for every reply it returns, the same rule and the same code shape
  as media visibility — so a reply written against a still-pending or
  rejected review is invisible on the storefront until (if ever) that
  review is approved, even though the reply itself was saved successfully
  the moment the merchant submitted it.
- **The public author is always the store's name, never the admin user
  who wrote the reply.** The store route resolves the current store's
  `name` once per request and attaches it as `author`; the admin user's id
  is recorded on the row as `replied_by` for audit purposes only and is
  never present in any response body — not the store route's, and not the
  admin GET/POST reply routes' either. Do not rely on `replied_by` from
  the API; it isn't exposed anywhere.

### Helpful votes

- **`POST /store/reviews/:id/vote` casts a "helpful" vote; `DELETE
  /store/reviews/:id/vote` withdraws it.** Both accept a guest or a
  signed-in customer, and neither takes a body. Only an **approved** review
  can be voted on — an unmoderated review must not accumulate social proof
  — so voting on a `pending` or `rejected` review is refused (400).
- **A signed-in customer is deduped by `customer_id`; a guest is deduped by
  `voter_hash`** (`sha256(ip + user-agent + salt)` — see
  [Configuring the vote salt](#configuring-the-vote-salt) below). Never
  both for the same row. Two disjoint partial unique indexes on
  `review_vote` — one on `(review_id, customer_id) WHERE customer_id IS
  NOT NULL`, one on `(review_id, voter_hash) WHERE voter_hash IS NOT NULL`
  — enforce this in Postgres itself, not in application code, so no race
  between two concurrent requests from the same identity can ever create
  two live votes. **A duplicate vote from the same identity is a 409.**
- **`helpful_count` is maintained by a single atomic `UPDATE ...
  increment`**, never a read-then-write — this codebase has already lost
  concurrent increments to that shape twice (`claimMediaForReview`,
  `upsertReviewReply`) and does not repeat it for votes.
- **Guest dedup is best-effort and defeatable, by design — say so
  plainly.** `voter_hash` is derived from IP address and user agent, both
  of which a determined actor can rotate. It is not a security boundary;
  it stops casual double-voting (a shopper double-clicking, or refreshing
  the page), not a targeted attempt to inflate a count. It ships anyway
  because the alternative — customer-only voting — is close to useless on
  a storefront where most traffic reading reviews is anonymous. Per-
  endpoint rate limiting (Phase 6) is what makes abuse costly at scale;
  until then, treat `helpful_count` as a rough social-proof signal, not a
  tamper-proof metric.

#### Configuring the vote salt

`voterHash()` refuses to run without a salt — there is **no default**,
deliberately. A hardcoded salt would make every guest's `voter_hash` value
comparable across every installation of this plugin, turning a per-store
pseudonym into a cross-site identifier. A store that never configures a
salt gets a loud failure (a thrown `MedusaError`, surfacing as a 500) the
moment a guest actually casts a vote — not a silently degraded hash.
Signed-in customer votes are unaffected either way, since they are deduped
by `customer_id` and never call `voterHash()` at all.

The salt is an **operator-level secret** — the same category as
`JWT_SECRET`/`COOKIE_SECRET` in `projectConfig.http` — deliberately **not**
a merchant-editable setting in the admin. Configure it via this plugin's
own `voteSalt` option in `medusa-config.ts` (which Medusa cascades onto
the review module the plugin declares internally), or the
`REVIEW_VOTE_SALT` environment variable as a fallback; the plugin option
wins when both are set, and an empty-string option is treated as unset
(falls through to the env var) rather than as a deliberate empty salt:

```ts
module.exports = defineConfig({
  plugins: [
    {
      resolve: '@stathmos/medusa-plugin-reviews',
      options: { voteSalt: process.env.REVIEW_VOTE_SALT },
    },
  ],
})
```

**Changing the salt after votes exist breaks dedup for every guest
voter.** A `voter_hash` computed under the old salt will never match one
computed under a new salt, so a guest who already voted can vote again
after a salt rotation — the unique index no longer recognizes them as the
same voter. Signed-in customer votes are unaffected, since they are never
keyed by the salt. Treat the salt as a value you set once, at first
deploy, and do not change.

**GDPR: `voter_hash` is pseudonymous personal data**, per spec §9. It is
derived from a shopper's IP address and user agent — both personal data on
their own — and the salt does not anonymize it; the salt only stops the
same hash from being derived and compared across different store
installations. Handle it as personal data for retention, access and
erasure purposes, the same as any other reviewer-identifying field this
plugin stores (a guest reviewer's `email`, for instance): this plugin does
not ship its own retention or erasure tooling for any of these fields yet,
so building that remains store-operator responsibility.

### Customer media gallery

- **`GET /store/reviews/gallery`** returns approved reviews' photos and
  video, scoped to one product (`?product_id=`) or, if `product_id` is
  omitted, the site-wide gallery across every product. Gated by the
  `gallery_enabled` setting — off, and the endpoint 404s, the same pattern
  every other `enabled`-shaped setting in this plugin follows.
- **Parameters**, all optional, all in the query string: `product_id`
  (scope to one product), `type` (`image` | `video` | `all` — an omitted
  `type` and `type=all` are the same request), `limit` (default `20`,
  **capped at 100** — an uncapped limit on the one store route with no
  required product/review scope at all is a free denial-of-service),
  `offset`.
- **Ordering: pinned media first, then newest** —
  `pinned_at DESC NULLS LAST, created_at DESC`. `NULLS LAST` is
  load-bearing: Postgres's default `DESC` sort treats NULL as the largest
  value, which would otherwise put every *unpinned* item ahead of pinned
  ones. See [Gallery curation](#gallery-curation) for how an item gets
  pinned.
- **Only media on approved, non-deleted, non-hidden reviews is ever
  returned.** Approval and visibility are re-derived from a live join
  against the `review` table inside the query itself, never trusted from
  the request — the same enforcement pattern
  `GET /store/products/:id/reviews` already applies to its own media — so
  a pending or rejected review's photo, or one a moderator has hidden, can
  never leak into the gallery.
- **The response is cached at the edge:**
  `Cache-Control: public, max-age=0, s-maxage=60,
  stale-while-revalidate=300`. `max-age=0` keeps a shopper's own browser
  revalidating on every visit rather than pinning a stale copy locally;
  `s-maxage=60` bounds freshness at a shared cache/CDN in front of this —
  the highest-volume public read in the plugin — to 60 seconds, which is
  what takes real read pressure off the database. `stale-while-revalidate=300`
  then authorizes that same shared cache to keep serving its last copy for
  up to a further 300 seconds while it revalidates in the background, so a
  slow origin request never becomes a slow gallery load. **The real worst
  case is therefore ~360 seconds (about 6 minutes), not 60** — that is how
  long a newly approved review's media, or a photo a moderator just hid,
  can take to actually change at a shared cache, even though the shopper's
  own browser (`max-age=0`) always revalidates. The response has no
  per-shopper component, so it is safe to share across every caller of the
  same product_id/type/limit/offset.
- Each item in the `media` array is allow-listed, not the raw row: `id`,
  `review_id`, `type`, `url`, `thumbnail_url`, `pinned_at`, `created_at`,
  `rating`, `display_name`, `product_id` — never `email`, `customer_id` or
  `replied_by`.

### Gallery curation

- **`POST /admin/reviews/media/:id/curation`** with
  `{ pinned?: boolean, hidden?: boolean }` — **at least one field is
  required**; an empty body is a 400, not a silent no-op that reports
  success back to a moderator who curated nothing.
- **Pinning promotes an item to lead the gallery's ordering**
  (`pinned: true` sets `pinned_at`); `pinned: false` un-pins it (nulls
  `pinned_at`).
- **Hiding removes an item from the gallery without deleting the file** —
  `hidden: true` sets `hidden_at`, which both `GET /store/reviews/gallery`
  and the `media` array on `GET /store/products/:id/reviews` already
  exclude; `hidden: false` un-hides it. This is the reversible alternative
  to `DELETE /admin/reviews/media/:id`, which is permanent: use curation
  for "take this down for now", and delete for "this should never have
  been stored."
- The two fields are independent — a request that only sets `hidden` never
  touches `pinned_at`, and vice versa.
- **Also available from the admin lightbox** (Settings → Reviews → a
  review's detail drawer → media lightbox), with Pin/Unpin and Hide/Unhide
  controls next to each item.
- The route sits directly under the pre-existing
  `DELETE /admin/reviews/media/:id`, one more path segment deep; both
  resolve independently.

### Review editing

- **`POST /store/reviews/:id`** with `{ rating?, title?, content? }` — at
  least one field is required, same "empty body is a 400" rule as
  curation above. Gated by the `allow_edit` setting (see
  [Admin settings](#admin-settings)); off, and editing is refused with a
  400.
- **Signed-in customers only.** A guest review submission has no account
  proving it belongs to whoever is asking to edit it, so guests can never
  edit — the endpoint says so explicitly, refusing with a 403 ("A guest
  submission cannot be edited: there is no account to verify it belongs to
  you...") rather than a bare, unexplained 401.
- **A customer may only edit their own review.** Ownership is checked
  against the review row's own `customer_id`, and refused with a 403
  ("You may only edit your own review") otherwise — including against a
  guest-authored review, whose `customer_id` is always null and so can
  never match any signed-in customer's id.
- **With `require_approval: true`, an edit returns the review to
  `pending`.** It leaves the storefront immediately, and the product's
  rating summary is recomputed in the same request, so an
  edited-and-unapproved review stops contributing to the average right
  away, not on some later write.
- **An edit of a `rejected` review always lands in `pending`, even when
  `require_approval` is `false`.** This is deliberate, not an oversight:
  `require_approval` is a store-wide policy about content nobody has
  looked at yet, while a rejection is a human moderator's judgment about
  that *specific* review — a store-wide auto-approval policy must never be
  allowed to silently overturn a moderator's decision on one review. A
  customer can still fix a rejected review by editing it; they just cannot
  republish it themselves. It goes back to `pending` for a human to look
  at again, the same as any other edit under `require_approval`.
- **`title: null` clears a previously-set title.** This is the only way to
  remove a title once one has been added; omitting `title` from the
  request leaves it unchanged.
- **Media survives an edit.** Editing a review's text never touches its
  attached photos or video — unlike rejection, which deletes them.
- **`edited_at` is set** on every successful edit.

### Photo and video uploads

- **Accepted formats: JPEG, PNG, WebP, AVIF, MP4, WebM.** The format is
  determined by sniffing the file's own bytes (magic numbers/container
  brands), never from the filename or the client-declared `Content-Type` —
  a `.png` that is actually a shell script is rejected with a 400, not
  stored.
- **HEIC and MOV are rejected.** iPhones produce exactly these formats by
  default (Live Photos save as HEIC, videos as MOV/QuickTime), so a shopper
  uploading straight from their phone's camera roll without converting first
  will hit this. Tell them to choose "Most Compatible" in the iPhone Camera
  settings (Settings → Camera → Formats), which makes the phone save JPEG/
  H.264-MP4 instead, or convert before uploading.
- **Size and count limits are merchant-configurable and take effect without
  a redeploy**, via `POST /admin/reviews/settings`: `max_media_per_review`
  (default 5, 0–20), `max_image_size_mb` (default 5, 1–50), and
  `max_video_size_mb` (default 50, 1–100). `max_media_per_review` bounds the
  total media a review ends up with, enforced when media is attached to the
  review at `POST /store/reviews` time (already-attached count plus the
  incoming ids) — not merely the file count of one call to
  `POST /store/reviews/uploads`, so splitting an upload across several
  requests cannot get more media onto a review than the setting allows.
  The upload endpoint has its own per-request count check too, ahead of
  this one, purely so an over-large single call is rejected before its
  bytes are processed rather than after. **Hard transport-layer ceilings
  apply regardless of settings**, aborting the upload before the request
  reaches this plugin's own format/size/count checks or the File Module:
  **100MB per file**, **20 files per request**, **250MB for the request as
  a whole**, and **no non-file form fields at all** (this endpoint reads
  none). The per-file and per-count ceilings match the maximum each
  corresponding setting can be configured to, so no configured cap is ever
  silently unreachable. The 250MB aggregate is the one that is not a
  product of the other two, deliberately: 20 files × 100MB would be 2GB of
  attacker-chosen bytes buffered in memory per request. 250MB is the
  largest request a **default** install can legitimately produce
  (`max_media_per_review` 5 × `max_video_size_mb` 50MB). If you raise both
  settings well above their defaults, a single very large multi-video
  submission can be rejected by this ceiling — put a front proxy with its
  own body limit in front of the endpoint and size it to match your
  settings.
- **Images have a decode budget: 25 megapixels, with no side longer than
  10,000 pixels.** The size limits above bound *compressed* bytes, which
  bounds nothing about the work a decode costs — a few hundred bytes of
  AVIF can declare 6000×6000 and cost around half a second of server CPU.
  Over-budget images are rejected from the image header, before any pixels
  are decoded, with a 400. Files in a single request are also processed one
  at a time rather than concurrently, so one request cannot occupy several
  cores. In practice the compressed-size cap bites first for real
  photographs; this bound exists for the case where the two diverge.
- **The stored filename is generated by the server, never taken from the
  upload.** The name a file is stored (and served) under is a random UUID
  plus an extension chosen from a fixed map keyed on the format this plugin
  sniffed from the bytes — `3f2b…c1.mp4`, never `pwn.html`. Not one byte of
  the client's own filename reaches the storage key or the public URL. This
  matters because Medusa's default file provider derives its storage key
  from the filename it is handed, and core serves that directory with a bare
  `express.static`, which picks `Content-Type` from the **extension** and
  ignores the MIME recorded alongside the file — so a client-chosen filename
  would be a client-chosen `Content-Type` on your own backend origin, the
  same origin as your admin dashboard. It also means a shopper's own
  filename (`mary-smith-home-address.jpg`) is never published in a URL, and
  that keys are not enumerable from a submission timestamp.
- **What `Content-Type` you actually get back, precisely.** Because the
  extension is server-chosen, so is the header — but on Medusa's default
  local provider the header is emitted by core's `/static` handler, which
  resolves extensions through `send` → `mime@1.6.0`, and that table predates
  AVIF. So five of the six accepted formats are served as exactly the MIME
  this plugin sniffed, and AVIF is served as `application/octet-stream`:

  | Sniffed | Stored as | Served as |
  |---|---|---|
  | `image/jpeg` | `.jpg` | `image/jpeg` |
  | `image/png` | `.png` | `image/png` |
  | `image/webp` | `.webp` | `image/webp` |
  | `image/avif` | `.avif` | **`application/octet-stream`** |
  | `video/mp4` | `.mp4` | `video/mp4` |
  | `video/webm` | `.webm` | `video/webm` |

  The AVIF row is a correctness wrinkle, not a security one: the header is
  still not attacker-chosen, and `application/octet-stream` is not a
  sniffable type per the MIME Sniffing spec, so browsers download rather
  than render it (an `<img>` tag renders AVIF regardless of the header, so
  storefronts are unaffected in practice). If you serve media from S3/R2/a
  CDN instead — which is recommended below — that provider uses the MIME
  recorded on the object and the AVIF row becomes `image/avif` too. The
  guarantee that holds for **all six**, on any provider, is that no accepted
  upload is ever served under a `text/*` type.
- **Serve user media from a separate origin in production.** This plugin
  chooses the filename and records the MIME, but it does not control the
  response headers core's `/static` handler emits — there is no
  `Content-Disposition` and no `X-Content-Type-Options: nosniff` on that
  route. Configure an S3/R2/CDN file provider so uploaded media is served
  from a domain that is **not** the origin your admin dashboard and
  `/admin/*` API live on. That way even a future gap in format validation
  cannot become same-origin script execution against a logged-in moderator.
- **Images are re-encoded to strip EXIF metadata**, so GPS coordinates
  embedded in phone photos are never published next to a review. Video is
  stored as uploaded — stripping container metadata from video needs
  ffmpeg, out of scope for Phase 2.
- **Uploads never attached to a review are deleted automatically after 24
  hours** by an hourly sweep job, so abandoned review forms don't leak
  storage forever.
- **Media settings are re-checked when a review is submitted, not only when
  a file is uploaded.** Turning `allow_media` (or `allow_video`) off takes
  effect immediately: media uploaded before the switch — which lives for up
  to the 24-hour orphan TTL — is refused at `POST /store/reviews` too, so a
  merchant who turns media off stops receiving it at once rather than a day
  later.
- **A `media_ids` entry that is unknown, or already attached to another
  review, gets the same answer**: `404` with `"Unknown or unavailable
  media"`. The two cases are deliberately indistinguishable so the endpoint
  cannot be used to probe which media ids exist. Attaching media you did not
  upload is not otherwise prevented in this phase — media ids are 80-bit
  ULIDs and are not guessable, but there is no ownership binding during the
  window between upload and attachment. Signed upload tokens are Phase 6.
- **Rejecting a review permanently deletes its media.** Read that
  literally. `POST /admin/reviews/:id/reject` and
  `POST /admin/reviews/batch/status` (when the batch's target status is
  `rejected`) delete every photo and video attached to the review — the
  stored file itself, not just the `review_media` row — the moment the
  review is rejected. This is **irreversible**: there is no undo, and
  rejecting a review you might reinstate later still destroys its media
  immediately, not just its visibility. Approving a review, or resetting
  one back to `pending`, never touches media either way.
  This was a deliberate reversal of the original Phase 2 decision (kept
  below for context: deletion used to be opt-in, via
  `DELETE /admin/reviews/media/:id`, precisely because rejection is
  frequently for fixable reasons). The current behaviour is an explicit
  product decision to make rejection destructive, not an oversight — if you
  need a reversible moderation action, that is `hidden_at` via
  [gallery curation](#gallery-curation), not reject.
  The status change always commits before media deletion is attempted. If
  deleting some item's file or row then fails, the review still stays
  rejected — the failure is logged and does **not** revert the review to
  `pending` — and any media left behind by that failure is still reachable
  through `DELETE /admin/reviews/media/:id`, same as before.
  `DELETE /admin/reviews/media/:id` still exists, unchanged, for removing a
  single item from a review that is not being rejected (e.g. one offensive
  photo among several on an otherwise-fine, approved review).
- **`DELETE /admin/reviews/media/:id` is irreversible.** It removes the
  stored file itself, not just the database row — a row-only delete would
  leave the photo still publicly reachable at its storage URL, which
  defeats the entire point of a moderator being able to remove offensive
  content. There is no undo; there is also no soft-hide via this route —
  use `POST /admin/reviews/media/:id/curation` (see
  [Gallery curation](#gallery-curation)) to hide instead of delete.
- **The admin media views deliberately show hidden media; the store-facing
  ones just as deliberately don't.** `GET /admin/reviews/:id/media` and the
  `media_count` field on each row of `GET /admin/reviews` count and list
  every non-deleted item, including any with `hidden_at` set. The
  store-facing equivalents — the `media` array on
  `GET /store/products/:id/reviews` and its `media_count` in
  `/store/products/:id/reviews/stats` — exclude hidden items. This is not
  an inconsistency: a moderator needs to see, and be able to delete, media
  they (or an earlier moderator) have already hidden, or it becomes
  unreachable and undeletable through the admin UI; a shopper should never
  see it at all. Through Phase 3 this had no visible effect, because
  nothing set `hidden_at` yet; Phase 4's curation tooling (pin/hide,
  see [Gallery curation](#gallery-curation)) is what writes to it now.
- **No video transcoding and no server-generated poster frame in Phase 2.**
  Video is stored exactly as uploaded, and `thumbnail_url` on `review_media`
  is always `null`. Storefronts rendering a video gallery need to supply
  their own poster image or fall back to the browser's native first-frame
  behavior (e.g. a plain `<video>` tag with no `poster` attribute).

### Known limitation: WebM detection can be fooled by a crafted Matroska file

WebM and Matroska (`.mkv`) share the same EBML container magic bytes, so
this plugin's byte-sniffer reads the EBML `DocType` element to tell them
apart (Matroska is not an accepted upload; WebM is). A deliberately crafted
Matroska file that plants a fake `DocType` element ahead of the real one can
pass this check and be accepted and stored as `video/webm`. The consequence
is a mislabelled video that may not play correctly.

Be precise about what does and does not bound this. The `Content-Type`
served back is **never one an attacker controls**, because the stored
filename — and therefore the extension `express.static` derives that header
from — is generated from the sniffed format, never from the upload. It is
not always the sniffed type either: on the default local provider AVIF
comes back as `application/octet-stream`, for the reason and with the exact
per-format table given in the uploads section above. What the allow-list
does **not** give you is any guarantee
about the bytes after the magic number: video is stored exactly as
uploaded with no re-encode, so only the leading container bytes are
constrained and everything after them is arbitrary attacker-supplied
content. Images are re-encoded through sharp, which destroys any
non-image payload; video is not. Treat stored video as untrusted bytes
served under a trusted type, and serve it from a separate origin as
described above. Closing the WebM/Matroska ambiguity fully needs a real
EBML parser, which was judged disproportionate for Phase 2; see
`src/media/sniff-mime.ts` for the exact scan logic and its limits.

### Known limitation: multi-product bulk moderation

`POST /admin/reviews/batch/status` recomputes the public rating summary for
only the **first** product among the reviews in the batch. Approving or
rejecting several reviews that all belong to the same product (the normal
admin-UI case, where bulk actions are scoped to one product's review list)
is fully correct. A batch whose ids span multiple products in a single call
will leave every product after the first with a stale summary — the
storefront will show the old average/count until that product is next
touched by another write (a new review, or its own moderation action). If
you build tooling that batches ids across products, call the endpoint once
per product instead of combining ids from different products in one
request.

## Development

This repo is developed against a local Medusa host application:

```sh
# in this repo — watches and republishes to the local registry
npm run dev

# in the host Medusa app
npx medusa plugin:add @stathmos/medusa-plugin-reviews
```

Run the checks CI runs:

```sh
npm run lint
npm run typecheck
npm run build
npm test
```

## Roadmap

| Phase | Scope |
|---|---|
| 0 | Repo bootstrap, CI, release pipeline ✅ |
| 1 | Core module, settings, moderation, stats ✅ |
| 2 | Media (images + video), uploads, orphan sweep ✅ |
| 3 | Merchant replies, admin UI: queue, detail drawer, settings page ✅ |
| 4 | Helpful votes, gallery API, curation, review editing ✅ ← **you are here** |
| 5 | Storefront recipe, JSON-LD, docs |
| 6 | Hardening, second-host validation, `v0.1.0` to npm |

## Releasing

Releases run on [changesets](https://github.com/changesets/changesets):

```sh
npm run changeset   # describe the change
npm run version     # apply version bumps + changelog
npm run release     # build and publish
```

## License

MIT © Stathmos Group
