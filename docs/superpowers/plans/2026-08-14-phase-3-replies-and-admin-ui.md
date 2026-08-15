# Phase 3: Merchant Replies + Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship merchant replies end-to-end (model, workflow, admin API, public exposure) and the bundled admin dashboard UI — reviews list with tabs and bulk actions, detail drawer with media lightbox and reply composer, product widget, and settings page.

**Architecture:** Replies are a separate `review_reply` model with a unique `review_id`, written through a `replyToReviewWorkflow` and exposed publicly only for approved reviews via a service-layer method (the same enforcement pattern Phase 2 established for media). The admin UI is a Medusa admin extension under `src/admin/`, built by `medusa plugin:build` and consumed by the host through the package's `./admin` export. The UI talks to the plugin's own `/admin/reviews/*` routes through the Medusa JS SDK — never `fetch()`.

**Tech Stack:** TypeScript, Medusa 2.18, MikroORM data models, `@medusajs/ui` 4.2.0, `@medusajs/icons` 2.18.0, React 18, `@tanstack/react-query` v5 and `react-router-dom` v6 (host-provided — see Global Constraints), Jest + `@medusajs/test-utils` for integration tests, npm (NOT pnpm) in this repo.

**Spec:** `/opt/homebrew/var/www/Medusa-review-extension/.claude/review-extension-plan.md` — §4 (models/API), §7 (admin UI), §11 (phases). Open decision #3 in that document governs reply author display.

**Recon:** `/private/tmp/claude-501/-opt-homebrew-var-www-Medusa-review-extension/78c00799-3ccd-4d80-bc7c-3a52c1f60bec/scratchpad/phase3-recon.md` — exact current signatures for every file this plan touches. Read it before Task 1.

---

## Global Constraints

