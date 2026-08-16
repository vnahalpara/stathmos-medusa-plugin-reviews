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

## The nine events, and what each one changes for a shopper

The plugin emits **ten** distinct event names in total. One,
`review.settings.updated`, is a different category entirely (no product
scope, empty payload — see [Not covered by this recipe](#not-covered-by-this-recipe))
and is set aside from the count below. Of the remaining **nine**, **eight**
are subscribed for cache revalidation — `review.created` is the one
exception, explained after the table.

**Every event carries one of three payload shapes**, and which shape a
given event uses depends on *where in the plugin it's emitted from*, not
just its name:

- **Singular row-level** — `{ id[, product_id] }`: one review changed,
  identified by its own id.
- **Batch** — `{ ids, product_ids }`: a moderation action that can span
  several reviews (and therefore several products) in one call.
- **Relation-level** — `{ [id,] review_id, product_id }`: something
  attached to a review (its media, its merchant reply) changed; `id` is
  present when the changed thing has its own id (a media row) and absent
  when it doesn't (a reply row, which is one-per-review with no id of its
  own in the public payload).

**Two event names are emitted by more than one workflow, with two
different shapes.** `review.approved` and `review.updated` each have a
*singular* emitter and a *batch* emitter — this is not an inconsistency to
fix in your subscriber; both are real, and a subscriber has to handle
whichever shape actually arrives. This table lists every emitter of every
event separately, specifically so that trap is visible rather than
flattened into one misleading row per event name:

| Event | Emitted by (workflow) | Fires when | Payload |
|---|---|---|---|
| `review.created` | `create-review.ts` (`createReviewWorkflow`) | Every submission, regardless of status | `{ id }` — no `product_id` |
| `review.approved` | `create-review.ts` (`createReviewWorkflow`) | A `require_approval: false` store auto-publishes a submission | `{ id, product_id }` |
| `review.approved` | `moderate-reviews.ts` (`moderateReviewsWorkflow`) | A moderator approves one or more reviews | `{ ids, product_ids }` |
| `review.rejected` | `moderate-reviews.ts` (`moderateReviewsWorkflow`) | A moderator rejects one or more reviews | `{ ids, product_ids }` |
| `review.updated` | `update-review.ts` (`updateReviewWorkflow`) | The owner edits their own review | `{ id, product_id }` |
| `review.updated` | `moderate-reviews.ts` (`moderateReviewsWorkflow`) | A moderator requeues one or more approved reviews to `pending` | `{ ids, product_ids }` |
| `review.media.curated` | `curate-review-media.ts` (`curateReviewMediaWorkflow`) | A media item is pinned and/or hidden | `{ id, review_id, product_id }` |
| `review.media.deleted` | `delete-review-media.ts` (`deleteReviewMediaWorkflow`) | A media item is permanently deleted via `DELETE /admin/reviews/media/:id` | `{ id, review_id, product_id }` |
| `review.reply.created` | `reply-to-review.ts` (`replyToReviewWorkflow`) | The first reply is posted to a review | `{ review_id, product_id }` |
| `review.reply.updated` | `reply-to-review.ts` (`replyToReviewWorkflow`) | An existing reply is edited | `{ review_id, product_id }` |
| `review.reply.deleted` | `delete-review-reply.ts` (`deleteReviewReplyWorkflow`) | A reply is deleted | `{ review_id, product_id }` |

**What every one of these (except `review.created`) invalidates, in
practice: all of it, every time — not a tag subset tailored to the event.**
The storefront route handler ([below](#storefront-route-handler)) doesn't
branch on the event name at all; every call that carries at least one
product id revalidates `reviews-<product_id>` **and**
`review-stats-<product_id>` for every product id given, **and** the global
`review-gallery` tag, unconditionally — even for, say, a reply edit, which
changes nothing about the gallery or the rating stats. This is simpler
than it might look like it should be, and deliberately so: the handler
would otherwise need its own copy of "which event affects which tag,"
duplicating exactly the kind of knowledge this table exists to centralize,
for a save that's a handful of extra `revalidateTag()` calls Next.js
already dedupes for free within one request.

`review.created` is **not** subscribed for revalidation, on purpose: a
freshly created review is `pending` (unless auto-approved, in which case
`review.approved` already fires for it too — see the table above) and was
never on the storefront to begin with, so there is nothing to invalidate.
Subscribing to it would be a no-op that costs a request on every
submission.

A subscriber collecting product ids across all of the shapes above needs
to handle every field that might be present:

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
plugin doesn't know your storefront's URL) listens for all eight
subscribed events and POSTs the affected product ids to the storefront:

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
  event: [
    "review.approved",
    "review.rejected",
    "review.updated",
    "review.media.curated",
    "review.media.deleted",
    "review.reply.created",
    "review.reply.updated",
    "review.reply.deleted",
  ],
}
```

This is the exact list from the reference subscriber
(`apps/backend/src/subscribers/revalidate-storefront-reviews.ts` in the
test host) — treat that file as the source of truth if this list and the
file ever disagree.

**Note what's *not* in that `event` list: `review.created`** (and, in a
different way, `review.settings.updated` — see
[Not covered by this recipe](#not-covered-by-this-recipe)), for the
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

- **`review.settings.updated`** (fired on every `POST /admin/reviews/settings`,
  payload `{}`) is **not** in the subscriber's event list and isn't part of
  this recipe. A settings change isn't a per-product cache invalidation —
  there's no `product_id` on the payload to revalidate against (there
  couldn't be one; a settings row isn't scoped to a product at all), and
  the effect of a setting change (e.g. `enabled: false`) is on future
  requests' behavior, not on the correctness of already-cached data.

Merchant reply events (`review.reply.created`, `review.reply.updated`,
`review.reply.deleted`) **used to** be missing from this list for a
similar-sounding but different reason — their payload originally carried
only `review_id`, with no `product_id` for a subscriber to act on, and
`review.reply.deleted` didn't exist at all. Both gaps were closed before
this recipe shipped (`upsertReviewReplyStep`/`deleteReviewReplyStep` now
resolve and return the parent review's `product_id`, at no extra query
cost — the review was already being loaded for an existence check either
way). All three reply events are subscribed and revalidate normally; see
the [events table](#the-nine-events-and-what-each-one-changes-for-a-shopper)
above. If you're looking at a build of this plugin from before that
change, you'll need to resolve `product_id` from `review_id` yourself
(a `listReviews({ id: review_id })` call) before these three events are
usable for revalidation — but on current `main`, no such workaround is
needed.
