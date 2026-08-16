# Phase 5: Storefront Recipe and Documentation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the storefront integration for `@stathmos/medusa-plugin-reviews` — built and proven inside the test-host storefront, then extracted into a copy-paste recipe — plus JSON-LD rich snippets, ISR/revalidation guidance, and the full docs set.

**Architecture:** Every component is written into the real Next.js 15 storefront at `apps/storefront` in the test host FIRST and exercised against the running backend, then extracted into `docs/storefront-nextjs.md` in the plugin repo. A recipe that has never compiled is the same failure class as a test that never bites — this phase refuses to produce one. Reads happen in server components with Next cache tags so hosts get ISR; **writes that must be attributed to a shopper happen in the browser** (see R1).

**Tech Stack:** Next.js 15.5 (App Router, React 19), `@medusajs/js-sdk`, `@medusajs/ui`, Tailwind. Plugin docs are Markdown. Medusa 2.18.

**Spec:** `/opt/homebrew/var/www/Medusa-review-extension/.claude/review-extension-plan.md` — §5 (API), §7 (storefront/SEO), §11 (phases). Phase 5 is defined at line 230: "Next.js components, JSON-LD rich snippets, ISR/revalidation notes, full docs set, README with screenshots."

---

## Global Constraints

**TWO REPOSITORIES. They use different package managers. Getting this wrong breaks a lockfile.**

| | Path | Package manager | What lands here |
|---|---|---|---|
| Plugin | `/opt/homebrew/var/www/medusa-plugin-reviews` | **npm** — never pnpm | `docs/*.md`, README, CHANGELOG, changeset |
| Test host | `/opt/homebrew/var/www/Medusa-review-extension` | **pnpm 11** — never npm | storefront components, backend subscriber |

- Test host: backend `:9057`, storefront `:8057`. Publishable key `pk_a2571927a9332f64985270e2a4c9f38da4a12ca1ceb1fd44ab5b003a55f382fa`.
- **A Medusa dev server does not stop with `pkill`.** Kill by port (`lsof -ti:9057 | xargs kill`) or you will silently test stale code.
- pnpm 11 blocks packages published in the last ~24h. If an install stalls on that, `pnpm config set minimum-release-age 0` — do not work around it by switching package managers.
- Storefront conventions to follow, not reinvent: `sdk` from `@lib/config`, server functions in `src/lib/data/*.ts` marked `"use server"`, auth via `getAuthHeaders()` and cache tags via `getCacheTag()` from `@lib/data/cookies`.
- Plugin store routes require the `x-publishable-api-key` header; the configured `sdk` already sends it.
- Only GET, POST, DELETE.
- **No database changes in this phase.** No migrations, no model edits. If a task appears to need one, stop and report.
- **Do not modify anything under `medusa-plugin-reviews/src/`** unless a task explicitly says so. Phase 5 documents and consumes Phase 4's API; it does not redesign it.
- Docs must describe what the code does. This project has now shipped two settings toggles whose help text outlived the feature's absence — every doc claim gets checked against source.

## Rulings made while planning

**R1 — Helpful votes MUST be cast from the browser, never from a server action. This is the most important thing in this phase.**

The vote route derives a guest's identity from `req.ip` and `req.headers['user-agent']` (`src/api/store/reviews/[id]/vote/route.ts:65`). The idiomatic Medusa storefront pattern is a `"use server"` function calling the backend — and if voting goes through one, the backend sees **the storefront server's IP and a Node fetch user-agent, identical for every shopper on the site**. Every guest collapses to a single `voter_hash`. The first guest to vote on a review wins; every other guest on the internet gets a 409. Guest voting silently degrades to *one vote per review, store-wide*.

Phase 4's tests cannot catch this — they call the API directly, so each request carries its own identity by construction. It only appears when a real storefront sits in front, which is exactly what this phase builds.

The fix is architectural, not a patch: the vote button is a client component that calls the backend directly from the browser with the publishable key, so `req.ip` and the UA are the shopper's own. *Cost if wrong:* none to the plugin — this is how vote buttons want to work anyway (optimistic UI, no page round-trip).

**Explicitly rejected:** having the storefront forward `X-Forwarded-For` and the shopper's UA. Any client can set `X-Forwarded-For`, so trusting it makes dedup trivially defeatable *and* lets an attacker forge a specific victim's hash to consume their vote. A spoofable header is worse than the honest limitation.

