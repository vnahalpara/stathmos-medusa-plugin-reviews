# @stathmos/medusa-plugin-reviews

Product reviews for [Medusa v2](https://medusajs.com) with photo and video
support, a customer media gallery API, merchant replies, helpful votes, and
moderation settings a merchant can change from the admin without a redeploy.

> **Status: pre-release (Phase 0).** The package is scaffolded and the build
> and release pipeline work, but no review functionality has shipped yet. Do
> not install this from npm expecting a working plugin. See
> [Roadmap](#roadmap).

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
| 0 | Repo bootstrap, CI, release pipeline ← **you are here** |
| 1 | Core module, settings, moderation, stats |
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
