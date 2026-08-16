# Cache revalidation

This plugin caches nothing on the backend side except the gallery route's
`Cache-Control` header. Every other stale-cache risk lives on the
**storefront**, which is expected to cache review reads aggressively (see
[storefront-nextjs.md](./storefront-nextjs.md#data-layer-srclibdatareviewsts) —
every read is `cache: "force-cache"` with a tag). This page is the recipe
for closing the resulting gap: a backend subscriber that reacts to the
plugin's events and POSTs to a storefront route handler that revalidates
exactly the right tags.

Without this recipe, a moderator who rejects a review or hides an
offensive photo watches it stay on the storefront until some cache window
elapses on its own — indefinitely for a tagged fetch nobody revalidates,
or up to ~6 minutes for the gallery route's own `Cache-Control` header
(see [storefront-nextjs.md](./storefront-nextjs.md#6-gallery-cache-worst-case-is-6-minutes-not-1)).

## The three cache tags, pinned verbatim

The storefront's data layer (`src/lib/data/reviews.ts` in the test host)
tags its reads with exactly these three strings, and the revalidation
route handler below must call `revalidateTag()` with the **same** strings
— this is the one place where a typo silently breaks the whole recipe,
since Next.js does no fuzzy matching on tags:

```ts
const reviewsTag = (productId: string) => `reviews-${productId}`
const reviewStatsTag = (productId: string) => `review-stats-${productId}`
const GALLERY_TAG = "review-gallery"
```

`reviews-*` and `review-stats-*` are per-product; `review-gallery` is a
single, store-wide tag (the gallery is not scoped to one product's cache
entry, even when a request filters it by `product_id` — hiding one photo
changes the same cached list for every product that could appear in it).

## The five events, and what each one changes for a shopper

The plugin emits **six** distinct event names in total, but only **five**
are relevant to cache revalidation — `review.created` is the exception,
explained below.

| Event | Fires when | Payload | What it invalidates |
|---|---|---|---|
| `review.approved` | A moderator approves a review, **or** a `require_approval: false` store auto-publishes a submission | `{ id, product_id }` (auto-approve) **or** `{ ids, product_ids }` (moderator action, possibly batched) | `reviews-<product_id>`, `review-stats-<product_id>` |
| `review.rejected` | A moderator rejects a review | `{ ids, product_ids }` | same two tags |
| `review.updated` | An edit changes review text/rating, **or** an edit sends an approved review back to `pending`, **or** a moderator resets a review to `pending` | `{ id, product_id }` (edit) **or** `{ ids, product_ids }` (moderator reset, possibly batched) | same two tags |
| `review.media.curated` | A media item is pinned and/or hidden | `{ id, review_id, product_id }` | `review-gallery`, plus `reviews-<product_id>`/`review-stats-<product_id>` (the media strip on the PDP is part of the same cached page) |
| `review.media.deleted` | A media item is permanently deleted via `DELETE /admin/reviews/media/:id` | `{ id, review_id, product_id }` | same as curation |

`review.created` is **not** in this list on purpose: a freshly created
review is `pending` (unless auto-approved, in which case `review.approved`
already fires for it too — see below) and was never on the storefront to
begin with, so there is nothing to invalidate. Subscribing to it for
revalidation would be a no-op that costs a request on every submission.

**Payload shapes genuinely differ by emitter, and a subscriber must handle
both.** `review.approved` and `review.updated` are each emitted from two
different places in the plugin with two different payload shapes — a
single-review event (`id`/`product_id`, singular) from `create-review.ts`
/`update-review.ts`, and a batch-capable event (`ids`/`product_ids`,
plural arrays) from `moderate-reviews.ts`. This is not an inconsistency to
"fix" in your subscriber — both are real and both need handling. Collect
whichever fields are present:

```ts
type ReviewEventPayload = {
  id?: string
  ids?: string[]
  product_id?: string | null
  product_ids?: string[]
}

function collectProductIds(data: ReviewEventPayload): string[] {
  const ids = [...(data.product_ids ?? []), ...(data.product_id ? [data.product_id] : [])]
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && !!id))]
}
```

### `review.updated` means three different things

Do not assume this event means "the customer edited their review" — it
covers three distinct situations, and a subscriber that only cares about
*why* (as opposed to *what to invalidate*) needs to know this:

1. **An owner's edit** that leaves the review approved (a typo fix, e.g.)
   — text changed, storefront visibility unchanged.
2. **An edit that triggers re-moderation** — under `require_approval`, an
   edit to a previously-approved review sends it back to `pending`,
   removing it from the storefront immediately.
3. **A moderator requeueing an approved review to `pending`** for a second
   look, via `POST /admin/reviews/batch/status` with `status: "pending"`.
   This deliberately does **not** emit `review.rejected` — it used to,
   and that was a real bug (see below), not a cache-invalidation nuance.

Cache invalidation is identical for all three (the tags don't care *why*
a product's reviews changed), which is exactly why this ambiguity was
tolerable to leave in the event name rather than splitting it into three
events. **A subscriber built for anything other than cache
invalidation — a notification email, an audit log — must not assume
`review.updated` means an edit happened.** This plugin's own events are
what a future notification feature would subscribe to, and treating case 3
as "the customer changed something" would be simply wrong.

The `pending` mapping used to be wrong in an earlier build of this
plugin — `moderate-reviews` mapped `status === 'approved' ? approved :
rejected`, so requeueing to `pending` fired `review.rejected`. That was
harmless for cache invalidation (both events happened to invalidate the
same tags) but would have been the wiring that emails a shopper "your
review was rejected" because a moderator wanted a second look at it — a
message that can't be taken back, unlike a stale page. Fixed before this
plugin's revalidation recipe shipped; noted here so nobody reintroduces it
by "simplifying" the event mapping back to a two-way branch.

## `helpful_count` is never revalidated, on purpose

Casting or withdrawing a helpful vote emits **no event at all** — there is
no `review.voted` or similar. This is a deliberate ruling, not a gap to
fill in later:

- Firing cache invalidation on every vote would churn a CDN-cached PDP for
  a number nobody makes a purchasing decision on — unlike a review going
  from `pending` to `approved`, which changes what content exists on the
  page at all.
- The vote button already self-corrects: every response from
  `POST`/`DELETE /store/reviews/:id/vote` carries the authoritative
  `helpful_count`, and [`vote-button.tsx`](./storefront-nextjs.md#helpful-votes-the-one-client-component)
  overwrites its displayed count with that value on every interaction.
  The *shopper who just voted* always sees the correct number; only a
  passive visitor reading a cached page could see a stale one.

**Consequence:** `helpful_count` on a server-rendered, cached review list
can be up to one cache window stale for a visitor who never interacts with
the vote button. This is the accepted trade — see
[storefront-nextjs.md's limitation #4](./storefront-nextjs.md#4-helpful_count-is-not-revalidated)
for the storefront-facing version of this note.

## The recipe: backend subscriber → storefront route handler

### Backend subscriber

A Medusa subscriber (in the **host application**, not this plugin — the
plugin doesn't know your storefront's URL) listens for all five events and
POSTs the affected product ids to the storefront:

```ts
// apps/backend/src/subscribers/revalidate-storefront-reviews.ts
export default async function revalidateStorefrontReviews({
  event: { name: eventName, data },
  container,
}: SubscriberArgs<ReviewEventPayload>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const storefrontUrl = process.env.STOREFRONT_URL
  const secret = process.env.REVIEWS_REVALIDATE_SECRET

  if (!storefrontUrl || !secret) {
    logger.debug(`skipping ${eventName}: STOREFRONT_URL and REVIEWS_REVALIDATE_SECRET must both be set`)
    return
  }

  const productIds = collectProductIds(data)
  if (!productIds.length) return

  try {
    const response = await fetch(`${storefrontUrl}/api/revalidate-reviews`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-revalidate-secret": secret },
      body: JSON.stringify({ event: eventName, product_ids: productIds }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      logger.warn(`storefront answered ${response.status} for ${eventName}; its cached reviews may be stale`)
    }
  } catch (error) {
    logger.warn(`could not reach the storefront for ${eventName}: ${error}`)
  }
}

export const config: SubscriberConfig = {
  event: ["review.approved", "review.rejected", "review.updated", "review.media.curated", "review.media.deleted"],
}
```

**Note what's *not* in that `event` list: `review.created`**, for the
reason given above.

**Failure policy: never take the backend down for a storefront problem.**
A storefront that is offline, slow, or misconfigured must not fail the
workflow that emitted the event — a moderator's approval has already
committed to the database by the time this subscriber runs — and must not
fill logs with stack traces:

- **A missing `STOREFRONT_URL`/secret is a valid, silent deployment
  state** — a headless/admin-only backend with no storefront attached is
  normal, so this logs at `debug`, not `warn`, or it would spam the logs
  on every single moderation action forever.
- **The HTTP call is bounded by a 5-second timeout** (`AbortSignal.timeout`) —
  long enough for a cold Next.js route to respond, short enough that a
  hanging storefront can't pin an event-bus worker.
- **Every failure — a non-2xx response, a timeout, an unreachable host —
  logs one `warn` line and returns, with no stack trace and no rethrow.**
  The worst case of a failed revalidation is a stale page, exactly where
  the store was before this subscriber existed. Retrying is deliberately
  not attempted here; a retry storm against a genuinely dead storefront
  helps nobody and risks pinning the event-bus worker for longer, not
  shorter.

### Storefront route handler

```ts
// apps/storefront/src/app/api/revalidate-reviews/route.ts
export async function POST(request: NextRequest) {
  const expectedSecret = process.env.REVIEWS_REVALIDATE_SECRET

  if (!expectedSecret) {
    return NextResponse.json(
      { revalidated: false, error: "REVIEWS_REVALIDATE_SECRET is not configured" },
      { status: 503 }
    )
  }

  if (!secretMatches(request.headers.get("x-revalidate-secret"), expectedSecret)) {
    return NextResponse.json({ revalidated: false, error: "Unauthorized" }, { status: 401 })
  }

  const productIds = parseProductIds(await request.json().catch(() => null))
  if (!productIds.length) {
    return NextResponse.json({ revalidated: false, error: "product_ids is required" }, { status: 400 })
  }

  const tags = productIds.flatMap((productId) => [reviewsTag(productId), reviewStatsTag(productId)])
  tags.push(GALLERY_TAG)   // store-wide, revalidated once per request regardless of product count

  tags.forEach((tag) => revalidateTag(tag))
  return NextResponse.json({ revalidated: true, tags, now: Date.now() })
}
```

## Why this endpoint needs a shared secret

**An open, unauthenticated revalidation endpoint is a free cache-busting
denial-of-service.** Anyone who knows (or guesses) the URL can loop over
it with a single cheap HTTP client, forcing the storefront to regenerate
the same pages continuously — and every regeneration fans out into real
calls to the Medusa backend, so the attacker applies load to **both**
tiers at once, from one unauthenticated endpoint, with no session, no
account, and no cart required. The cost of getting this wrong isn't a data
leak, which is exactly why it's easy to overlook: the site just gets
slower and the origin gets busier, under load that doesn't obviously trace
back to this one endpoint.

**The secret is sent as a header (`x-revalidate-secret`), not in the body
or query string**, so it never ends up in an access log. Comparison is
**constant-time** (`crypto.timingSafeEqual`, length-checked first since
the function throws on a length mismatch), so the endpoint cannot be used
as a byte-by-byte oracle to recover the secret from response timing.

`REVIEWS_REVALIDATE_SECRET` must be set to the **same value** on both the
backend (where the subscriber sends it) and the storefront (where the
route handler checks it) — generate one with `openssl rand -hex 32` and
put it in both `.env` files.

## It fails closed when the secret is unset

**If `REVIEWS_REVALIDATE_SECRET` is missing on the storefront, the route
handler responds `503` and revalidates nothing — it does not fall open
into an unauthenticated endpoint.** An unconfigured deployment serves
slightly stale reviews (bounded by whatever cache window is in play);
it never trades that for an open cache-busting endpoint. This is the same
"fail loudly toward safety, not toward convenience" posture the plugin
takes with the vote salt (see [settings.md](./settings.md#helpful-vote-configuration-is-deliberately-not-here)) —
a missing secret is a configuration gap to notice and fix, not a
degraded-but-open fallback.

On the backend side, a missing `STOREFRONT_URL` or secret has the same
effect by omission — the subscriber just doesn't call anything (see
[Failure policy](#backend-subscriber) above) — but it doesn't 503 anything,
since there's no request-response cycle on that side to fail.

## Not covered by this recipe

- **`review.settings.updated`** (fired on every `POST /admin/reviews/settings`)
  is **not** in the subscriber's event list and isn't part of this recipe.
  A settings change isn't a per-product cache invalidation — there's no
  `product_id` on the payload to revalidate against, and the effect of a
  setting change (e.g. `enabled: false`) is on future requests' behavior,
  not on the correctness of already-cached data.
- **Merchant reply events** (`review.reply.created`/`review.reply.updated`,
  payload `{ review_id }` — **no `product_id`**, unlike every event in the
  table above) are emitted by the plugin but are not part of this
  revalidation recipe in the reference build. A new or updated reply on an
  approved review changes the same cached `GET /store/products/:id/reviews`
  response the `reviews-<product_id>` tag already covers, so if your
  storefront needs a reply to appear promptly, subscribe to these two
  events yourself — but you'll need to resolve `product_id` from
  `review_id` first (a `listReviews({ id: review_id })` call in your own
  subscriber), since the event itself doesn't carry it. The recipe above
  doesn't wire this up by default, and the missing `product_id` is exactly
  why it's more than a one-line addition.