**R2 — `aggregateRating` is emitted only when `count > 0`.** Google treats an `AggregateRating` with `reviewCount: 0` as invalid structured data, and inventing a rating for a product nobody has reviewed is the kind of thing that earns a manual action. The PDP emits `Product` JSON-LD always, `aggregateRating` conditionally. *Cost if wrong:* a product page loses a rich snippet it was never entitled to.

**R3 — The revalidation recipe is documented, not shipped as plugin code.** The plugin cannot call a storefront it knows nothing about. Phase 5 documents a host-side subscriber on `review.approved`/`review.rejected` plus a revalidate route handler, and implements that pair in the test host as the proof. *Cost if wrong:* hosts on ISR see a stale PDP until their own revalidation window elapses, which is the pre-existing behaviour anyway.

**R4 — README screenshots cover the storefront only.** Admin screenshots need an admin login this session does not perform. The README says so plainly rather than shipping a gap nobody mentions. *Cost if wrong:* the admin UI's screenshots wait for a human with a browser.

## Pre-flight conflict scan

| Producer | Consumer | Contract | Finding |
|---|---|---|---|
| T1 `lib/data/reviews.ts` | T2, T3, T5, T6 | server read functions + cache tags | Consistent. T1 must ship first; everything reads through it. |
| T1 cache tags | T7 revalidation | tag names must match exactly | **Flagged:** T1 invents the tag names and T7 revalidates them. Tag strings are the interface; T1's brief pins them verbatim so T7 cannot drift. |
| T2 PDP list | T4 vote buttons | vote button renders per review row | Consistent, but T4 is a CLIENT component inside T2's server component — R1 makes this load-bearing, not stylistic. |
| T3 submit form | T1 upload helper | `POST /store/reviews/uploads` is multipart | **Flagged:** multipart from a server action is awkward and R1's browser-side reasoning does NOT apply (uploads carry no dedup identity). Upload server-side; keep the file input client-side. |
| T6 edit form | Phase 4 `allow_edit` | edit UI must not appear when the setting is off | **Flagged:** the store API has no public "settings" endpoint. T6 must derive editability from whether the review belongs to the signed-in customer, and hide the control on a 400 rather than pre-checking. Recorded so T6's implementer does not invent an endpoint. |
| T8 docs | T1–T7 | code extracted verbatim | T8 runs last by construction. |

Self-consistency: T2's JSON-LD requirements match R2; T4's optimistic update matches the 409-on-duplicate contract; T7's tag names match T1's. No contradictions found.

---

## File structure

**Test host — storefront** (`apps/storefront/src`):
- Create `lib/data/reviews.ts` — all server reads + the non-attributed writes.
- Create `modules/reviews/components/` — `rating-stars`, `review-summary`, `review-list`, `review-card`, `review-form`, `media-uploader`, `vote-button` (client), `gallery-grid`, `edit-review-form` (client).
- Create `modules/reviews/templates/product-reviews.tsx` — the PDP section.
- Modify `modules/products/templates/index.tsx` — mount the reviews section.
- Modify `app/[countryCode]/(main)/products/[handle]/page.tsx` — JSON-LD.
- Create `app/[countryCode]/(main)/gallery/page.tsx` — the UGC wall.
- Create `app/api/revalidate-reviews/route.ts` — T7's revalidate hook.

**Test host — backend** (`apps/backend/src`):
- Create `subscribers/revalidate-storefront-reviews.ts` — T7's proof of R3.

**Plugin repo:**
- Create `docs/storefront-nextjs.md`, `docs/api-reference.md`, `docs/settings.md`, `docs/seo-json-ld.md`, `docs/revalidation.md`.
- Modify `README.md` (screenshots + docs index), `CHANGELOG.md`, add a changeset.

---

## Task 1: Storefront data layer

**Files:** Create `apps/storefront/src/lib/data/reviews.ts`.

**Interfaces produced (later tasks depend on these exact names):**
- `listProductReviews({ productId, sort?, page?, limit? })` → `{ reviews, count, nextPage }`
- `getProductReviewStats(productId)` → `{ average, count, breakdown, media_count }`
- `listGalleryMedia({ productId?, type?, limit?, offset? })` → `{ media, count }`
- `submitReview(formData)` / `uploadReviewMedia(formData)` — server actions
- **Cache tags, pinned verbatim:** `reviews-${productId}`, `review-stats-${productId}`, `review-gallery`