- Package `@stathmos/medusa-plugin-reviews`; Medusa pinned at `2.18.0`, `@medusajs/ui` at `4.2.0`.
- **npm, not pnpm, in this repo.** Never run `pnpm` here.
- Architecture layering is mandatory: Module (CRUD) → Workflow (all mutations) → API route (HTTP only) → UI. A route must never call the module service to mutate.
- **Only GET, POST, DELETE.** Never PUT or PATCH.
- All admin Zod schemas live in `src/api/admin/reviews/middlewares.ts` and are `z.object({...}).strict()`.
- **Admin routes get no explicit auth middleware.** Medusa core auto-protects `/admin/*`. Do not add `authenticate('user', ...)`.
- Migrations are generated with `npx medusa plugin:db:generate` (the `plugin:` verb — NOT `db:generate`), then committed.
- Settings values are duplicated by hand in three places that must stay in sync: the model, `src/modules/review/settings-defaults.ts`, and `UpdateReviewSettingsSchema`. Any settings write path must call `invalidateReviewSettings`.
- **Do NOT create a `review`↔`product` module link.** See Ruling R1 below.
- `@tanstack/react-query` and `react-router-dom` are host-provided at runtime and are deliberately NOT added to `package.json` (Medusa admin-extension convention; this repo uses npm, where the skill's guidance is explicitly "do NOT install these"). `@medusajs/ui`, `@medusajs/icons`, `react`, `react-dom` ARE declared and safe to import.
- Verification for every task: `npm run test:unit`, `npm run test:integration`, `npm run lint`, `npm run typecheck`, `npm run build` — all green. Baseline entering Phase 3: **100 integration / 58 unit** (plus whatever the in-flight `reject-deletes-media` branch adds).

## Rulings made while planning

**R1 — No module link to `product`.** The CHANGELOG names Phase 3's admin UI as the earliest feature permitted to reintroduce a `review`↔`product` link, because Phase 1's link leaked guest emails and unmoderated content through core `/store/products?fields=*reviews`. This plan does not need one: the admin UI already has authenticated access to `sdk.admin.product.list({ id: [...] })` and can resolve product titles and thumbnails client-side. Reintroducing the link would put the leak vector back for a convenience the UI can get another way. `integration-tests/http/review-product-link.spec.ts` must keep passing unchanged. *Cost if wrong:* the reviews table issues one extra admin request per page to hydrate product titles.

**R2 — Replies are a separate `review_reply` model, not columns on `review`.** Spec §4 lists `review_reply` as its own model ("merchant response, one per review (v1)"). A separate row gives the reply its own `created_at`/`updated_at`, lets deletion be a real delete rather than nulling three columns, and keeps `review` from growing merchant-only fields that every store read must then exclude. One-per-review is enforced with a partial unique index, matching the house pattern already used for one-review-per-customer. *Cost if wrong:* one extra query to load replies alongside reviews — the codebase already does exactly this for media.

**R3 — The reply's public author is the store name, never the admin user's name.** Spec open decision #3. `replied_by` (the admin user id) is stored for audit and is NEVER exposed on a store route. Publishing staff identities on a storefront is a privacy leak the merchant did not ask for. *Cost if wrong:* merchants wanting per-agent attribution must wait for a later phase.

**R4 — Reply visibility follows the parent review, enforced in the service layer.** A reply to a `pending` or `rejected` review must never appear on a store route. This is enforced by `listVisibleReviewReplies()` re-deriving approval from the `review` table — not by each route remembering a filter. This mirrors what Phase 2's final review forced for media (`listVisibleReviewMedias`), and it exists because per-route filters get forgotten by the next route. *Cost if wrong:* one extra query per store review list.

**R5 — The admin UI is not covered by the integration suite, and this plan says so rather than pretending.** `medusaIntegrationTestRunner` boots an HTTP app; it does not render React. UI tasks are verified by (a) `npm run build` succeeding and emitting the admin bundle, (b) pure logic extracted into unit-testable helpers, and (c) an explicit manual verification checklist run against the local host store. Any task that claims a UI behaviour is "tested" without one of those three is lying. *Cost if wrong:* UI regressions are caught by humans, not CI, until a component-test harness is added in a later phase.

---

## File Structure

**Backend (new):**
- `src/modules/review/models/review-reply.ts` — the `review_reply` model.
- `src/modules/review/migrations/MigrationYYYYMMDDHHMMSS.ts` — generated, adds the table.
- `src/workflows/reply-to-review.ts` — `replyToReviewWorkflow` (create-or-update + event).
- `src/workflows/steps/upsert-review-reply.ts` — the step, with compensation.
- `src/workflows/delete-review-reply.ts` + `src/workflows/steps/delete-review-reply.ts`.
- `src/api/admin/reviews/[id]/reply/route.ts` — `POST` (create/update), `DELETE` (remove).
- `src/api/admin/reviews/stats/[product_id]/route.ts` — `GET`, the widget's summary read.

**Backend (modified):**
- `src/modules/review/service.ts` — register `ReviewReply` in `MedusaService({...})`; add `listVisibleReviewReplies`.
- `src/modules/review/index.ts` — no change expected; verify the model is picked up.
- `src/api/admin/reviews/middlewares.ts` — add `ReplyToReviewSchema` and two middleware entries.
- `src/api/store/products/[id]/reviews/route.ts` — include `reply` on each returned review.

**Admin UI (all new):**
- `src/admin/lib/sdk.ts` — the shared SDK client.
- `src/admin/routes/reviews/page.tsx` — the sidebar route: table, tabs, bulk bar, drawer host.
- `src/admin/routes/reviews/components/review-table.tsx` — DataTable + tabs + pagination.
- `src/admin/routes/reviews/components/review-drawer.tsx` — detail drawer.
- `src/admin/routes/reviews/components/media-lightbox.tsx` — media viewer + per-media delete.
- `src/admin/routes/reviews/components/reply-composer.tsx` — reply create/edit/delete.
- `src/admin/routes/reviews/settings/page.tsx` — settings page (14 toggles).
- `src/admin/widgets/product-reviews.tsx` — product detail widget.
- `src/admin/lib/format.ts` — pure helpers (star rendering, excerpt truncation, date) — unit-tested.

**Tests (new):**
- `integration-tests/http/admin-reply.spec.ts`
- `integration-tests/http/store-reply-visibility.spec.ts`
- `integration-tests/http/admin-review-stats.spec.ts`
- `src/admin/lib/__tests__/format.unit.spec.ts`

---

## Task 1: `review_reply` model and migration

**Files:**
- Create: `src/modules/review/models/review-reply.ts`
- Modify: `src/modules/review/service.ts` (add `ReviewReply` to the `MedusaService({...})` call and its import)
- Create: `src/modules/review/migrations/<generated>.ts`
- Test: `integration-tests/http/admin-reply.spec.ts` (model-level assertions only in this task)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ReviewReply` model; generated service methods `createReviewReplies`, `listReviewReplies`, `updateReviewReplies`, `deleteReviewReplies`, `listAndCountReviewReplies`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/admin-reply.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    it('stores one reply per review and refuses a second', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      const review = await service.createReviews({
        product_id: 'prod_reply',
        display_name: 'A',
        rating: 5,
        content: 'x'.repeat(10),
      })

      const reply = await service.createReviewReplies({
        review_id: review.id,
        content: 'Thanks for the feedback!',
        replied_by: 'usr_test',
      })
      expect(reply.id).toMatch(/^rrep_/)

      await expect(
        service.createReviewReplies({
          review_id: review.id,
          content: 'Second reply',
          replied_by: 'usr_test',
        })
      ).rejects.toThrow()
    })
  },
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand --forceExit admin-reply`
Expected: FAIL — `service.createReviewReplies is not a function`.

- [ ] **Step 3: Write the model**

```ts
// src/modules/review/models/review-reply.ts
import { model } from '@medusajs/framework/utils'

/**
 * The merchant's response to a review. One per review in v1.
 *
 * `replied_by` holds the admin user's id for audit only. It is NEVER
 * exposed on a store route - spec decision #3 is that the public author
 * is the store's name, not the staff member's, both because merchants
 * want brand voice and because publishing staff identities on a
 * storefront is a privacy leak nobody asked for. Any store-facing
 * serialiser must allow-list fields rather than spread this row.
 */
export const ReviewReply = model
  .define('review_reply', {
    id: model.id({ prefix: 'rrep' }).primaryKey(),
    review_id: model.text(),
    content: model.text(),
    replied_by: model.text().nullable(),
  })
  .indexes([
    // One reply per review. Partial so a soft-deleted reply does not
    // block writing a new one - same shape as review's
    // one-review-per-customer index.
    {
      on: ['review_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ])
```

- [ ] **Step 4: Register it on the service**

In `src/modules/review/service.ts`, import `ReviewReply` alongside the existing model imports and add it to the generated base:

```ts
class ReviewModuleService extends MedusaService({
  Review,
  ReviewSettings,
  ReviewStats,
  ReviewMedia,
  ReviewReply,
}) {
```

- [ ] **Step 5: Generate and inspect the migration**

Run: `npx medusa plugin:db:generate`
Then READ the generated file. It must create `review_reply` with the partial unique index and nothing else — if it also drops or alters an existing table, stop and report; that means the local schema had drifted.

- [ ] **Step 6: Run the test to verify it passes**

Run: `TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand --forceExit admin-reply`
Expected: PASS.

- [ ] **Step 7: Full verification and commit**

```bash
npm run typecheck && npm run lint && npm run build
git add src/modules/review integration-tests/http/admin-reply.spec.ts
git commit -m "Add review_reply model with one-reply-per-review constraint"
```

---

## Task 2: Reply workflow and admin POST endpoint

**Files:**
- Create: `src/workflows/steps/upsert-review-reply.ts`, `src/workflows/reply-to-review.ts`
- Create: `src/api/admin/reviews/[id]/reply/route.ts`
- Modify: `src/api/admin/reviews/middlewares.ts`
- Test: `integration-tests/http/admin-reply.spec.ts` (extend)

**Interfaces:**
- Consumes: `ReviewReply` model and its generated service methods (Task 1).
- Produces: `replyToReviewWorkflow` with input `{ review_id: string; content: string; replied_by?: string }` returning `WorkflowResponse<{ reply: ReviewReply }>`; event `review.reply.created`.

- [ ] **Step 1: Write the failing tests**

Add to `admin-reply.spec.ts` (inside a `describe`, using `createAdminUser`/`adminHeaders` exactly as `admin-moderation.spec.ts` does):

```ts
it('creates a reply, then updates it in place', async () => {
  const created = await api.post(
    `/admin/reviews/${reviewId}/reply`,
    { content: 'Thanks!' },
    adminHeaders
  )
  expect(created.status).toEqual(200)
  expect(created.data.reply.content).toEqual('Thanks!')

  const updated = await api.post(
    `/admin/reviews/${reviewId}/reply`,
    { content: 'Thanks, updated.' },
    adminHeaders
  )
  expect(updated.status).toEqual(200)
  expect(updated.data.reply.id).toEqual(created.data.reply.id)
  expect(updated.data.reply.content).toEqual('Thanks, updated.')

  const service = getContainer().resolve(REVIEW_MODULE)
  const all = await service.listReviewReplies({ review_id: reviewId })
  expect(all).toHaveLength(1)
})

it('refuses a reply to a review that does not exist', async () => {
  const err = await api
    .post('/admin/reviews/rev_nope/reply', { content: 'Hi' }, adminHeaders)
    .catch((e) => e.response)
  expect(err.status).toEqual(404)
})

it('refuses an empty reply', async () => {
  const err = await api
    .post(`/admin/reviews/${reviewId}/reply`, { content: '' }, adminHeaders)
    .catch((e) => e.response)
  expect(err.status).toEqual(400)
})

it('requires authentication', async () => {
  const err = await api
    .post(`/admin/reviews/${reviewId}/reply`, { content: 'Hi' })
    .catch((e) => e.response)
  expect(err.status).toEqual(401)
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand --forceExit admin-reply`
Expected: FAIL — 404 from the router (route does not exist).

- [ ] **Step 3: Write the step with compensation**

```ts
// src/workflows/steps/upsert-review-reply.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { review_id: string; content: string; replied_by?: string }

export const upsertReviewReplyStep = createStep(
  'upsert-review-reply',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)

    const [review] = await service.listReviews({ id: input.review_id }, { take: 1 })
    if (!review) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Review not found')
    }

    const [existing] = await service.listReviewReplies(
      { review_id: input.review_id },
      { take: 1 }
    )

    if (existing) {
      const updated = await service.updateReviewReplies({
        id: existing.id,
        content: input.content,
        replied_by: input.replied_by ?? null,
      })
      // Compensation restores the previous text rather than deleting a
      // reply the merchant had already published.
      return new StepResponse(
        { reply: updated, created: false },
        { id: existing.id, previous_content: existing.content, created: false }
      )
    }

    const created = await service.createReviewReplies({
      review_id: input.review_id,
      content: input.content,
      replied_by: input.replied_by ?? null,
    })

    return new StepResponse({ reply: created, created: true }, { id: created.id, created: true })
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }
    const service = container.resolve(REVIEW_MODULE)

    if (compensation.created) {
      await service.deleteReviewReplies(compensation.id)
      return
    }

    await service.updateReviewReplies({
      id: compensation.id,
      content: compensation.previous_content,
    })
  }
)
```

- [ ] **Step 4: Write the workflow**

```ts
// src/workflows/reply-to-review.ts
import { createWorkflow, WorkflowResponse, transform } from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { upsertReviewReplyStep } from './steps/upsert-review-reply'

type Input = { review_id: string; content: string; replied_by?: string }

export const replyToReviewWorkflow = createWorkflow(
  'reply-to-review',
  function (input: Input) {
    const result = upsertReviewReplyStep(input)

    emitEventStep(
      transform({ input, result }, (data) => ({
        eventName: data.result.created ? 'review.reply.created' : 'review.reply.updated',
        data: { review_id: data.input.review_id },
      }))
    )

    return new WorkflowResponse(result)
  }
)
```

- [ ] **Step 5: Add the Zod schema and middleware entry**

In `src/api/admin/reviews/middlewares.ts`:

```ts
export const ReplyToReviewSchema = z
  .object({
    content: z.string().min(1).max(5000),
  })
  .strict()

export type ReplyToReviewInput = z.infer<typeof ReplyToReviewSchema>
```

and add to the `adminReviewMiddlewares` array:

```ts
{
  matcher: '/admin/reviews/:id/reply',
  method: 'POST',
  middlewares: [validateAndTransformBody(ReplyToReviewSchema)],
},
```

- [ ] **Step 6: Write the route**

```ts
// src/api/admin/reviews/[id]/reply/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { replyToReviewWorkflow } from '../../../../../workflows/reply-to-review'
import { ReplyToReviewInput } from '../../middlewares'

export async function POST(
  req: AuthenticatedMedusaRequest<ReplyToReviewInput>,
  res: MedusaResponse
) {
  const { result } = await replyToReviewWorkflow(req.scope).run({
    input: {
      review_id: req.params.id,
      content: req.validatedBody.content,
      replied_by: req.auth_context?.actor_id,
    },
  })

  res.json({
    reply: {
      id: result.reply.id,
      review_id: result.reply.review_id,
      content: result.reply.content,
      created_at: result.reply.created_at,
      updated_at: result.reply.updated_at,
    },
  })
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand --forceExit admin-reply`
Expected: PASS, all four.

- [ ] **Step 8: Full verification and commit**

```bash
npm run typecheck && npm run lint && npm run build
git add src/workflows src/api integration-tests
git commit -m "Add merchant reply workflow and admin reply endpoint"
```

---

## Task 3: Delete a reply

**Files:**
- Create: `src/workflows/steps/delete-review-reply.ts`, `src/workflows/delete-review-reply.ts`
- Modify: `src/api/admin/reviews/[id]/reply/route.ts` (add `DELETE`)
- Test: `integration-tests/http/admin-reply.spec.ts` (extend)

**Interfaces:**
- Consumes: `replyToReviewWorkflow` (Task 2) for setup in tests.
- Produces: `deleteReviewReplyWorkflow` with input `{ review_id: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('deletes a reply', async () => {
  await api.post(`/admin/reviews/${reviewId}/reply`, { content: 'Thanks!' }, adminHeaders)

  const response = await api.delete(`/admin/reviews/${reviewId}/reply`, adminHeaders)
  expect(response.status).toEqual(200)

  const service = getContainer().resolve(REVIEW_MODULE)
  const remaining = await service.listReviewReplies({ review_id: reviewId })
  expect(remaining).toHaveLength(0)
})

it('deleting a reply that does not exist is a 404, not a 500', async () => {
  const err = await api
    .delete(`/admin/reviews/${reviewId}/reply`, adminHeaders)
    .catch((e) => e.response)
  expect(err.status).toEqual(404)
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand --forceExit admin-reply`
Expected: FAIL — no `DELETE` handler exported.

- [ ] **Step 3: Write the step**

```ts
// src/workflows/steps/delete-review-reply.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { review_id: string }

export const deleteReviewReplyStep = createStep(
  'delete-review-reply',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)

    const [existing] = await service.listReviewReplies(
      { review_id: input.review_id },
      { take: 1 }
    )
    if (!existing) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Reply not found')
    }

    await service.deleteReviewReplies(existing.id)

    // Compensation recreates the reply with its original text. Losing a
    // merchant's published response because an unrelated later step
    // failed would be silent data loss they never authorised.
    return new StepResponse({ id: existing.id }, {
      review_id: existing.review_id,
      content: existing.content,
      replied_by: existing.replied_by,
    })
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }
    const service = container.resolve(REVIEW_MODULE)
    await service.createReviewReplies(compensation)
  }
)
```

- [ ] **Step 4: Write the workflow and the DELETE handler**

```ts
// src/workflows/delete-review-reply.ts
import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { deleteReviewReplyStep } from './steps/delete-review-reply'

export const deleteReviewReplyWorkflow = createWorkflow(
  'delete-review-reply',
  function (input: { review_id: string }) {
    return new WorkflowResponse(deleteReviewReplyStep(input))
  }
)
```

Add to `src/api/admin/reviews/[id]/reply/route.ts`:

```ts
export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  await deleteReviewReplyWorkflow(req.scope).run({
    input: { review_id: req.params.id },
  })

  res.json({ id: req.params.id, object: 'review_reply', deleted: true })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand --forceExit admin-reply`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run typecheck && npm run lint && npm run build
git add src integration-tests
git commit -m "Add reply deletion with restoring compensation"
```

---

## Task 4: Expose replies on the store route, approved-only

**Files:**
- Modify: `src/modules/review/service.ts` (add `listVisibleReviewReplies`)
- Modify: `src/api/store/products/[id]/reviews/route.ts`
- Test: `integration-tests/http/store-reply-visibility.spec.ts`

**Interfaces:**
- Consumes: `ReviewReply` (Task 1), `replyToReviewWorkflow` (Task 2).
- Produces: `listVisibleReviewReplies(reviewIds: string | string[]): Promise<ReviewReply[]>`; each store review object gains `reply: { content, created_at, author } | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// integration-tests/http/store-reply-visibility.spec.ts
it('shows a reply on an approved review', async () => {
  // approve review, post reply via admin, then:
  const response = await api.get(`/store/products/prod_reply/reviews`, { headers: storeHeaders })
  expect(response.data.reviews[0].reply.content).toEqual('Thanks!')
})

it('hides the reply of a pending review', async () => {
  // review left pending, reply posted
  const response = await api.get(`/store/products/prod_reply/reviews`, { headers: storeHeaders })
  expect(response.data.reviews).toHaveLength(0)
  expect(JSON.stringify(response.data)).not.toContain('Thanks!')
})

it('never exposes replied_by on a store route', async () => {
  const response = await api.get(`/store/products/prod_reply/reviews`, { headers: storeHeaders })
  expect(JSON.stringify(response.data)).not.toContain('usr_')
  expect(response.data.reviews[0].reply.replied_by).toBeUndefined()
})

it('refuses a non-approved review\'s reply at the service layer, with no route involved', async () => {
  const service = getContainer().resolve(REVIEW_MODULE)
  const replies = await service.listVisibleReviewReplies([pendingReviewId])
  expect(replies).toHaveLength(0)
})
```

Note the last test deliberately bypasses HTTP: it is what proves the rule lives in the service, not in the route. Phase 2's review required exactly this and it is why the media equivalent survived refactoring.

- [ ] **Step 2: Run and watch them fail**

Expected: FAIL — `listVisibleReviewReplies is not a function`.

- [ ] **Step 3: Add the service method**

```ts
  /**
   * THE enforcement point for "which replies may a store endpoint show".
   * Approval is re-derived from the reviews table rather than trusted
   * from the caller's id list, so a route that hands over unfiltered ids
   * still cannot leak a reply attached to a pending or rejected review.
   * Mirrors listVisibleReviewMedias() deliberately - the two rules are
   * the same rule and should read the same way.
   */
  @InjectManager()
  async listVisibleReviewReplies(
    reviewIds: string | string[],
    @MedusaContext() context: Context = {}
  ): Promise<ReviewReply[]> {
    const ids = Array.isArray(reviewIds) ? reviewIds : [reviewIds]
    if (!ids.length) {
      return []
    }

    const approved = await this.listReviews(
      { id: ids, status: 'approved' },
      { select: ['id'], take: ids.length },
      context
    )
    if (!approved.length) {
      return []
    }

    return this.listReviewReplies(
      { review_id: approved.map((r) => r.id) },
      undefined,
      context
    )
  }
```

- [ ] **Step 4: Wire it into the store route**

In `src/api/store/products/[id]/reviews/route.ts`, after the existing media lookup, fetch replies for the same review ids and attach an allow-listed object. The store name is read once from the Store module:

```ts
const replies = await service.listVisibleReviewReplies(reviewIds)
const replyByReview = new Map(replies.map((r) => [r.review_id, r]))

const storeModule = req.scope.resolve(Modules.STORE)
const [store] = await storeModule.listStores({}, { take: 1 })
const author = store?.name ?? null
```

and in the per-review serialiser add:

```ts
reply: replyByReview.has(review.id)
  ? {
      content: replyByReview.get(review.id)!.content,
      created_at: replyByReview.get(review.id)!.created_at,
      // Spec decision #3: the store's name, never the staff member's.
      author,
    }
  : null,
```

- [ ] **Step 5: Run tests to verify they pass**

Expected: PASS, all four.

- [ ] **Step 6: Commit**

```bash
npm run test:integration && npm run typecheck && npm run lint && npm run build
git add src integration-tests
git commit -m "Expose merchant replies on approved reviews only"
```

---

## Task 5: Admin stats endpoint for the product widget

**Files:**
- Create: `src/api/admin/reviews/stats/[product_id]/route.ts`
- Test: `integration-tests/http/admin-review-stats.spec.ts`

**Interfaces:**
- Produces: `GET /admin/reviews/stats/:product_id` → `{ count, average, breakdown: {1..5}, media_count }`, zeros when no row exists.

- [ ] **Step 1: Write the failing test**

```ts
it('returns the denormalized summary for a product', async () => {
  await api.post(`/admin/reviews/${reviewId}/approve`, {}, adminHeaders)

  const response = await api.get('/admin/reviews/stats/prod_stats', adminHeaders)
  expect(response.status).toEqual(200)
  expect(response.data.count).toEqual(1)
  expect(response.data.average).toEqual(5)
})

it('returns zeros for a product with no reviews', async () => {
  const response = await api.get('/admin/reviews/stats/prod_none', adminHeaders)
  expect(response.status).toEqual(200)
  expect(response.data.count).toEqual(0)
})

it('requires authentication', async () => {
  const err = await api.get('/admin/reviews/stats/prod_stats').catch((e) => e.response)
  expect(err.status).toEqual(401)
})
```

- [ ] **Step 2: Run and watch them fail** — 404 from the router.

- [ ] **Step 3: Write the route**, reading `review_stats` directly and defaulting to zeros, exactly as `src/api/store/products/[id]/reviews/stats/route.ts` already does. Copy that file's shape; do not invent a second convention.

- [ ] **Step 4: Run tests, verify pass. Step 5: Commit.**

```bash
git commit -m "Add admin product review stats endpoint"
```

---

## Task 6: Admin SDK client, dependency check, and a route that renders

This task's deliverable is proof the admin build pipeline works end to end. It is deliberately tiny — if the bundle does not build and load, every later UI task is guesswork.

**Files:**
- Create: `src/admin/lib/sdk.ts`, `src/admin/routes/reviews/page.tsx`
- Modify: `package.json` only if `@medusajs/js-sdk` proves undeclared (see Step 1)

- [ ] **Step 1: Verify the SDK dependency before writing code**

Run: `npm ls @medusajs/js-sdk` and `node -e "require.resolve('@medusajs/js-sdk')"`.
`@medusajs/js-sdk` is NOT in this repo's declared dependencies today. If it resolves only transitively, add it to BOTH `devDependencies` and `peerDependencies` pinned to `2.18.0`, matching how every other `@medusajs/*` package is declared here. Do NOT add `@tanstack/react-query` or `react-router-dom` — those are host-provided by convention and this repo uses npm.
Record in your report exactly what you found and what you changed.

- [ ] **Step 2: Write the SDK client**

```tsx
// src/admin/lib/sdk.ts
import Medusa from '@medusajs/js-sdk'

export const sdk = new Medusa({
  baseUrl: import.meta.env.VITE_BACKEND_URL || '/',
  debug: import.meta.env.DEV,
  auth: { type: 'session' },
})
```

- [ ] **Step 3: Write a minimal route**

```tsx
// src/admin/routes/reviews/page.tsx
import { defineRouteConfig } from '@medusajs/admin-sdk'
import { ChatBubbleLeftRight } from '@medusajs/icons'
import { Container, Heading } from '@medusajs/ui'

const ReviewsPage = () => {
  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Reviews</Heading>
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: 'Reviews',
  icon: ChatBubbleLeftRight,
})

export default ReviewsPage
```

- [ ] **Step 4: Verify the build emits the admin bundle**

Run: `npm run build`
Then confirm `.medusa/server/src/admin/index.mjs` exists and is non-empty:
`test -s .medusa/server/src/admin/index.mjs && echo OK`
Expected: `OK`. If the file is missing, the route file is not being picked up — stop and report rather than proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/admin package.json package-lock.json
git commit -m "Add admin SDK client and Reviews route shell"
```

---

## Task 7: Reviews data table with tabs, search and pagination

**Files:**
- Create: `src/admin/routes/reviews/components/review-table.tsx`, `src/admin/lib/format.ts`
- Create: `src/admin/lib/__tests__/format.unit.spec.ts`
- Modify: `src/admin/routes/reviews/page.tsx`

**Interfaces:**
- Consumes: `sdk` (Task 6); `GET /admin/reviews` with `status`, `product_id`, `rating`, `limit`, `offset`.
- Produces: `<ReviewTable onSelect={(id) => void} />`; `formatStars(rating: number): string`, `excerpt(text: string, max: number): string`.

- [ ] **Step 1: Write failing unit tests for the pure helpers**

```ts
// src/admin/lib/__tests__/format.unit.spec.ts
import { formatStars, excerpt } from '../format'

describe('formatStars', () => {
  it('renders filled and empty stars', () => {
    expect(formatStars(3)).toEqual('★★★☆☆')
  })
  it('clamps out-of-range ratings instead of producing negative repeats', () => {
    expect(formatStars(0)).toEqual('☆☆☆☆☆')
    expect(formatStars(9)).toEqual('★★★★★')
  })
})

describe('excerpt', () => {
  it('leaves short text alone', () => {
    expect(excerpt('short', 20)).toEqual('short')
  })
  it('truncates on a word boundary and appends an ellipsis', () => {
    expect(excerpt('the quick brown fox jumps', 12)).toEqual('the quick…')
  })
})
```

`formatStars(9)` must not produce `'★'.repeat(9)`. An unclamped implementation passes a naive test and breaks the table layout the first time bad data appears.

- [ ] **Step 2: Run and watch fail.** `npm run test:unit`

- [ ] **Step 3: Implement `src/admin/lib/format.ts`** with clamping, then verify the tests pass.

- [ ] **Step 4: Write the table**

Follow the DataTable pattern exactly: `createDataTableColumnHelper`, `useDataTable` with `rowSelection`, `search` and `pagination` state, `keepPreviousData` for smooth paging. Columns: product (id for now — Task 11 hydrates titles), rating (via `formatStars`), excerpt of `content`, media count, verified badge, status badge, date.

Tabs are four buttons filtering `status` — Pending / Approved / Rejected / All — each resetting `pagination.pageIndex` to 0. Forgetting that reset leaves the user on page 3 of an empty tab.

The query MUST load on mount with no `enabled` condition tied to UI state:

```tsx
const { data, isLoading } = useQuery({
  queryFn: () =>
    sdk.client.fetch(`/admin/reviews`, {
      query: { status: tab === 'all' ? undefined : tab, limit, offset },
    }),
  queryKey: ['admin-reviews', tab, limit, offset],
})
```

Use `size="small"` on buttons, `px-6 py-4` section padding, semantic colour classes only, and the `Text` component rather than raw `<span>`/`<p>`.

- [ ] **Step 5: Build, then verify manually**

Run `npm run build`, confirm the bundle emits. Manual verification is deferred to Task 13's checklist — note in your report that no automated test covers the rendering.

- [ ] **Step 6: Commit**

```bash
git commit -m "Add reviews data table with tabs, search and pagination"
```

---

## Task 8: Bulk approve/reject command bar

**Files:** Modify `src/admin/routes/reviews/components/review-table.tsx`

**Interfaces:** Consumes `POST /admin/reviews/batch/status` (`{ ids, status, rejection_reason? }`, max 100 ids).

- [ ] **Step 1: Add the command bar**, shown only when `Object.keys(rowSelection).length > 0`, with Approve and Reject actions.
- [ ] **Step 2: Reject must prompt for an optional reason** before sending — a bulk reject that silently discards the reason field makes the reason useless everywhere else it is shown.
- [ ] **Step 3: The mutation must** disable its buttons while `isPending`, invalidate `['admin-reviews']` on success, clear `rowSelection`, and show a `toast` on both success and failure.
- [ ] **Step 4: Cap the selection at 100** to match `BatchStatusSchema`; if more rows are selected, disable the action and say why rather than sending a request that will 400.
- [ ] **Step 5: Build and commit.**

```bash
git commit -m "Add bulk approve and reject to the reviews table"
```

---

## Task 9: Detail drawer with media lightbox and per-media delete

**Files:** Create `src/admin/routes/reviews/components/review-drawer.tsx`, `media-lightbox.tsx`; modify `page.tsx`

**Interfaces:** Consumes `GET /admin/reviews` (single row by id), `POST /admin/reviews/:id/approve`, `POST /admin/reviews/:id/reject`, `DELETE /admin/reviews/media/:id`.

- [ ] **Step 1: Use `Drawer`, not `FocusModal`** — this edits an existing entity. The skill's rule is FocusModal for create, Drawer for edit.
- [ ] **Step 2: Show** full content, rating, author, email, product id, status, dates, and the media strip.
- [ ] **Step 3: Media lightbox** opens a larger view; video renders in a `<video controls>` element with no autoplay. Remember `thumbnail_url` is always `null` — do not render a broken `<img>` for videos; use a placeholder tile.
- [ ] **Step 4: Per-media delete must confirm first** and state plainly that it is permanent and cannot be undone. Deletion removes the file from storage. Do NOT use `window.confirm` — it is a browser modal; use Medusa UI's `Prompt`.
- [ ] **Step 5: On any mutation**, invalidate both `['admin-reviews']` and the drawer's own query, so the table behind the drawer does not show stale status.
- [ ] **Step 6: Build and commit.**

```bash
git commit -m "Add review detail drawer with media lightbox"
```

---

## Task 10: Reply composer

**Files:** Create `src/admin/routes/reviews/components/reply-composer.tsx`; modify `review-drawer.tsx`

**Interfaces:** Consumes `POST /admin/reviews/:id/reply`, `DELETE /admin/reviews/:id/reply` (Tasks 2–3).

- [ ] **Step 1: Render existing reply if present**, in an editable `Textarea` seeded with its content; otherwise an empty composer.
- [ ] **Step 2: Save posts to the reply endpoint**, disabled while pending and while the textarea is empty or unchanged.
- [ ] **Step 3: Delete confirms first**, then calls `DELETE`.
- [ ] **Step 4: Show the author line as the store name**, matching what the storefront will display — the merchant should see what customers see. Do not show the admin user's name anywhere in this component.
- [ ] **Step 5: Invalidate** the drawer query and `['admin-reviews']` after every mutation, and toast on success and failure.
- [ ] **Step 6: Build and commit.**

```bash
git commit -m "Add merchant reply composer to the review drawer"
```

---

## Task 11: Product detail widget

**Files:** Create `src/admin/widgets/product-reviews.tsx`

**Interfaces:** Consumes `GET /admin/reviews/stats/:product_id` (Task 5) and `GET /admin/reviews?product_id=&limit=5`.

- [ ] **Step 1: Register the widget** with `defineWidgetConfig({ zone: 'product.details.after' })` and type its props `DetailWidgetProps<HttpTypes.AdminProduct>`.
- [ ] **Step 2: Show** the rating summary (average, count, star breakdown bars) and the five most recent reviews as a compact list — not a DataTable; this is a widget.
- [ ] **Step 3: Link into the filtered list** via `react-router-dom`'s `Link` to `/app/reviews?product_id=<id>`, and make Task 7's table read that query parameter on mount so the link actually filters. A link that lands on an unfiltered list is worse than no link.
- [ ] **Step 4: Both queries load on mount** — no `enabled` gate. Show a `Spinner` while loading and a plain empty state when the product has no reviews.
- [ ] **Step 5: Use `Text`, not headings**, for the widget's small section labels.
- [ ] **Step 6: Build and commit.**

```bash
git commit -m "Add product detail reviews widget"
```

---

## Task 12: Settings page

**Files:** Create `src/admin/routes/reviews/settings/page.tsx`

**Interfaces:** Consumes `GET /admin/reviews/settings`, `POST /admin/reviews/settings`.

- [ ] **Step 1: Render all 14 settings** with inline help text: `enabled`, `require_approval`, `allow_guest`, `verified_only`, `allow_media`, `allow_video`, `max_media_per_review`, `max_image_size_mb`, `max_video_size_mb`, `allow_edit`, `one_review_per_customer`, `min_content_length`, `max_content_length`, `gallery_enabled`.
- [ ] **Step 2: `verified_only` must carry its implication in the help text** — turning it on means only authenticated customers can submit, because a guest-supplied email can be anyone's and a forgeable verified badge is worse than none. The spec calls this out specifically; a bare toggle labelled "verified only" misleads the merchant into thinking guests still review with badges.
- [ ] **Step 3: `allow_edit` is documented as not yet functional** (Phase 4). Render it disabled with help text saying so rather than offering a live toggle that does nothing.
- [ ] **Step 4: Numeric fields validate client-side** against the same bounds as `UpdateReviewSettingsSchema` so the merchant gets an inline message rather than a 400.
- [ ] **Step 5: Save invalidates** the settings query and toasts. Note in help text that `max_video_size_mb` above 100 has no effect — the transport ceiling is 100MB per file regardless.
- [ ] **Step 6: Build and commit.**

```bash
git commit -m "Add reviews settings page"
```

---

## Task 13: Install into the host store, verify manually, and document

**Files:** Modify `README.md`, `CHANGELOG.md`; create `.changeset/<name>.md`

- [ ] **Step 1: Publish and install the plugin into the local host store.**

The host at `/opt/homebrew/var/www/Medusa-review-extension` currently runs **Phase 1** — it has no `review_media` table, so it cannot exercise Phase 2 or 3 until re-installed. In the plugin repo run `npx medusa plugin:build && npx medusa plugin:publish`. In the host's `apps/backend` run `npx medusa plugin:add @stathmos/medusa-plugin-reviews`, then `npx medusa db:migrate`.

**Known trap:** the host uses pnpm, and `plugin:add` refreshes `apps/backend/node_modules/@stathmos/...` but NOT the hoisted copy at `node_modules/.pnpm/node_modules/@stathmos/...` that Medusa's resolver actually reads. `db:migrate` then fails with MODULE_NOT_FOUND pointing at the `.pnpm` path while the backend copy looks fine, and `pnpm install --force` will NOT fix it. Fix by symlinking `node_modules/.pnpm/node_modules/@stathmos/medusa-plugin-reviews` → `apps/backend/node_modules/@stathmos/medusa-plugin-reviews`.

Do NOT run `pnpm build` in the host while its dev servers are running — it clobbers `.next/` and breaks the storefront. Stop servers by port (9057 backend, 8057 storefront), never with `pkill`.

- [ ] **Step 2: Run the manual verification checklist** and record the result of each line in your report. This is the only coverage the UI has:
  1. "Reviews" appears in the admin sidebar at `http://localhost:9057/app`.
  2. The table lists reviews; each of the four tabs filters correctly and resets to page 1.
  3. Search and pagination work; paging does not flash empty.
  4. Selecting rows reveals the command bar; bulk approve moves rows to the Approved tab.
  5. Bulk reject prompts for a reason and stores it.
  6. Opening a row opens the drawer with full content and media.
  7. The media lightbox opens; a video plays; a video tile shows a placeholder, not a broken image.
  8. Per-media delete confirms, deletes, and the image 404s afterwards at its URL.
  9. Reply composer creates, edits and deletes a reply; the author line shows the store name.
  10. The reply appears on the storefront only after the review is approved.
  11. The product widget shows the summary and links into the filtered list.
  12. The settings page loads all 14 fields, saves, and the change takes effect without a redeploy.

- [ ] **Step 3: Update `README.md`** — add the admin UI to the feature list, document the reply endpoints in the API table, and state that replies are visible publicly only on approved reviews and are attributed to the store name.

- [ ] **Step 4: Update `CHANGELOG.md`** under Unreleased, and add a changeset (minor bump — new feature on a 0.x package).

- [ ] **Step 5: Full verification and commit.**

```bash
npm run test:unit && npm run test:integration && npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Document Phase 3 replies and admin UI"
```

---

## Self-Review

**Spec coverage.** §7's three deliverables map to Tasks 7–10 (sidebar route: table, tabs, bulk bar, drawer, lightbox, per-media delete, reply composer), Task 11 (product widget) and Task 12 (settings page). §4's `review_reply` model, `POST /admin/reviews/:id/reply` + DELETE, the `reply-to-review` workflow and the `review.reply.created` event map to Tasks 1–3. Public reply exposure maps to Task 4. Pin/hide is explicitly Phase 4 and is out of scope here.

**Known gaps, stated rather than hidden.** The admin UI has no automated rendering coverage (Ruling R5); Task 13's checklist is its only verification. The `review.reply.updated` event in Task 2 is an addition not named in the spec — the spec lists only `review.reply.created`, and emitting a distinct event for an edit is a judgment call a reviewer may reverse.

**Type consistency.** `listVisibleReviewReplies` matches the `listVisibleReviewMedias` signature shape (`string | string[]` → `Promise<T[]>`, `@InjectManager()` + `@MedusaContext()`). The reply object returned by the admin route (`id`, `review_id`, `content`, `created_at`, `updated_at`) and the store route (`content`, `created_at`, `author`) are deliberately different shapes — the store one omits `id`, `review_id` and `replied_by` by allow-list.
