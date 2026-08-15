# Phase 4: Helpful Votes, Gallery API and Review Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship helpful votes with dedup, the customer media gallery API (product-scoped and global), gallery curation (pin/hide) in the admin, and the customer review-edit flow with re-moderation.

**Architecture:** Votes are a new `review_vote` model with two partial unique indexes doing the dedup work in the database rather than in application code; `helpful_count` on `review` is maintained by an atomic UPDATE, never read-modify-write. The gallery is a new store route reading `review_media` through a service-layer method that re-derives approval from the reviews table — the same enforcement pattern Phases 2 and 3 established, extended with the curation ordering. Editing reuses `createReviewWorkflow`'s validation and pushes an edited review back through moderation when `require_approval` is on.

**Tech Stack:** TypeScript, Medusa 2.18, MikroORM data models, `@medusajs/ui` 4.2.0 for the curation UI, Jest + `@medusajs/test-utils`, npm (NOT pnpm).

**Spec:** `/opt/homebrew/var/www/Medusa-review-extension/.claude/review-extension-plan.md` — §3 (settings), §4 (models: `review_vote`, curation columns), §5 (API), §9 (anti-abuse, GDPR on `voter_hash`), §11 (phases).

---

## Global Constraints

- Package `@stathmos/medusa-plugin-reviews`; Medusa pinned at `2.18.0`, `@medusajs/ui` at `4.2.0`.
- **npm, not pnpm, in this repo.** Never run `pnpm` here.
- Module → Workflow → API route → UI. A route never mutates through the service directly.
- **Only GET, POST, DELETE.** Never PUT or PATCH.
- Admin Zod schemas live in `src/api/admin/reviews/middlewares.ts`, store schemas in `src/api/store/reviews/middlewares.ts`; all `z.object({...}).strict()`.
- Admin routes get **no** explicit auth middleware — Medusa core protects `/admin/*`.
- Migrations: `npx medusa plugin:db:generate`. Read every generated migration before committing.
- **All list endpoints cap `limit` at 100 (default 20) and reject larger values.** An uncapped limit on the global gallery is a free denial-of-service (spec §5).
- Settings values are duplicated by hand in three places — the model, `src/modules/review/settings-defaults.ts`, and `UpdateReviewSettingsSchema` — and any settings write must call `invalidateReviewSettings`.
- Test commands: `npm run test:unit`, `npm run test:integration`, `npm run lint`, `npm run typecheck`, `npm run build`. The integration runner uses two Jest workers with `--workerIdleMemoryLimit=1500M` and `--expose-gc`; **do not add `--max-old-space-size` back** — raising the ceiling is what failed twice, worker recycling is what fixed it (see the ledger's Tasks 5+6 entry).
- **Baseline entering Phase 4: 154 integration (31 suites) / 62 unit.**

## Standing instruction carried from Phase 3

Six Phase 3 findings were tests that passed for reasons unrelated to what they claimed to check. The cause was almost always a single seeded record, so the filter under test never had to work — and twice more, a decoy existed but sorted *second*, so an unfiltered query returned the right row by luck of insertion order.

**Every filter, visibility or ordering test seeds a decoy that must NOT match, and the decoy must be the row returned FIRST when the filter is removed.** When mutation-checking, force the wrong answer to be the one that comes back first. A probe that relies on collection ordering proves nothing.

## Rulings made while planning

**R1 — `voter_hash` needs a salt, and the salt is configuration, not a constant.** Spec §9 defines it as `sha256(ip + ua + salt)` and calls the result pseudonymous personal data under GDPR. A hardcoded salt would make hashes comparable across every installation of this plugin, turning a per-store pseudonym into a global identifier. The salt is read from plugin options with a documented required-in-production warning. *Cost if wrong:* a store that never sets it gets per-install-stable but cross-install-comparable hashes, which is why it must warn loudly rather than silently default.

**R2 — Guests may vote; the dedup is best-effort and documented as such.** IP+UA hashing is defeatable by anyone who wants to defeat it. The alternative — customers only — makes the feature useless on a storefront where most traffic is anonymous. Ship it, document the limitation honestly in the README, and note that Phase 6's rate limiting is what makes it costly to abuse at scale. *Cost if wrong:* a determined actor can inflate a helpful count; they cannot forge a review or a verified badge.

**R3 — `helpful_count` is maintained by an atomic UPDATE, never read-modify-write.** This codebase already fixed this exact class of race twice (`claimMediaForReview`, `upsertReviewReply`). A read-then-write counter under concurrent votes silently loses increments. *Cost if wrong:* undercounted votes, invisible until someone compares the counter to the vote rows.

**R4 — The gallery re-derives approval in the service layer.** `listGalleryMedia()` must not trust a caller's filters, exactly as `listVisibleReviewMedias` and `listVisibleReviewReplies` do. The gallery is the highest-volume public read in the plugin and the most likely place a future contributor forgets a filter. *Cost if wrong:* unmoderated photos on a public gallery page — the worst outcome in this plugin.

**R5 — `allow_edit` defaults flip to `true` in this phase**, and the settings page's disabled toggle is re-enabled with its Phase-4 help text removed. Shipping the flow while leaving the switch disabled would repeat the exact problem Phase 3 documented.

**R6 — An edited review re-enters moderation when `require_approval` is on**, and its media survives the edit. Re-moderating is the point of the feature; destroying media on an edit would be a nasty surprise given rejection already deletes it.

---

## File Structure

**New:**
- `src/modules/review/models/review-vote.ts` — the vote model.
- `src/modules/review/migrations/<generated>.ts`
- `src/workflows/vote-review.ts` + `src/workflows/steps/cast-review-vote.ts`, `src/workflows/steps/withdraw-review-vote.ts`
- `src/workflows/update-review.ts` + `src/workflows/steps/apply-review-edit.ts`
- `src/workflows/curate-review-media.ts` + `src/workflows/steps/set-media-curation.ts`
- `src/api/store/reviews/[id]/vote/route.ts` — POST, DELETE
- `src/api/store/reviews/[id]/route.ts` — POST (edit)
- `src/api/store/reviews/gallery/route.ts` — GET
- `src/api/admin/reviews/media/[id]/curation/route.ts` — POST (pin/hide)
- `src/settings/voter-hash.ts` — hashing helper, unit-tested
- Integration specs: `store-vote.spec.ts`, `store-gallery.spec.ts`, `store-edit-review.spec.ts`, `admin-media-curation.spec.ts`, and one `*-compensation.spec.ts` per new workflow

**Modified:**
- `src/modules/review/service.ts` — `castVote`, `withdrawVote`, `adjustHelpfulCount`, `listGalleryMedia`, `countGalleryMedia`
- `src/modules/review/models/review-settings.ts` + `settings-defaults.ts` — `allow_edit` default → `true`
- `src/api/store/reviews/middlewares.ts` — vote, edit and gallery schemas
- `src/admin/routes/reviews/components/media-lightbox.tsx` — pin/hide controls
- `src/admin/routes/reviews/settings/page.tsx` — re-enable `allow_edit`
- `README.md`, `CHANGELOG.md`, `.changeset/`

---

## Task 1: `review_vote` model, migration, and the voter-hash helper

**Files:** Create `src/modules/review/models/review-vote.ts`, `src/settings/voter-hash.ts`, `src/settings/__tests__/voter-hash.unit.spec.ts`; modify `src/modules/review/service.ts`.

**Interfaces produced:** model `review_vote` (`id` prefix `rvot`, `review_id`, `customer_id` nullable, `voter_hash`); `voterHash(ip: string, userAgent: string, salt: string): string`.

- [ ] **Step 1: Write the failing unit tests for the hash helper**

```ts
import { voterHash } from '../voter-hash'

describe('voterHash', () => {
  it('is stable for the same inputs', () => {
    expect(voterHash('1.2.3.4', 'UA', 's')).toEqual(voterHash('1.2.3.4', 'UA', 's'))
  })
  it('changes with the salt, so hashes are not comparable across stores', () => {
    expect(voterHash('1.2.3.4', 'UA', 'a')).not.toEqual(voterHash('1.2.3.4', 'UA', 'b'))
  })
  it('changes with the IP and with the user agent independently', () => {
    const base = voterHash('1.2.3.4', 'UA', 's')
    expect(voterHash('5.6.7.8', 'UA', 's')).not.toEqual(base)
    expect(voterHash('1.2.3.4', 'other', 's')).not.toEqual(base)
  })
  it('never returns the raw inputs', () => {
    const h = voterHash('1.2.3.4', 'UA', 's')
    expect(h).not.toContain('1.2.3.4')
    expect(h).not.toContain('UA')
  })
})
```

- [ ] **Step 2: Run and watch fail.** `npm run test:unit`

- [ ] **Step 3: Implement the helper** using node's `crypto.createHash('sha256')` over a delimiter-joined string. Use a delimiter that cannot appear in an IP or UA so `('1.2', '3.4')` and `('1.2.3', '4')` cannot collide.

- [ ] **Step 4: Write the model**

```ts
export const ReviewVote = model
  .define('review_vote', {
    id: model.id({ prefix: 'rvot' }).primaryKey(),
    review_id: model.text(),
    customer_id: model.text().nullable(),
    voter_hash: model.text(),
  })
  .indexes([
    { on: ['review_id'] },
    // Two partial unique indexes, not one: a signed-in customer is
    // deduped by account, a guest by pseudonymous hash. Partial on
    // deleted_at so the HARD delete used for unvote (spec §4) is not the
    // only thing standing between a re-vote and a constraint violation.
    {
      on: ['review_id', 'customer_id'],
      unique: true,
      where: 'customer_id IS NOT NULL AND deleted_at IS NULL',
    },
    {
      on: ['review_id', 'voter_hash'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ])
```

- [ ] **Step 5: Register `ReviewVote` on `MedusaService({...})`**, generate the migration with `npx medusa plugin:db:generate`, and READ it. It must create one table and its indexes and touch nothing else.

- [ ] **Step 6: Run the full suite, then commit.**

```bash
npm run test:unit && npm run test:integration && npm run lint && npm run typecheck && npm run build
git add src integration-tests && git commit -m "Add review_vote model and voter-hash helper"
```

---

## Task 2: Cast and withdraw a vote, with an atomic counter

**Files:** Create `src/workflows/steps/cast-review-vote.ts`, `src/workflows/steps/withdraw-review-vote.ts`, `src/workflows/vote-review.ts`; modify `src/modules/review/service.ts`, `src/api/store/reviews/middlewares.ts`; create `src/api/store/reviews/[id]/vote/route.ts`.

**Interfaces produced:** `POST /store/reviews/:id/vote` and `DELETE /store/reviews/:id/vote`; service methods `castVote`, `withdrawVote`, `adjustHelpfulCount`.

- [ ] **Step 1: Write the failing integration tests** in `store-vote.spec.ts`:
  - voting increments `helpful_count` and creates one row
  - voting twice from the same identity is refused (409 or 400 — pick one, be consistent, and assert the exact status)
  - unvoting removes the row and decrements the counter
  - unvoting when no vote exists is a 404, not a 500
  - **a guest and a signed-in customer voting on the same review both succeed** (different dedup keys)
  - **a decoy review's votes never affect the counter of the review under test** — seed the decoy's vote FIRST
  - voting on a non-approved review is refused (an unmoderated review must not accumulate social proof)

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Add `adjustHelpfulCount` to the service** as a single atomic statement through the module's own manager, mirroring `claimMediaForReview`:

```ts
await knex('review')
  .where({ id: reviewId })
  .whereNull('deleted_at')
  .increment('helpful_count', delta)
```

Never `listReviews` → `+1` → `updateReviews`. Under concurrent votes that silently loses increments, and this codebase has already fixed the same race twice.

- [ ] **Step 4: Write the steps.** `castReviewVoteStep` inserts the vote then adjusts the counter; its compensation deletes the vote and reverses the counter. `withdrawReviewVoteStep` mirrors it. Both must translate a unique-constraint violation into a clean `MedusaError`, not a 500.

- [ ] **Step 5: Write the route.** Resolve the voter identity: `req.auth_context?.actor_id` when present, otherwise `voterHash(ip, userAgent, salt)`. Use `authenticate('customer', ['session','bearer'], { allowUnauthenticated: true })`, the pattern `POST /store/reviews` already uses.

- [ ] **Step 6: Run tests, verify pass, commit.**

---

## Task 3: Compensation coverage for votes

**Files:** Create `integration-tests/http/vote-review-compensation.spec.ts`.

This repo has six `*-compensation.spec.ts` files; rollback coverage is the house convention. Follow `moderate-reviews-compensation.spec.ts`: a synthetic workflow composing the real step then an always-throwing step.

- [ ] **Step 1:** Assert a rolled-back vote leaves neither a row nor a changed `helpful_count`. Mutate each half of the compensation and confirm the test fails for each. Report both.
- [ ] **Step 2:** Commit.

---

## Task 4: The gallery API

**Files:** Create `src/api/store/reviews/gallery/route.ts`; modify `src/modules/review/service.ts`, `src/api/store/reviews/middlewares.ts`; create `integration-tests/http/store-gallery.spec.ts`.

**Interfaces produced:** `GET /store/reviews/gallery?product_id=&type=image|video|all&limit&offset`; service methods `listGalleryMedia`, `countGalleryMedia`.

- [ ] **Step 1: Write the failing tests.** The gallery is the highest-risk read in the plugin, so cover:
  - returns media of approved reviews only — **seed a pending review's media FIRST** so an unfiltered query would return it
  - excludes `hidden_at` media
  - `product_id` scopes it; omitting `product_id` returns the global gallery
  - `type=image` and `type=video` filter correctly; `type=all` and omission both return everything
  - **ordering: `pinned_at` first, then newest** — seed an old pinned item and a new unpinned one and assert the pinned one leads
  - `limit` over 100 is rejected with a 400 (an uncapped limit here is a free DoS, spec §5)
  - `gallery_enabled: false` makes the endpoint 404
  - the response never contains `email`, `customer_id` or `replied_by`

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Add `listGalleryMedia` to the service.** It must re-derive approval from the `review` table rather than trusting the caller, exactly as `listVisibleReviewMedias` does — read that method and mirror its shape and its docstring's reasoning. Apply `hidden_at IS NULL`, the optional `product_id`, the optional `type`, and the ordering, in the database, never in JS.

- [ ] **Step 4: Write the route**, gated on `settings.gallery_enabled`, with an allow-listed response containing only media fields plus the minimum review context a gallery needs (`rating`, `display_name`, `product_id`).

- [ ] **Step 5:** Add `s-maxage` cache headers as the spec asks. Say in your report what value you chose and why.

- [ ] **Step 6: Run tests, commit.**

---

## Task 5: Gallery curation — pin and hide

**Files:** Create `src/workflows/steps/set-media-curation.ts`, `src/workflows/curate-review-media.ts`, `src/api/admin/reviews/media/[id]/curation/route.ts`; modify `src/api/admin/reviews/middlewares.ts`; create `integration-tests/http/admin-media-curation.spec.ts`.

**Interfaces produced:** `POST /admin/reviews/media/:id/curation` with body `{ pinned?: boolean, hidden?: boolean }`.

- [ ] **Step 1: Write the failing tests:** pinning sets `pinned_at` and unpinning nulls it; hiding sets `hidden_at`; a hidden item disappears from the gallery and from the store product reviews but **remains visible in the admin media list** (that difference is deliberate and already documented); curating a non-existent media id is a 404.

- [ ] **Step 2–4:** Implement the step (with compensation restoring the previous timestamps), the workflow, and the route. Note the route path sits under the existing `/admin/reviews/media/:id` DELETE — verify both resolve and add a test proving it.

- [ ] **Step 5: Run tests, commit.**

---

## Task 6: Curation controls in the admin lightbox

**Files:** Modify `src/admin/routes/reviews/components/media-lightbox.tsx` and `review-drawer.tsx`.

- [ ] **Step 1:** Add Pin/Unpin and Hide/Unhide controls to the lightbox, calling the Task 5 endpoint through `sdk`.
- [ ] **Step 2:** Mutation callbacks **must read the `variables` argument, not closed-over state** — Phase 3 shipped a Critical where pending callbacks were re-bound to a later render's closures, and this component is mounted across reviews for exactly the same reason.
- [ ] **Step 3:** Invalidate the drawer's media query and `['admin-reviews']`. Check the exact keys.
- [ ] **Step 4:** Hidden items are already badged; make the badge reflect the new state immediately.
- [ ] **Step 5:** Build, confirm the bundle contains your strings, commit.

---

## Task 7: Review editing with re-moderation

**Files:** Create `src/workflows/steps/apply-review-edit.ts`, `src/workflows/update-review.ts`, `src/api/store/reviews/[id]/route.ts`; modify `src/api/store/reviews/middlewares.ts`; create `integration-tests/http/store-edit-review.spec.ts`.

**Interfaces produced:** `POST /store/reviews/:id` with `{ rating?, title?, content? }`.

- [ ] **Step 1: Write the failing tests:**
  - a customer edits their own review; `edited_at` is set
  - **editing someone else's review is refused** — seed the other customer's review FIRST so an unfiltered lookup would return it
  - a guest cannot edit (no ownership proof exists for a guest submission; say so in the error)
  - with `require_approval: true`, editing an approved review returns it to `pending` and **removes it from the storefront immediately**
  - with `require_approval: false`, an edit stays approved
  - `allow_edit: false` refuses the edit with a 400
  - the review's media survives the edit
  - stats are recomputed — an edited-and-unapproved review must leave the product's average

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**, reusing `createReviewWorkflow`'s content-length validation rather than duplicating the bounds. Recompute stats inside the same workflow, as moderation does.

- [ ] **Step 4: Flip `allow_edit`'s default to `true`** in the model AND `settings-defaults.ts`, generate the migration if one is needed, and re-enable the settings-page toggle, deleting its "not yet available" help text.

- [ ] **Step 5: Run tests, commit.**

---

## Task 8: Documentation and release notes

**Files:** `README.md`, `CHANGELOG.md`, `.changeset/`

- [ ] **Step 1:** Document votes (including that guest dedup is best-effort and why), the gallery API with its parameters and the 100 cap, curation, and the edit flow with its re-moderation behaviour.
- [ ] **Step 2:** Update the settings table: `allow_edit` now works and defaults to `true`; `gallery_enabled` now actually gates something.
- [ ] **Step 3:** Document `voter_hash` as pseudonymous personal data under GDPR, per spec §9, and the salt configuration it requires.
- [ ] **Step 4:** Add a `minor` changeset. **Not `major`** — the package is unpublished at `0.0.1` and the roadmap publishes `v0.1.0` at Phase 6. Verify with `npx changeset status --verbose` and report what it prints.
- [ ] **Step 5:** Full suite green, commit.

---

## Self-Review

**Spec coverage.** §4's `review_vote` → Tasks 1–3. §5's `POST/DELETE /store/reviews/:id/vote` → Task 2, `GET /store/reviews/gallery` → Task 4, `POST /admin/reviews/media/:id/pin|hide` → Tasks 5–6, edit flow → Task 7. §9's `voter_hash` GDPR treatment → Tasks 1 and 8. The `most_helpful` sort already exists in `ORDER_BY` from Phase 1 and needs only a test that it now orders by a counter that actually moves — fold that into Task 2.

**Known gaps.** The curation UI (Task 6) has no automated rendering coverage, consistent with the rest of the admin UI in this repo. Rate limiting on the vote endpoint is Phase 6, so vote dedup is defeatable at scale until then — Task 8 must say so rather than implying votes are tamper-proof.

**Type consistency.** `listGalleryMedia` follows the `listVisibleReviewMedias` signature shape (`@InjectManager()` + `@MedusaContext()`, returns the model array). `adjustHelpfulCount(reviewId: string, delta: number)` is used by both vote steps with `+1`/`-1`.
