# Next.js storefront recipe

> ⚠️ **Read this before you wire up helpful votes.** Cast and withdraw
> votes with a plain `fetch()` issued by the shopper's own **browser** —
> never from a Next.js `"use server"` action, a route handler, or any
> other server-side wrapper. Getting this wrong produces **no error at
> all**: just guest voting that quietly stops working after the first
> vote, forever, with nothing logged anywhere. See
> [Helpful votes must be cast from the browser](#helpful-votes-must-be-cast-from-the-browser-never-from-a-server-action)
> below for why, and exactly how bad it is on your deployment.

This is the storefront-side recipe for `@stathmos/medusa-plugin-reviews`,
extracted from a real build against a Medusa v2 Next.js starter — the test
host at `apps/storefront/src/modules/reviews/` and
`apps/storefront/src/lib/data/reviews.ts` in this plugin's development
repository. Every component described here was built, run against a live
backend, and verified with real HTTP requests and (for the vote flow) real
browser sessions before this page was written. Where this recipe depends on
something specific to that starter (its UI kit, its TypeScript setup, its
auth cookie handling), it says so — see
[Where your storefront will differ](#where-your-storefront-will-differ).

## Helpful votes must be cast from the browser, never from a server action

**This is the single most important rule in this document, and getting it
wrong produces no error at all — just guest voting that quietly stops
working after the first vote, forever, with nothing logged anywhere.**

The plugin identifies a **guest** voter as
`sha256(ip + user-agent + salt)` (see [`POST /store/reviews/:id/vote`](./api-reference.md#post-store-reviewsidvote)
and `src/settings/voter-hash.ts` in the plugin). If your storefront casts
that vote through a Next.js `"use server"` action, a route handler, or any
other server-side wrapper, the backend sees **your Next.js server's own IP
address and a Node `fetch` user-agent** — identical for every shopper who
visits your site. Every guest collapses into the exact same `voter_hash`.
The first guest to vote on a review gets a `201`; every other guest, on
every review, store-wide, gets a `409` forever. Nothing throws, nothing is
logged as an error — the feature just silently stops working.

**This was proven, not theorised.** Three simulated shoppers with
different browsers, voting through a throwaway server action, produced
**one** database row and **two** `409` responses — the backend never saw
any of the three real browsers, only the one Node process making the
requests on their behalf.

**The fix:** cast and withdraw votes with a plain client-side `fetch()`,
issued by the shopper's own browser directly against the Medusa backend —
never routed through your Next.js server. See [Helpful votes: the one
client component](#helpful-votes-the-one-client-component) below for the
actual code.

### How bad is this, precisely?

The severity depends on your deployment topology, and the honest answer is
worse in one case than the other:

- **Single-box, docker-compose, or any deployment where the storefront and
  an attacker's own requests can reach the backend with the same source
  IP** (shared NAT, a reverse proxy that doesn't forward a distinguishable
  client IP, etc.) — common in dev, staging, and small self-hosted stores.
  Here the collapsed identity is not just *shared*, it is **forgeable**:
  since source IPs cannot be spoofed over TCP, an attacker who can make a
  request from the same IP as your storefront's own outbound traffic can
  reconstruct the exact hash your server would produce and **withdraw
  other shoppers' votes on purpose**.
- **A split deployment where the storefront has its own distinct egress
  IP** (most production setups — Vercel, a separate app server, a CDN in
  front of a backend on its own host) — an outside attacker cannot forge
  your storefront's source IP over TCP, so this degrades to the milder
  failure: **guest voting silently stops working** (one voter wins, every
  other guest gets a `409`), not votes being erasable by an arbitrary
  attacker.

Either way, routing votes through a server action is a bug, not a
trade-off — there is no version of this that is fine to ship. But be
precise about which failure mode you're actually exposed to before you
decide how urgently to fix it; a blanket "votes are remotely erasable by
anyone" claim overstates the split-deployment case and gets discounted by
readers as a result, which is worse than a claim that's merely alarming.

### Do not "fix" this by forwarding `X-Forwarded-For` instead

It is tempting to keep the vote call in a server action and just forward
the shopper's real IP via a custom header. **Don't.** Any client can set
`X-Forwarded-For` on a request to your own Next.js server — there is
nothing stopping a shopper (or an attacker) from sending
`X-Forwarded-For: 1.2.3.4` and having your server action dutifully forward
it. That makes dedup **trivially defeatable** (spoof a new IP, get a new
`voter_hash`, vote again) and, worse, lets an attacker **forge a chosen
victim's hash** by sending the victim's real IP and user-agent, then
withdrawing the victim's vote on purpose. A spoofable header is worse than
an honest limitation — it looks fixed while making the security property
strictly worse.

The only correct fix is the one above: the browser talks to the backend
directly.

## Architecture

Every review read runs through a `"use server"` data module
(`src/lib/data/reviews.ts` in the test host) that wraps Medusa's `sdk`
client, exactly like every other data-fetching module in a Medusa v2
Next.js starter. Every review *write* except voting also runs through that
same server module, because submitting a review, uploading media, and
editing your own review are all safe to attribute via the shopper's real
session cookie — see [Why voting is different](#why-voting-is-different-from-every-other-write)
below. Voting is the **one** exception: a plain client component issuing
its own `fetch()`.

```
apps/storefront/src/lib/data/reviews.ts        "use server" — every read + every write except voting
apps/storefront/src/modules/reviews/
  components/
    rating-stars.tsx                            server component, partial-fill star display
    review-summary.tsx                           server component, average + 5→1 breakdown
    review-list.tsx                               server component, sort + pagination (plain links)
    review-card.tsx                                server component; mounts VoteButton + EditReviewForm
    review-form.tsx                                 client component, the submission form
    media-uploader.tsx                                client component, photo/video picker
    edit-review-form.tsx                              client component, in-place review editing
    vote-button.tsx                                    client component — THE ONE THAT MUST FETCH ITSELF
    gallery-grid.tsx                                 server component, empty-state / hands off to lightbox
    gallery-lightbox.tsx                              client component, grid + modal viewer
  lib/
    own-reviews.ts                                localStorage "is this my review?" tracker
  templates/
    product-reviews.tsx                          assembles the PDP reviews section
app/[countryCode]/(main)/products/[handle]/page.tsx   mounts ProductReviews + emits JSON-LD (see seo-json-ld.md)
app/[countryCode]/(main)/gallery/page.tsx             the site-wide UGC wall
app/api/revalidate-reviews/route.ts                   cache invalidation endpoint (see revalidation.md)
```

Almost the entire subtree is server components. The **only** two
`"use client"` boundaries under `modules/reviews/components/` that exist
out of hard necessity are `vote-button.tsx` (must run in the browser — see
above) and `gallery-lightbox.tsx` (needs interactivity for the modal).
`review-form.tsx`, `media-uploader.tsx`, and `edit-review-form.tsx` are
client components because they're forms with local state, not because of
anything reviews-specific.

### Why voting is different from every other write

It's worth being explicit about why `submitReview()` and `updateReview()`
are safe as `"use server"` actions while `vote` is not, because the
distinction is easy to blur:

- **Submitting or editing a review** attributes the action to a
  *signed-in customer* via the real session/JWT `getAuthHeaders()`
  forwards — the same ordinary session-forwarding every other authenticated
  write in a Medusa storefront already does. A guest (no session) is
  refused outright by the backend for editing; there is no anonymous edit
  path to protect. Nothing about the request depends on IP or user-agent.
- **Voting as a guest** is identified by the backend from network
  metadata — `req.ip` and `req.headers['user-agent']` — precisely because
  there's no session to key off. That metadata belongs to whoever makes
  the TCP connection. Routed through a server action, that's your Next.js
  server, for every shopper, every time.

## Data layer (`src/lib/data/reviews.ts`)

Every read is `cache: "force-cache"` with a `next: { tags: [...] }` tag,
using **three pinned tag strings** — not run through the starter's usual
`getCacheOptions()`/`getCacheTag()` helpers:

```ts
const reviewsTag = (productId: string) => `reviews-${productId}`
const reviewStatsTag = (productId: string) => `review-stats-${productId}`
const GALLERY_TAG = "review-gallery"
```

This is deliberate, not an oversight. `getCacheOptions()`/`getCacheTag()`
suffix a tag with the visitor's `_medusa_cache_id` cookie, which is correct
for per-session data like a cart, but **wrong here**: review data is
public and identical for every visitor, so a session-scoped tag would
fragment the cache per shopper for no reason *and* stop matching what the
[revalidation recipe](./revalidation.md) calls `revalidateTag()` with.
Reuse these exact three strings — [`docs/revalidation.md`](./revalidation.md)
revalidates against them verbatim.

```ts
export const listProductReviews = async ({
  productId, sort, page = 1, limit = 10, rating, verified,
}: { /* … */ }) => {
  const offset = (Math.max(page, 1) - 1) * limit
  const headers = { ...(await getAuthHeaders()) }

  try {
    const { reviews, count } = await sdk.client.fetch<{ /* … */ }>(
      `/store/products/${productId}/reviews`,
      {
        method: "GET",
        query: { limit, offset, ...(sort ? { sort } : {}), /* … */ },
        headers,
        next: { tags: [reviewsTag(productId)] },
        cache: "force-cache",
      }
    )
    return { reviews, count, nextPage: count > offset + limit ? page + 1 : null }
  } catch (error) {
    // 404 (reviews disabled store-wide) becomes an empty page, not a thrown
    // error — a product with zero reviews is NOT this case, the backend
    // returns 200 with count: 0 for that.
    if (isNotFound(error)) return { reviews: [], count: 0, nextPage: null }
    throw error
  }
}
```

The same 404-becomes-empty pattern is used by `getProductReviewStats()`
(returns a zeroed summary) and `listGalleryMedia()` (returns
`{ media: [], count: 0 }`). This lets a PDP or the gallery page render an
empty state instead of an error page when reviews or the gallery are
switched off store-wide, without the caller having to special-case a 404.

`listGalleryMedia()` reads the response as a **flat** `{ media, count }`
shape — confirmed against `src/api/store/reviews/gallery/route.ts` in the
plugin, which really does respond flat. If you're working from an older
sketch of the API that shows a nested `items` shape, that sketch is wrong;
trust the [API reference](./api-reference.md), which was checked line by
line against source.

`submitReview()`, `uploadReviewMedia()`, and `updateReview()` all return a
readable `{ success: false, error, status? }` on failure rather than
throwing — every documented failure mode (reviews disabled, content too
short/long, guest submissions disallowed, verified-purchase-only, already
reviewed, `allow_edit` off, editing someone else's review) surfaces as a
message a form can render, not an unhandled exception.

## Component recipe

### PDP integration (`templates/product-reviews.tsx`)

The reviews section is a single async server component, mounted from the
product page:

```ts
// app/[countryCode]/(main)/products/[handle]/page.tsx
<ProductTemplate ... />
// inside ProductTemplate → templates/product-reviews.tsx:
export default async function ProductReviews({ productId, productHandle, searchParams }) {
  const sort = parseSort(searchParams.reviewsSort)
  const page = parsePage(searchParams.reviewsPage)

  const [stats, { reviews, count }, customer, { media: stripMedia }] = await Promise.all([
    getProductReviewStats(productId),
    listProductReviews({ productId, sort, page, limit: 10 }),
    retrieveCustomer(),
    listGalleryMedia({ productId, limit: 8 }),
  ])
  // ...renders ReviewSummary + ReviewList when stats.count > 0,
  // an empty-state prompt otherwise, a photo strip when the product has
  // gallery media, and ReviewForm always.
}
```

Sort (`newest` | `highest` | `lowest` | `most_helpful`) and pagination are
read off the PDP's own `searchParams` (`?reviewsSort=…&reviewsPage=…`) and
rendered as plain `<a href>` links in `review-list.tsx` — **not client
state**. Changing sort or page is an ordinary navigation the server
re-renders for; no client JS is needed for either. The whole subtree stays
server-rendered except the two islands noted above.

The customer id from `retrieveCustomer()` (server-side) is threaded down
to every `<ReviewCard>` purely so `<EditReviewForm>` can decide, client-side,
whether *this specific* review belongs to the signed-in shopper — see
[Review ownership is client-side](#review-ownership-for-the-edit-control-is-client-side)
below.

### Review summary and cards

`review-summary.tsx` renders the average, star display, and a 5★→1★
breakdown with percentage-width bars — only ever rendered when
`stats.count > 0` (the empty state is a separate branch in
`product-reviews.tsx`). `rating-stars.tsx` renders a fractional fill via a
percentage-clipped overlay rather than rounding, so a 3.21 average doesn't
draw identically to a 3.5.

`review-card.tsx` renders one approved review: rating, verified badge,
title, content, media thumbnails (linking out to the full-size file),
reviewer name, an `edited_at` marker when the review was edited after
publishing, the merchant reply when present, and mounts `<VoteButton>` and
`<EditReviewForm>` — the two client islands. The card itself stays a
server component.

### Submission form (`review-form.tsx` + `media-uploader.tsx`)

A plain `onSubmit` handler (not `useActionState` — this form needs to hold
the submit button while `MediaUploader` still has an upload in flight,
state that has to live in the form regardless of how the submit call
itself is wired) builds a `FormData` and calls the `submitReview()` server
action:

```ts
const formData = new FormData()
formData.set("product_id", productId)
formData.set("rating", String(rating))
formData.set("content", content.trim())
if (title.trim()) formData.set("title", title.trim())
if (displayName.trim()) formData.set("display_name", displayName.trim())
if (!isSignedIn && email.trim()) formData.set("email", email.trim())
mediaState.mediaIds.forEach((id) => formData.append("media_ids", id))

const result = await submitReview(formData)
```

The success message is read from the **response's own `status`** field
(`"approved"` vs anything else), never a hardcoded string — this
storefront cannot read the `require_approval` setting (there is no public
settings endpoint, by design; see [settings.md](./settings.md)), so the
UI has to trust what the API actually did, not guess it.

Field-level error mapping is done by matching the exact message strings
the backend returns (`classifyError()` in `review-form.tsx`), not by
status code alone — several distinct failures share a status (both
"already reviewed this product" and "verified purchase only" are 400s),
and only the message text tells them apart.

`media-uploader.tsx` uploads each picked file immediately, one file per
call to `uploadReviewMedia()` (`POST /store/reviews/uploads`), so one bad
file only fails its own thumbnail rather than blocking the batch. It
deliberately does **not** enforce `max_media_per_review` or any other
media setting client-side — none of them have a public read endpoint, so
there's no correct number to check against locally. Rejections come back
from the server and render on the offending file's own thumbnail.

### Helpful votes: the one client component

This is the code the [warning at the top of this document](#helpful-votes-must-be-cast-from-the-browser-never-from-a-server-action)
protects. The whole point is this `fetch()` call, verbatim:

```ts
// vote-button.tsx — "use client"
const BACKEND_URL = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL ?? "http://localhost:9000"
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY

const sendVote = async (method: "POST" | "DELETE") => {
  // MUST be issued by the shopper's own browser. Never move this into a
  // "use server" action or a route handler — see the module docstring.
  return fetch(`${BACKEND_URL}/store/reviews/${reviewId}/vote`, {
    method,
    credentials: "include",
    headers: PUBLISHABLE_KEY ? { "x-publishable-api-key": PUBLISHABLE_KEY } : {},
  })
}
```

Three things about this call matter:

1. **It talks to the Medusa backend origin directly** (`NEXT_PUBLIC_MEDUSA_BACKEND_URL`),
   not a Next.js route on the storefront's own origin. There is no server
   hop for the vote itself to be laundered through.
2. **`credentials: "include"`** is what keeps a *signed-in* shopper out of
   the guest-hashing path. The vote route runs
   `authenticate('customer', ['session', 'bearer'], { allowUnauthenticated: true })`,
   and the route resolves identity from `req.auth_context.actor_id` before
   it ever computes a hash — so if the browser has a Medusa session
   cookie for the backend origin, the customer is deduped by `customer_id`
   and never fingerprinted at all. See
   [Signed-in shoppers are deduped as guests](#1-signed-in-shoppers-are-deduped-as-guests-by-default)
   below for why this often doesn't apply out of the box.
3. **The response's own `helpful_count` is authoritative.** The button
   moves the displayed count optimistically on click, then overwrites it
   with whatever `helpful_count` the response actually carries — never
   trusting client-side arithmetic. A `409` on a fresh click means "you
   already voted" and flips the button into a withdraw state instead of
   showing an error; a `404` on a withdraw means "no vote on record" and
   quietly settles into the not-voted state instead of accusing the
   shopper of anything.

`review-card.tsx` passes `initialCount={review.helpful_count}` — the count
the server rendered — and every value after that comes only from a vote
response's own count, never from client-side math on the initial one.

### Review editing (`edit-review-form.tsx` + `own-reviews.ts`)

#### Review ownership for the edit control is client-side

The store API **deliberately never exposes `customer_id`** on a review —
a public review list must not leak who wrote what, and the plugin's
response allow-lists every field for exactly this reason (see
[api-reference.md](./api-reference.md)). That means this storefront has no
server-provided signal for "is this my review?" — the one thing
`edit-review-form.tsx` needs to decide whether to show an Edit control at
all.

The only moment the storefront legitimately learns a review id belongs to
the signed-in customer is the response to their **own** authenticated
`submitReview()`/`updateReview()` call — both go through the real
session/JWT, so a returned review id is provably theirs. `own-reviews.ts`
remembers that id in `localStorage`, scoped per customer id:

```ts
// modules/reviews/lib/own-reviews.ts
export function rememberOwnReview(customerId: string | null, reviewId: string): void {
  if (!customerId || typeof window === "undefined") return
  // ...appends reviewId to localStorage["medusa-reviews-mine:" + customerId]
}

export function isOwnReview(customerId: string | null, reviewId: string): boolean {
  if (!customerId) return false
  return readIds(customerId).includes(reviewId)
}
```

`edit-review-form.tsx` checks this in a `useEffect` (not during render, to
avoid a hydration mismatch — both the server-rendered HTML and the
client's first render produce nothing), and only reveals the Edit control
once the effect confirms `localStorage` says this review is the shopper's
own.

**This fails in the safe direction.** A review edited or submitted from a
different browser, or written before this feature existed, simply never
shows an Edit control there — nothing is ever shown as editable when it
isn't, but a shopper who switches devices loses the control until they
edit again from the new device. If you need cross-device ownership, you
would need to build a server-side "is this mine" signal yourself; the
plugin doesn't provide one, on purpose (see the store API's field
allow-list reasoning above).

The `allow_edit` setting has **no public read endpoint** — there is
nothing for this storefront to check up front. `updateReview()`'s
`{ success: false, status: 400 }` response *is* the settings check: the
edit control turns itself off (see `classifyUpdateError()`'s `disable`
branch) the first time the backend actually says editing is off, rather
than trying to predict the setting from the client.

### Gallery (`gallery-grid.tsx` + `gallery-lightbox.tsx`)

Two mount points share the same components: a product-scoped photo strip
on the PDP (`STRIP_MEDIA_LIMIT = 8`, well under the gallery route's
default `limit` and its documented `GALLERY_MAX_LIMIT` of 100) and the
site-wide wall at `/gallery` (`GALLERY_PAGE_SIZE = 24`). Both call
`listGalleryMedia()`; the site-wide page also resolves the handful of
distinct products a page of media belongs to in one batched
`listProducts()` call, never one lookup per tile.

`gallery-grid.tsx` decides between an empty state and handing off to
`gallery-lightbox.tsx`, the **only** `"use client"` boundary in the
gallery subtree — it owns the tile grid and the modal together, not
split further, because this codebase's `@types/react` setup fails `tsc`
on `Context.Provider` used as JSX (the same pre-existing `forwardRef`
TS2786 issue noted throughout this module — see
[Where your storefront will differ](#where-your-storefront-will-differ)).

**`thumbnail_url` is always `null` in this plugin version.** Nothing
generates a poster frame for video yet (no ffmpeg pipeline exists in this
release). `gallery-lightbox.tsx` handles the null correctly — grid tiles
for video render a plain gray box with a play icon overlay instead of an
`<img>`, and the lightbox's actual `<video>` element gets no `poster`
attribute, falling back to the browser's native first-frame behaviour. If
your storefront wants a real poster image, you have to generate and
attach one yourself; do not build a gallery UI that assumes
`thumbnail_url` will eventually be populated by the plugin — it isn't, in
this version.

**Gallery cache worst case is about six minutes, not one.** The gallery
route responds with
`Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=300`.
`s-maxage=60` bounds freshness at a shared cache/CDN to 60 seconds, but
`stale-while-revalidate=300` then authorizes that same cache to keep
serving its last copy for up to a further 300 seconds while it
revalidates in the background. The real worst case for a moderator hiding
an offensive photo to actually stop being served from a CDN is therefore
**~360 seconds (~6 minutes)**, not the 60-second `s-maxage` figure alone.
See [docs/revalidation.md](./revalidation.md) for how the `review.media.curated`
and `review.media.deleted` events shrink this in practice for hosts that
wire up the revalidation recipe — the CDN-level worst case above is what
you're bounded by if you don't.

## Limitations, stated plainly

Every item below was found by building this storefront against a live
backend, not anticipated in the abstract. Treat this section as load-bearing,
not a footnote.

### 1. Signed-in shoppers are deduped as guests, by default

`vote-button.tsx`'s `credentials: "include"` only helps if the browser
actually holds a Medusa **session** cookie for the backend origin. The
Medusa Next.js starter this recipe was built against does **not**
establish one by default — it keeps the customer JWT `httpOnly` on the
storefront's **own** origin (`setAuthToken` in `@lib/data/cookies`),
specifically so page scripts can't read it. `credentials: "include"` sends
whatever cookie exists for the backend's origin, and by default there
isn't one.

**Consequence:** a signed-in shopper's vote is deduped by their own IP +
user-agent, exactly like a guest's — correct per-shopper dedup, but with
no cross-device vote withdrawal and the same NAT-collision risk a guest
has.

**The fix, if you want customer-attributed votes:** configure Medusa
session auth on the backend origin (`auth: { type: "session" }` in your
SDK config, plus a `POST /auth/session` call after login to establish the
session cookie) so the browser has something for `credentials: "include"`
to actually send. This plugin does not do this for you — it's a storefront
auth decision, not a reviews-plugin one, and the trade-off (exposing more
about the auth flow vs. gaining vote attribution) is the host's to make.

Do **not** "fix" this by exposing the JWT to client script instead — that
trades an XSS-proof session for a vote button, a strictly worse trade.

### 2. No `voted_by_me` on the review list

`GET /store/products/:id/reviews` does not tell you which reviews the
current viewer has already voted on. This is deliberate, not an oversight:
computing it per-viewer would make a **public, CDN-cacheable** response
per-viewer instead — the whole reason the list is cacheable at all is that
it's identical for every visitor — and for a guest specifically it would
mean computing a `voterHash()` on a **read** path, which is a strictly
worse trade than the alternative.

**Consequence:** after a page reload, the vote button doesn't know it was
already voted on. The first click after a reload gets a `409`, which
`vote-button.tsx` correctly renders as "you already found this helpful"
rather than an error — but it costs the shopper an extra click to reach
the withdraw state.

**Recommendation:** if this matters for your storefront, remember voted
review ids in `localStorage` from each vote response (the same pattern
`own-reviews.ts` uses for edit ownership) and pre-seed the button's
initial state from that on mount. No server cost, no cache impact.

### 3. Review ownership for the edit control is client-side

Covered in full [above](#review-ownership-for-the-edit-control-is-client-side).
Restated briefly here because it's a limitation, not just a design note:
the Edit control only appears on the browser that submitted or last
edited the review, because the store API never exposes `customer_id`.
Fails safe — a stale or absent "mine" signal just means the control
doesn't show, never that the wrong person can edit.

### 4. `helpful_count` is not revalidated

Casting or withdrawing a vote emits **no event**, on purpose — see
[docs/revalidation.md](./revalidation.md#helpful_count-is-never-revalidated-on-purpose)
for the reasoning. `helpful_count` on a cached, server-rendered review
list can therefore be up to one ISR/cache window stale for a **passive**
visitor who never interacts with the vote button. The button itself is
always correct the moment a shopper actually clicks it, because it
replaces its displayed count with the response's own authoritative value
on every interaction — it self-corrects, it just doesn't proactively push
a correction to everyone else's cached page.

### 5. `thumbnail_url` is always `null` in this version

Covered [above](#gallery-grid-tsx--gallery-lightbox-tsx). No video poster
generation exists in this plugin release. Supply your own poster image at
render time if you need one; don't build a UI that assumes the plugin will
someday populate this field for existing data — you would need to
backfill it yourself even after a future plugin version adds poster
generation, since it would only apply going forward.

### 6. Gallery cache worst case is ~6 minutes, not 1

Covered [above](#gallery-grid-tsx--gallery-lightbox-tsx) — `s-maxage=60`
plus `stale-while-revalidate=300` composes to a ~360 second worst case at
a shared cache/CDN, not the 60-second figure in isolation.

### 7. `allow_edit`'s `true` default only reaches fresh installs

This is a **settings** behaviour, documented in full in
[docs/settings.md](./settings.md#allow_edit), but it affects this
storefront's edit control directly: on a store that saved a settings row
at any point before this plugin's edit feature shipped, `allow_edit`
stays `false` until a merchant explicitly turns it on, even though the
plugin's own default is now `true`. The storefront has no way to detect
this in advance (no public settings read) — the edit control simply never
appears for that store's shoppers until the merchant flips the switch,
which is the intended, safe behaviour, not a bug in this recipe.

### 8. `review.updated` covers three distinct situations

Documented in full in
[docs/revalidation.md](./revalidation.md#reviewupdated-means-three-different-things).
Relevant to a storefront author only if you build your own event
subscriber beyond the revalidation recipe (e.g. a notification feature):
do not assume `review.updated` means "the customer edited their review" —
it also fires when a moderator sends an approved review back to `pending`,
and when an edit under `require_approval` does the same thing
automatically.

### 9. Guest vote dedup is best-effort and defeatable

Even with the browser-only fix in place, `voter_hash` is derived from IP
+ user-agent, both of which a determined actor can rotate. This is not a
security boundary — it stops casual double-voting (a double-click, a
refresh), not a targeted attempt to inflate a count. It ships this way
deliberately: customer-only voting would be close to useless on a
storefront where most traffic reading reviews is anonymous. Per-endpoint
rate limiting (Phase 6 of this plugin) is what makes abuse actually
costly; until then, treat `helpful_count` as a rough social-proof signal.

### 10. Dev-loop gotcha: `medusa develop` supervisor vs. child

Not a plugin limitation, but worth knowing before you go looking for a
bug that isn't there. `medusa develop` runs a **supervisor** process that
watches for file changes and a **child** process that actually holds the
listening port. Killing the process bound to the port (e.g.
`lsof -ti:9000 | xargs kill`) kills the child — but the supervisor is still
alive, and it will **respawn a new child and rebind the port** on its own.
If you then start a *second* `medusa develop` expecting a clean restart,
you can end up with a "restarted" server that's actually still serving the
build from before your change, while a second, orphaned supervisor sits
around doing nothing. Symptom: you fix a bug, restart, and the bug is
still there.

**To actually restart cleanly:** find and kill the supervisor too, not
just the port. On macOS/Linux:

```sh
lsof -ti:9000 | xargs kill -9         # kills the child holding the port
pgrep -f "medusa develop" | xargs kill -9   # kills any supervisor(s) too
```

Then start fresh and confirm the port is free before you do
(`lsof -ti:9000` should print nothing).

## Where your storefront will differ

This recipe was built against a Medusa v2 Next.js starter with an
existing UI kit, TypeScript configuration, and auth cookie setup. Some of
what you see in the real components is an artifact of that starter, not a
plugin requirement:

- **Plain HTML elements instead of a shared UI kit.** Every component in
  this module (`review-card.tsx`, `vote-button.tsx`, `review-summary.tsx`,
  `gallery-lightbox.tsx`, and others) renders plain `<div>`/`<button>`/`<img>`
  elements instead of this starter's shared `Heading`/`Text`/`Badge`
  primitives or `next/image`. That's because this starter's `@types/react`
  setup fails `tsc` with a pre-existing `TS2786` ("cannot be used as a JSX
  component") on **every** `forwardRef`-based component, `Suspense`, and
  `Context.Provider` used as JSX — a bug in the host, not in this plugin.
  A storefront without that bug can use its own component kit freely; none
  of the plugin's behaviour depends on plain elements.
- **`clx`, `LocalizedClientLink`, `ErrorMessage`, `ThumbUp`/`Star`/`StarSolid`
  icons** are this starter's own utilities and Medusa icon package, not
  part of this plugin. Swap them for your own class-name helper, link
  component, and icon set.
- **`sdk.client.fetch()` and `getAuthHeaders()`** come from this starter's
  own `@lib/config` and `@lib/data/cookies` modules — standard for any
  Medusa v2 Next.js storefront, but not shipped by this plugin. Any
  storefront calling the plugin's routes needs its own equivalent (a
  configured Medusa JS SDK client, or a plain `fetch()` with a
  publishable API key header).
- **`NEXT_PUBLIC_MEDUSA_BACKEND_URL` and `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`**
  are this starter's own env var names for the backend origin and
  publishable key. Use whatever your storefront already uses for these —
  the vote button just needs *some* way to know the backend's origin and
  send a valid publishable key.
- **The session-auth gap** described in [limitation #1](#1-signed-in-shoppers-are-deduped-as-guests-by-default)
  is specific to this starter's default auth wiring, not universal to
  Next.js storefronts. A storefront that already establishes a Medusa
  session cookie on the backend origin doesn't have this gap.

None of the above changes what the vote button's `fetch()` call must do —
run in the browser, hit the backend origin directly, send credentials.
That part of the recipe is not starter-specific.
