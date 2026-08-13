# Changelog

All notable changes to this project are documented in this file.

This file is maintained by [changesets](https://github.com/changesets/changesets)
from `v0.1.0` onward — add a changeset with `npm run changeset` rather than
editing released sections by hand.

## Unreleased

Phase 1: core review module. Reviews with moderation (approve/reject/bulk),
database-backed settings editable from the admin with no redeploy,
denormalized per-product rating summaries, a `review`/`product` module
link, and the store and admin API routes (see the README's [API](README.md#api)
section for the full list). Verified-purchase status requires an
authenticated customer.

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
