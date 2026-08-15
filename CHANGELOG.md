# Changelog

All notable changes to this project are documented in this file.

This file is maintained by [changesets](https://github.com/changesets/changesets)
from `v0.1.0` onward — add a changeset with `npm run changeset` rather than
editing released sections by hand.

## Unreleased

Phase 3: merchant replies and a bundled admin UI. One live reply per review
(`review_reply`, enforced by a partial unique index on `review_id`),
created or updated atomically via `POST /admin/reviews/:id/reply`
(`INSERT ... ON CONFLICT ... DO UPDATE`, so two concurrent saves can never
produce two live rows), read back via `GET /admin/reviews/:id/reply`
(`{ reply: null }` with a 200, not a 404, when nobody has replied yet), and
removed via `DELETE /admin/reviews/:id/reply`. A reply is exposed on
`GET /store/products/:id/reviews` only once its review is approved —
re-derived from the reviews table on every read, the same rule and the
same code shape as media visibility — and its public `author` is always
the store's name, never the admin user who wrote it; `replied_by` is
recorded on the row for audit only and never appears in any response body.
Three more admin endpoints round out moderation:
`GET /admin/reviews/stats/:product_id` (a product's rating summary,
not gated by the `enabled` setting so a merchant can still see data they
already have), `GET /admin/reviews/:id/media` (a review's media, including
items already hidden), and free-text search (`q`) plus a `media_count`
field on `GET /admin/reviews`. The admin dashboard now bundles a "Reviews"
sidebar route: a moderation queue (Pending/Approved/Rejected/All tabs,
server-side search, pagination), bulk approve/reject with a reason prompt,
a detail drawer with a media lightbox and per-media delete, the reply
composer, a product-detail widget linking into the filtered queue, and a
settings page covering all 14 settings.

**Two settings ship non-functional, by design, and are documented as
such rather than left to be discovered by reading code.** `allow_edit` and
`gallery_enabled` both exist in the settings schema and the settings page
but affect no request yet: `allow_edit` is reserved for Phase 4's
review-editing feature and ships disabled in the settings UI so it can't
be switched on and mistaken for a working toggle; `gallery_enabled` is
reserved for a future store-wide customer gallery, for which no API
exists yet. Neither is a bug. See the README's
[Admin settings](README.md#admin-settings) table for the full list of all
14 settings, including the two above.

**Admin media views intentionally include hidden media; the store-facing
ones just as deliberately exclude it.** `GET /admin/reviews/:id/media` and
the `media_count` field on `GET /admin/reviews` count and list every
non-deleted item, including any with `hidden_at` set. The store-facing
`media` array on `GET /store/products/:id/reviews` and its `media_count`
in `/store/products/:id/reviews/stats` exclude hidden items. A moderator
needs to see, and be able to delete, media that is already hidden; a
shopper never should. This has no visible effect yet, since nothing before
Phase 4's curation tooling ever sets `hidden_at`.

Not implemented: the customer gallery API, helpful votes, review editing.

Phase 2: photo and video review media. `POST /store/reviews/uploads`
(multipart, field name `files`) accepts JPEG, PNG, WebP, AVIF, MP4 and WebM,
determined by sniffing each file's own bytes rather than trusting the
filename or client-declared content type; HEIC and MOV — an iPhone's
default photo and video formats — are rejected. Uploaded images are
re-encoded to strip EXIF metadata before storage, so GPS coordinates
embedded in phone photos are never published next to a review. Size and
file-count limits come from the existing `max_media_per_review`,
`max_image_size_mb` and `max_video_size_mb` settings and can be changed from
the admin without a redeploy, underneath a hard transport-layer ceiling
(100MB per file, 20 files per request) that no setting can exceed. Media
uploaded but never attached to a review is deleted automatically by an
hourly sweep job after 24 hours. Approved reviews' media is returned on the
store review-list response and counted in
`/store/products/:id/reviews/stats`'s `media_count`. The review-submission
response (`POST /store/reviews`) returns the newly submitted review's own
media immediately, regardless of its moderation status, since that's the
submitter's own content; media of *other* pending or rejected reviews, and
any item a moderator hides via `hidden_at`, is never returned to anyone
else. `DELETE /admin/reviews/media/:id` lets a moderator remove a single
offensive item — this deletes the stored file itself, not just the
database row, and is irreversible.

**Rejecting a review now permanently deletes its media.** `POST
/admin/reviews/:id/reject` and `POST /admin/reviews/batch/status` (target
status `rejected`) delete every file and `review_media` row attached to a
review the instant it is rejected — the file is removed from storage
itself, not just unlinked from the review, and this cannot be undone.
Approving a review, or resetting one to `pending`, never touches media.
This is a deliberate design decision, not a bug: a reversible alternative
was considered and rejected in favour of actually destroying the content.
The status change always commits first; if media deletion then fails for
some item, the review still stays rejected (never reverted) and the
failure is logged, with the leftover media still reachable through `DELETE
/admin/reviews/media/:id`. This replaces the original Phase 2 behaviour,
which left a rejected review's media in storage indefinitely.

**Known limitation:** no video transcoding and no server-generated poster
frame — video is stored exactly as uploaded, and `thumbnail_url` is always
`null`; storefronts must supply their own poster or use the browser's
native first-frame behaviour. Separately, WebM/Matroska detection reads the
EBML `DocType` element rather than parsing the container fully; a
deliberately crafted Matroska file that plants a fake `DocType` ahead of
the real one can be accepted and stored as `video/webm`, producing a
mislabelled file that may not play. This is not a security bypass — the
format allow-list still limits what is ever stored, and the served
content-type is one the plugin chooses — and closing it needs a full EBML
parser, judged disproportionate for Phase 2. See the README's
[Photo and video uploads](README.md#photo-and-video-uploads) section for
detail on both, plus the note that the upload endpoint currently needs only
a publishable API key (no customer authentication) pending Phase 6 rate
limiting.

Not implemented: the customer gallery API, helpful votes, merchant replies,
review editing.

Phase 1: core review module. Reviews with moderation (approve/reject/bulk),
database-backed settings editable from the admin with no redeploy,
denormalized per-product rating summaries, and the store and admin API
routes (see the README's [API](README.md#api) section for the full list).
Verified-purchase status requires an authenticated customer.

**Withdrawn before release:** an earlier commit on this branch added a
`review`/`product` module link (populated by `createReviewWorkflow` via
`createRemoteLinkStep`). A security review found that Medusa's core
`/store/products` and `/store/products/:id` routes forward the `fields`
query parameter straight into `query.graph`, with no knowledge of this
plugin's field allow-list or its `status: 'approved'` filter. With only a
publishable API key, `fields=*reviews` (or `fields=+reviews.*`) returned
the full raw review row for every linked review, including a guest's email
and unmoderated (`pending`/`rejected`) content. The link was removed before
Phase 1 shipped, since nothing in this release consumed it - Phase 3's
admin UI is the earliest planned consumer, and can reintroduce a link then
with a field policy and an HTTP-level regression test guarding it. See
`integration-tests/http/review-product-link.spec.ts` for that regression
test and its comment for the full detail. **If you ran a pre-release build
of this branch that included the link, see the README's
[Installation](README.md#installation) section for the leftover-table
cleanup an existing database needs.**

**Known limitation:** bulk-moderating reviews that span more than one
product in a single `POST /admin/reviews/batch/status` call only refreshes
the first product's rating summary; the rest keep a stale summary until
their next write. See the README for detail and a workaround.

Phase 0: repository bootstrap. Plugin scaffold, MIT license, CI (lint,
typecheck, plugin build, and an integration job with PostgreSQL across the
supported Medusa minors), changesets release pipeline, and a verified
`plugin:develop` → `plugin:add` loop against a local host application.
