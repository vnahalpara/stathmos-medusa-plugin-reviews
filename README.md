# @stathmos/medusa-plugin-reviews

Product reviews for [Medusa v2](https://medusajs.com) with photo and video
support, a customer media gallery API, merchant replies, helpful votes, and
moderation settings a merchant can change from the admin without a redeploy.

> **Status: pre-release (Phase 1).** The core review module has shipped:
> submitting, listing, moderating and summarizing reviews, plus DB-backed
> settings editable from the admin without a redeploy. **Not yet
> implemented: photo/video media, the customer gallery API, helpful votes,
> merchant replies, and review editing.** Do not install this from npm
> expecting those features. See [API](#api) for what works today and
> [Roadmap](#roadmap) for what's next.

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

Nine endpoints ship in Phase 1:

```
POST   /store/reviews                       Submit a review (guest or customer, per settings)
GET    /store/products/:id/reviews          List a product's approved reviews
GET    /store/products/:id/reviews/stats    Denormalized rating summary + breakdown
GET    /admin/reviews                       List/filter reviews (status, product_id, rating)
POST   /admin/reviews/:id/approve           Approve one review
POST   /admin/reviews/:id/reject            Reject one review, with a reason
POST   /admin/reviews/batch/status          Bulk approve/reject/reset by id
GET    /admin/reviews/settings              Read the current settings
POST   /admin/reviews/settings              Update settings (partial, no redeploy)
```

All three `/store/*` routes 404 outright when the `enabled` setting is off.
Verified-purchase status requires an authenticated customer — matching a
guest's self-supplied email would make the badge forgeable.

**Not implemented in Phase 1:** photo/video media and uploads, the customer
media gallery API, helpful votes, merchant replies, and review editing.
There is no route to edit or delete a review as its author, and no route to
manage media or votes — those are Phases 2–4. See [Roadmap](#roadmap).

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
| 1 | Core module, settings, moderation, stats ✅ ← **you are here** |
| 2 | Media (images + video), uploads, orphan sweep |
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
