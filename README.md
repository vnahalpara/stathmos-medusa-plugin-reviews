# @stathmos/medusa-plugin-reviews

Product reviews for [Medusa v2](https://medusajs.com) with photo and video
support, a customer media gallery API, merchant replies, helpful votes, and
moderation settings a merchant can change from the admin without a redeploy.

> **Status: pre-release (Phase 2).** The core review module and photo/video
> media have shipped: submitting, listing, moderating and summarizing
> reviews; DB-backed settings editable from the admin without a redeploy;
> and photo/video uploads with content-sniffed validation, EXIF stripping,
> merchant-configurable size/count limits, and an hourly sweep of
> never-attached uploads. **Not yet implemented: the customer gallery API,
> helpful votes, merchant replies, and review editing.** Do not install this
> from npm expecting those features. See [API](#api) for what works today
> and [Roadmap](#roadmap) for what's next.

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
- 💬 Merchant replies
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

Eleven endpoints ship across Phases 1–2:

```
POST   /store/reviews                       Submit a review (guest or customer, per settings)
GET    /store/products/:id/reviews          List a product's approved reviews
GET    /store/products/:id/reviews/stats    Denormalized rating summary + breakdown
POST   /store/reviews/uploads               Upload review photos/videos (multipart, field name "files")
GET    /admin/reviews                       List/filter reviews (status, product_id, rating)
POST   /admin/reviews/:id/approve           Approve one review
POST   /admin/reviews/:id/reject            Reject one review, with a reason
POST   /admin/reviews/batch/status          Bulk approve/reject/reset by id
DELETE /admin/reviews/media/:id             Remove a single media item
GET    /admin/reviews/settings              Read the current settings
POST   /admin/reviews/settings              Update settings (partial, no redeploy)
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

**Not implemented yet:** the customer media gallery API, helpful votes,
merchant replies, and review editing. There is no route to edit or delete a
review as its author, and no route to manage votes — those are Phases 3–4.
See [Roadmap](#roadmap).

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
- **Rejecting a review does NOT remove its media from storage.** Read that
  literally. `POST /admin/reviews/:id/reject` and
  `POST /admin/reviews/batch/status` change the review's status and nothing
  else. Every photo and video attached to a rejected review is still in
  your file storage and is still served, publicly, at the same URL it had
  before — the store API stops returning it, and it disappears from the
  storefront, but the bytes are one URL away for anyone who has that URL.
  Rejecting for "offensive photo" therefore removes the photo from your
  product page and **not** from the internet.
  **`DELETE /admin/reviews/media/:id` is the only thing that removes stored
  media**, and you must call it explicitly, per media item, in addition to
  rejecting. If you build moderation tooling on these endpoints, wire that
  delete into your reject flow yourself.
  This is deliberate. Deletion is irreversible and rejection is frequently
  for fixable reasons (wrong product, thin content, a policy detail the
  shopper can correct), so the plugin does not destroy customer content as
  a side effect of a reversible moderation action. Server-generated,
  non-enumerable storage keys mean a rejected review's media is not
  discoverable by guessing; it is not, and is not claimed to be, deleted.
- **`DELETE /admin/reviews/media/:id` is irreversible.** It removes the
  stored file itself, not just the database row — a row-only delete would
  leave the photo still publicly reachable at its storage URL, which
  defeats the entire point of a moderator being able to remove offensive
  content. There is no undo; there is also no soft-hide via this route (use
  `hidden_at` for that, once Phase 4 ships curation tooling for it).
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
served back **is** one this plugin chooses, because the stored filename —
and therefore the extension `express.static` derives that header from — is
generated from the sniffed format, never from the upload (see the filename
bullet above). What the allow-list does **not** give you is any guarantee
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
| 2 | Media (images + video), uploads, orphan sweep ✅ ← **you are here** |
| 3 | Admin UI: queue, detail drawer, replies, settings page |
| 4 | Helpful votes, gallery API, curation, review editing |
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
