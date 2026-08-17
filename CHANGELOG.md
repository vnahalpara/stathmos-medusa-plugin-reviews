# Changelog

All notable changes to this project are documented in this file.

This file is maintained by [changesets](https://github.com/changesets/changesets)
from `v0.1.0` onward — add a changeset with `npm run changeset` rather than
editing released sections by hand.

## Unreleased

Phase 5: a Next.js storefront recipe, JSON-LD structured data, a
cache-revalidation recipe, and the full documentation set
(`docs/storefront-nextjs.md`, `docs/api-reference.md`, `docs/settings.md`,
`docs/seo-json-ld.md`, `docs/revalidation.md`). `src/` changes in this
release are limited to the additive events needed to make the
revalidation recipe correct, and one compensation-correctness fix the new
reply-deletion event exposed — both described below.

**The storefront finding of this phase: helpful votes must be cast from
the shopper's own browser, never routed through a Next.js `"use server"`
action or any other server-side wrapper.** The vote route identifies a
guest voter as `sha256(ip + user-agent + salt)`; called from a server
action, every guest hands the backend the same server IP and Node
`fetch` user-agent, so every guest collapses into one `voter_hash` — the
first guest to vote gets a `201`, everyone else gets a `409` forever, with
nothing logged anywhere. This was proven, not theorised: three simulated
shoppers with different browsers, routed through a throwaway server
action, produced one database row and two `409`s. On a deployment where
an attacker's own requests reach the backend with the same source IP as
the storefront (single-box, docker-compose, shared NAT), the collapsed
identity is also forgeable, letting an attacker withdraw other shoppers'
votes; on a split deployment with its own egress IP it degrades to guest
voting silently not working. Forwarding `X-Forwarded-For` from a server
action is explicitly rejected as a fix — any client can set that header,
making dedup trivially defeatable and letting an attacker forge a chosen
victim's hash. See
[docs/storefront-nextjs.md](docs/storefront-nextjs.md#helpful-votes-must-be-cast-from-the-browser-never-from-a-server-action).

**Several additive events were added to `src/` to make the revalidation
recipe correct, closing gaps found while building the storefront that
consumes them:** `review.updated` now also fires from the edit workflow
(an edit that returns an approved review to `pending` previously left
cached storefronts serving it for the full cache window); `review.approved`
now also fires from `createReviewWorkflow` alongside `review.created` when
a `require_approval: false` store auto-publishes a submission (previously
the one event meaning "this became publicly visible" never fired on
auto-approving stores); `review.media.curated` /
`review.media.deleted` now fire from media curation and deletion (a
moderator hiding or deleting a photo previously had no way to shrink the
gallery route's ~6-minute CDN cache window); and, closing the last gap,
`review.reply.created`/`review.reply.updated` now carry `product_id`
alongside `review_id` (they previously carried only `review_id`, with
nothing for a subscriber to invalidate against), and a new
`review.reply.deleted` event covers a merchant deleting a reply outright —
the same failure `review.media.deleted` had already closed for photos, one
surface over. All additive, no schema change. A moderator resetting a
review to `pending` was also fixed to emit `review.updated` rather than a
wrongly-fired `review.rejected` — these events are what a future
notification feature would subscribe to, and the old mapping would have
emailed a customer "your review was rejected" because a moderator merely
wanted a second look. See [docs/revalidation.md](docs/revalidation.md) for
the full recipe: an events table with an emitter column (two event names
are emitted by more than one workflow, with different payload shapes), all
eight subscribed events, the three cache tags, and why the endpoint fails
closed (503) when its shared secret is unset rather than falling open into
an unauthenticated cache-busting endpoint.

**`deleteReviewReplyStep`'s rollback now restores a deleted reply
verbatim — same id, same `created_at`/`updated_at` — instead of
recreating it as a fresh row.** This compensation path was documented as
lossy from Phase 3 onward but was inert: `deleteReviewReplyWorkflow` had
only one step, so nothing downstream could ever fail and trigger a
rollback. Adding `emitEventStep` for `review.reply.deleted` in this same
phase made it reachable in production for the first time — an event-bus
failure now rolls the delete back for real, on a merchant's actual reply
— so the lossy restore stopped being a documented-but-harmless gap and
became a real one: a reply written months ago would come back stamped
"just now," under a new id anything already holding the old one (an open
admin tab, a log line) would no longer resolve to. Fixed by snapshotting
and re-inserting the full row, verified by a test that backdates a reply
specifically so a timestamp assertion can't pass by the coincidence of
running moments after the original write.

**Limitations documented, not fixed, in this phase** — each is a
deliberate trade-off with its reasoning written down in
[docs/storefront-nextjs.md](docs/storefront-nextjs.md#limitations-stated-plainly):
signed-in shoppers are deduped as guests unless a host configures Medusa
session auth on the backend origin; there is no `voted_by_me` on the
review list (computing it per-viewer would make a public, CDN-cacheable
response per-viewer, and would mean hashing on a read path for guests);
review ownership for the storefront's Edit control is tracked in
`localStorage`, since the store API deliberately never exposes
`customer_id`; `helpful_count` is never revalidated by cache-invalidation
events, since votes emit none on purpose — the vote button self-corrects
from the authoritative count on every interaction instead; `thumbnail_url`
is always `null` in this version, with no video poster generation yet; and
the gallery route's real worst-case cache staleness is ~360 seconds
(`s-maxage=60` + `stale-while-revalidate=300`), not the 60-second figure
in isolation.

JSON-LD: `docs/seo-json-ld.md` documents the `Product`/`AggregateRating`/
`Review` shapes the reference storefront emits, verified against rendered
HTML for both a reviewed and an unreviewed product. `aggregateRating`
(and the `review` array) are present if and only if the product has at
least one review — an `AggregateRating` with `reviewCount: 0` is invalid
structured data and risks a manual action for fabricating a rating nobody
gave.

README: linked the full docs set, and added real screenshots of the
storefront (PDP reviews section, submission form, gallery page) captured
against a live backend with seeded review data. Admin UI screenshots are
explicitly noted as pending, not silently omitted — the bundled admin
dashboard has been built and tested but never rendered in a browser and
screenshotted in this project.

Not implemented: per-endpoint rate limiting (Phase 6).

Phase 4: helpful votes, the customer media gallery API, gallery curation,
and review editing. `review_vote` dedupes a signed-in customer by
`customer_id` and a guest by `voter_hash` (`sha256(ip + user-agent +
salt)`) through two disjoint partial unique indexes in Postgres, not
application code; `POST`/`DELETE /store/reviews/:id/vote` cast and
withdraw a vote on an approved review, a duplicate vote from the same
identity is a 409, and `helpful_count` is maintained by a single atomic
`UPDATE ... increment`, never a read-then-write. Guest dedup is
best-effort and defeatable by rotating IP address and user agent — shipped
anyway because customer-only voting is close to useless on a storefront
where most traffic reading reviews is anonymous, with Phase 6's
per-endpoint rate limiting the actual cost-of-abuse control. The salt is
an operator-level secret configured via this plugin's `voteSalt` option or
the `REVIEW_VOTE_SALT` environment variable (plugin option wins; an
empty-string option counts as unset), deliberately not a merchant-editable
setting, with no default — a store that never configures it gets a loud
failure (a 500) the first time a guest votes, rather than a silently
degraded hash comparable across every installation of this plugin.
`voter_hash` is pseudonymous personal data under GDPR (spec §9).

`GET /store/reviews/gallery` returns media from approved, non-hidden
reviews, product-scoped (`product_id`) or global, filterable by `type`,
paginated with `limit` (default 20, capped at 100) and `offset`, ordered
pinned media first then newest (`pinned_at DESC NULLS LAST, created_at
DESC`), and gated by the `gallery_enabled` setting. Approval and
visibility are re-derived from a live join against `review`, never
trusted from the request. Responses carry `Cache-Control: public,
max-age=0, s-maxage=60, stale-while-revalidate=300` for a shared
cache/CDN. `POST /admin/reviews/media/:id/curation` (`{ pinned?, hidden?
}`, at least one required) pins media to lead the gallery ordering, or
hides it from the gallery and from store-facing review media without
deleting the file — the reversible counterpart to `DELETE
/admin/reviews/media/:id` — and is also available from the admin media
lightbox.

`POST /store/reviews/:id` (`{ rating?, title?, content? }`, at least one
required) lets a signed-in customer edit their own review. A guest
submission has no account to prove ownership, so guests are refused with
an explanatory 403, never a bare 401; editing someone else's review is
refused the same way. Under `require_approval: true`, an edit returns the
review to `pending` and the product's rating summary is recomputed to
exclude it in the same request. **Editing a `rejected` review always lands
in `pending`, even when `require_approval` is `false`**: a customer can
fix a rejected review but cannot republish it themselves, because a
rejection is a specific moderator judgment that a store-wide auto-approval
policy must never be allowed to silently overturn. `title: null` clears a
title, media survives an edit, and `edited_at` is set.

**`allow_edit` now defaults to `true` — but only for a fresh install that
has never saved a settings row.** It shipped `false`, and non-interactive
in the settings UI, in Phases 1–3 specifically because the edit flow did
not exist yet. `mergeSettings()` copies a stored settings value over the
new default, so any store that has saved settings at any point before this
release keeps its stored `false` and must switch `allow_edit` on itself in
Settings → Reviews. This is the safe outcome, not an oversight: it is what
prevents the riskier `allow_edit: true` + `require_approval: false`
pairing from ever appearing silently on upgrade — a store only ends up
with that pairing by explicitly turning both settings on. `gallery_enabled`
now actually gates `GET /store/reviews/gallery`, where in Phases 1–3 it
existed in the settings schema but affected nothing. See the README's
[Admin settings](README.md#admin-settings) table for both.

**Known limitation:** guest vote de-duplication (`voter_hash`) is
best-effort, not tamper-proof — it is defeated by rotating IP address and
user agent, and there is no rate limiting on the vote endpoint until Phase
6. This is a deliberate trade-off, not an oversight: see the README's
[Helpful votes](README.md#helpful-votes) section for the reasoning.

Not implemented: a storefront rendering recipe, JSON-LD structured data,
and per-endpoint rate limiting.

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