- [ ] **Step 1:** Write `reviews.ts` following `lib/data/products.ts`'s shape exactly — `"use server"`, `sdk.client.fetch`, `getAuthHeaders()`, `getCacheOptions()`. Every read passes `next: { tags: [...] }` using the tag names above.
- [ ] **Step 2:** Handle the documented failure modes explicitly rather than letting them throw raw: 404 when reviews are disabled (render nothing, not an error page), 409 on a duplicate vote, 400 when `allow_edit` is off.
- [ ] **Step 3:** Verify against the running backend — start it on 9057, seed one approved review, and confirm each function returns real data. Kill by port when done.
- [ ] **Step 4:** Commit.

## Task 2: PDP reviews section + JSON-LD

**Files:** Create `modules/reviews/components/{rating-stars,review-summary,review-list,review-card}.tsx`, `modules/reviews/templates/product-reviews.tsx`; modify `modules/products/templates/index.tsx` and the PDP `page.tsx`.

- [ ] **Step 1:** Build the summary (average, count, 5→1 breakdown bars) and the list (sort control: newest/highest/lowest/most_helpful, pagination), as server components.
- [ ] **Step 2:** Render each review's media thumbnails, verified badge, merchant reply, and `edited_at` when set — Phase 4 added `edited_at` to the public payload precisely so shoppers can see a review was rewritten. Do not omit it.
- [ ] **Step 3:** Emit JSON-LD on the PDP: `Product` with `aggregateRating` **only when `count > 0`** (R2), plus up to 10 `Review` nodes with `author` from `display_name`. Use `<script type="application/ld+json">` with `JSON.stringify`.
- [ ] **Step 4:** Validate the emitted JSON-LD — paste the rendered output through a schema validator and record the result. A rich snippet that fails validation is worse than none.
- [ ] **Step 5:** Empty state: a product with no reviews shows the submit prompt, no empty stars, no JSON-LD rating.
- [ ] **Step 6:** Commit.

## Task 3: Review submission with media

**Files:** Create `modules/reviews/components/{review-form,media-uploader}.tsx`.

- [ ] **Step 1:** Build the form: rating picker, title, content, display name, plus the guest email field shown only when the shopper is not signed in.
- [ ] **Step 2:** Media uploader — client-side file input, server-side upload to `POST /store/reviews/uploads`, previews before submit, respecting `max_media_per_review` by reporting the server's error rather than guessing the cap client-side.
- [ ] **Step 3:** On success, show what actually happened: "published" vs "submitted for approval". The store's `require_approval` decides which, and the response's `status` field is the ground truth — read it, do not assume.
- [ ] **Step 4:** Surface real server errors (too short, already reviewed, verified-only, guest not allowed) as field messages, not a generic toast.
- [ ] **Step 5:** Exercise the whole path against the running backend, including one media upload. Commit.

## Task 4: Helpful vote button (client-side — see R1)

**Files:** Create `modules/reviews/components/vote-button.tsx`; wire into `review-card.tsx`.

- [ ] **Step 1:** Build it as a **client component that calls the Medusa backend directly from the browser** with the publishable key. Put R1's reasoning in a comment at the fetch call: routing this through a server action collapses every guest to one `voter_hash` and breaks guest voting store-wide. This comment is the whole point of the file.
- [ ] **Step 2:** Optimistic increment, revert on failure. A 409 means "already voted" — show that state, do not surface it as an error.
- [ ] **Step 3:** Support withdrawing a vote (`DELETE`), toggling from the same control.
- [ ] **Step 4:** **Prove R1 empirically.** With the backend running, vote as a guest from the browser, then confirm the stored `voter_hash` differs when the user-agent differs — and record what a server-action-based vote would have produced instead. This is the evidence that justifies the whole design; do not skip it and do not assert it from reading.
- [ ] **Step 5:** Commit.

## Task 5: Gallery page and PDP photo strip

**Files:** Create `modules/reviews/components/gallery-grid.tsx`, `app/[countryCode]/(main)/gallery/page.tsx`; add a product-scoped strip to the PDP section.

