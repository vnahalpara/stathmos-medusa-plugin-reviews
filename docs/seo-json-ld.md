# SEO: JSON-LD structured data

This plugin doesn't emit JSON-LD itself — it's a data source, not a
rendering layer — but [storefront-nextjs.md](./storefront-nextjs.md)'s
reference storefront builds `Product`/`AggregateRating`/`Review` structured
data from this plugin's stats and review-list endpoints, verified against
**rendered HTML output**, not just source, using a real product with
reviews and a real product with none. This page documents the exact shapes
so you can reproduce (or adapt) the recipe.

## Where it's built

`app/[countryCode]/(main)/products/[handle]/page.tsx` (test host), inside
`buildProductJsonLd()`, called once per product page render and emitted as
a `<script type="application/ld+json">` tag ahead of the page's own
template markup:

```ts
const jsonLd = await buildProductJsonLd(pricedProduct, params.countryCode)

return (
  <>
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
    <ProductTemplate ... />
  </>
)
```

`buildProductJsonLd()` fetches `getProductReviewStats()` and
`listProductReviews({ sort: "newest", limit: 10 })` in parallel — the same
[data-layer functions](./storefront-nextjs.md#data-layer-srclibdatareviewsts)
every other reviews component uses, so this benefits from the same
`force-cache` + tag-based revalidation as the rest of the reviews UI (see
[revalidation.md](./revalidation.md)).

## The base shape (always present)

```json
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Medusa Shorts",
  "description": "...",
  "image": ["https://.../thumbnail.jpg"],
  "sku": "SHORTS-S-BLACK",
  "url": "https://yourstore.com/us/products/shorts",
  "offers": {
    "@type": "Offer",
    "url": "https://yourstore.com/us/products/shorts",
    "price": 55,
    "priceCurrency": "USD",
    "availability": "https://schema.org/InStock"
  }
}
```

`offers` is present whenever the product has a resolvable price
(`cheapestPrice` from the storefront's own pricing util); it's independent
of reviews entirely and included here only for completeness. `image` and
`sku` are `undefined` (dropped by `JSON.stringify`, not emitted as `null`)
when the product has no thumbnail or the first variant has no SKU.

## `aggregateRating`: only when `reviewCount` would be nonzero

```json
{
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": 3.38,
    "reviewCount": 16,
    "bestRating": 5,
    "worstRating": 1
  }
}
```

**This key is added if and only if `stats.count > 0`:**

```ts
if (stats.count > 0) {
  jsonLd.aggregateRating = {
    "@type": "AggregateRating",
    ratingValue: stats.average,
    reviewCount: stats.count,
    bestRating: 5,
    worstRating: 1,
  }
}
```

For a product with zero reviews, `aggregateRating` is **absent from the
object entirely** — not present with `reviewCount: 0`, not present as
`null`. This was verified against real rendered HTML for both cases: a
product with 14 reviews emitted `aggregateRating` with
`ratingValue: 3.21, reviewCount: 14`; a product with none emitted the base
`Product`/`Offer` shape with no `aggregateRating` key and no `review` key
at all.

**This is a hard rule, not a style preference.** An `AggregateRating` with
`reviewCount: 0` is invalid structured data per schema.org's own
requirements (an aggregate needs at least one rating to aggregate), and
Google Search Central explicitly documents review-snippet structured data
as eligible for a **manual action** when it doesn't reflect genuine
content on the page — fabricating a rating for a product nobody has
reviewed is exactly that failure mode, not a hypothetical one. If you
adapt this recipe, keep the `count > 0` guard; do not "simplify" it into
always emitting `aggregateRating` with a zero fallback.

## `review`: up to 10 individual reviews, newest first

```json
{
  "review": [
    {
      "@type": "Review",
      "author": { "@type": "Person", "name": "Jane D." },
      "datePublished": "2026-08-14T10:22:00.000Z",
      "name": "Great fit",
      "reviewBody": "Runs true to size, holds up well after washing.",
      "reviewRating": {
        "@type": "Rating",
        "ratingValue": 5,
        "bestRating": 5,
        "worstRating": 1
      }
    }
  ]
}
```

Built from the same `listProductReviews({ sort: "newest", limit: 10 })`
call, sliced to the first 10 (`reviews.slice(0, 10)`) as a defensive
double-cap even though the request itself already asked for `limit: 10`.
**Present only when `reviews.length > 0`** — same absent-not-empty pattern
as `aggregateRating`, and for the same reason (an empty `review: []` array
communicates nothing schema.org validators want, and there's no content to
back it).

`author.name` falls back to `"Anonymous"` when `display_name` is null —
matching what actually renders on the page itself, so the structured data
never claims a name the visible page doesn't show. `name` (the review's
own title) is `undefined`/dropped when the review has no title.

**Only approved reviews reach this at all** — `listProductReviews()` calls
the same `GET /store/products/:id/reviews` route every other reviews
component uses, which server-side filters to `status: 'approved'` before
the query ever reaches the database (see
[api-reference.md](./api-reference.md#get-storeproductsidreviews)). There
is no separate, weaker filter for structured data to accidentally bypass.

## Validating your own output

The reference build validated both shapes by expanding the actual emitted
JSON-LD blob against the real `https://schema.org` context with `jsonld.js`
(confirms the document expands cleanly as valid JSON-LD, i.e. every key
resolves against a real schema.org term) rather than eyeballing the JSON.
No fully authoritative *review-rich-results* validator was reachable during
that verification, so treat "expands cleanly under `jsonld.js`" as
necessary, not sufficient — run your own final output through Google's
[Rich Results Test](https://search.google.com/test/rich-results) before
relying on it in production, especially to confirm the `Review`/
`AggregateRating` combination is recognized as a review rich result for
your specific product type.

## What this recipe does not do

- **No `Organization`/`WebSite` top-level structured data** — this recipe
  is scoped to the product page's own `Product`/`AggregateRating`/`Review`
  graph, not site-wide JSON-LD.
- **No JSON-LD on the gallery page** (`/gallery`) — the site-wide UGC wall
  has no natural `Product`/`Review` subject of its own (it spans every
  product), so it emits none. If you want structured data there, you'd be
  building something new, not adapting this recipe.
- **No `image` array on individual `Review` nodes** — schema.org's `Review`
  type supports an `image` property, but the reference build didn't wire
  review media into the JSON-LD (it's already visible as the review's own
  photo/video in the rendered review card). Add it yourself if you want
  review photos to appear in rich results, by mapping each review's
  `media` array (from the same `listProductReviews()` response) onto its
  `Review` node.
