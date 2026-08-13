# Changelog

All notable changes to this project are documented in this file.

This file is maintained by [changesets](https://github.com/changesets/changesets)
from `v0.1.0` onward — add a changeset with `npm run changeset` rather than
editing released sections by hand.

## Unreleased

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

Not implemented: photo/video media, the customer gallery API, helpful
votes, merchant replies, review editing.

Phase 0: repository bootstrap. Plugin scaffold, MIT license, CI (lint,
typecheck, plugin build, and an integration job with PostgreSQL across the
supported Medusa minors), changesets release pipeline, and a verified
`plugin:develop` → `plugin:add` loop against a local host application.