- [ ] **Step 1:** Grid of media tiles with a lightbox, each linking back to its product.
- [ ] **Step 2:** Pagination against the documented cap (100 max, 20 default).
- [ ] **Step 3:** Confirm pinned media leads and hidden media never appears, using real curated rows set through the admin API.
- [ ] **Step 4:** Videos render with their poster (`thumbnail_url`) and do not autoplay.
- [ ] **Step 5:** Commit.

## Task 6: Editing your own review

**Files:** Create `modules/reviews/components/edit-review-form.tsx`.

- [ ] **Step 1:** Show the edit control only on reviews belonging to the signed-in customer. Per the pre-flight scan, there is no public settings endpoint — do not invent one; hide the control on the 400 the API returns when `allow_edit` is off.
- [ ] **Step 2:** Prefill from the existing review; allow clearing the title (Phase 4 made `title: null` valid for exactly this).
- [ ] **Step 3:** After a successful edit, tell the shopper the truth about what happened: if the response's `status` came back `pending`, say the review is awaiting re-approval and has left the storefront. Do not show a bare success toast on a review that just vanished.
- [ ] **Step 4:** Verify the rejected-review rule end to end: a rejected review edited on a store with `require_approval: false` comes back `pending`, not `approved`.
- [ ] **Step 5:** Commit.

## Task 7: ISR and revalidation (R3)

**Files:** Create `apps/backend/src/subscribers/revalidate-storefront-reviews.ts` and `apps/storefront/src/app/api/revalidate-reviews/route.ts`.

- [ ] **Step 1:** Subscriber on `review.approved` and `review.rejected` that POSTs the affected `product_id` to the storefront's revalidate route.
- [ ] **Step 2:** Route handler calls `revalidateTag()` for **exactly** T1's tag names (`reviews-${productId}`, `review-stats-${productId}`, `review-gallery`).
- [ ] **Step 3:** Protect the route with a shared secret from env. An open revalidation endpoint is a free cache-busting DoS — say so in a comment.
- [ ] **Step 4:** Prove it: approve a review in the admin API, confirm the PDP shows it without a manual restart or a wait.
- [ ] **Step 5:** Commit.

## Task 8: Documentation set

**Files:** Plugin repo — create `docs/storefront-nextjs.md`, `docs/api-reference.md`, `docs/settings.md`, `docs/seo-json-ld.md`, `docs/revalidation.md`; modify `README.md`, `CHANGELOG.md`; add a changeset.

- [ ] **Step 1:** Extract the recipe from the working storefront code — copy the real components, not idealised rewrites. Note where a host's storefront will differ.
- [ ] **Step 2:** `docs/storefront-nextjs.md` leads with **R1's warning as a call-out box**, because a host that gets this wrong sees no error at all — just guest voting that quietly stops working after the first vote. This is the single most important sentence in the docs set.
- [ ] **Step 3:** `docs/api-reference.md` — every store and admin route, with parameters, status codes, and the exact response shapes. Check each against source; do not transcribe from memory or from the spec, which is a sketch in places.
- [ ] **Step 4:** `docs/settings.md` — every setting, its default, what it gates, and the upgrade caveat that stored settings beat new defaults.
- [ ] **Step 5:** `docs/seo-json-ld.md` (including R2) and `docs/revalidation.md` (R3's recipe).
- [ ] **Step 6:** README: link the docs set, add storefront screenshots, and state plainly that admin screenshots are pending (R4).
- [ ] **Step 7:** Add a **`minor`** changeset — the package is unpublished at `0.0.1` and publishes `v0.1.0` at Phase 6. Run `npx changeset status --verbose` and report what it prints.
- [ ] **Step 8:** Full plugin suite green, commit.

---

## Self-Review

**Spec coverage.** §11's Phase 5 line names five things: Next.js components → T1–T6; JSON-LD → T2 + T8; ISR/revalidation notes → T7 + T8; full docs set → T8; README with screenshots → T8, storefront only per R4. §7's storefront/SEO requirements map to T2 and T8.

**Placeholders.** None: every task names its files, its verification, and its commit.

**Type consistency.** T1's exported function names and the three cache-tag strings are pinned verbatim and reused unchanged in T2, T5, T6 and T7.

**Known gap carried in, not introduced here:** the 12-point manual admin-UI checklist from Phase 3 remains unverified, and Phase 5 does not clear it — it needs an admin login this session does not perform.
