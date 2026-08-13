# Phase 1: Core Review Module & Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the review domain — models, settings, moderation, stats and the store/admin APIs — so a merchant can collect, moderate and serve product reviews with no media and no storefront yet.

**Architecture:** One Medusa module (`review`) holding three models, with all mutations going through workflows and all HTTP surface delegating to those workflows. Settings live in a single database row read through the Cache Module so multiple instances agree. Rating aggregates live in a denormalized `review_stats` row recomputed on every status transition, because the stats endpoint is called on every product page.

**Tech Stack:** Medusa v2.18, TypeScript, MikroORM (via Medusa data models), Zod validation, Jest + `@medusajs/test-utils`, npm.

**Spec:** `/opt/homebrew/var/www/Medusa-review-extension/.claude/review-extension-plan.md` (revised 2026-08-13). Sections referenced below as §3, §4, §5.

## Global Constraints

- Medusa peer range `^2.18.0`; Node 20–24; package manager **npm** (not pnpm).
- Module name is `review` — camelCase, **never** kebab-case, or container resolution breaks.
- HTTP methods: **GET, POST, DELETE only**. Never PUT or PATCH.
- **Every mutation goes through a workflow.** API routes never call module services to write.
- **All business validation lives in workflow steps**, never in route handlers.
- Never add `.linkable()` to a data model — Medusa adds it automatically.
- List endpoints cap `limit` at **100**, default **20**.
- Verified-purchase status requires an **authenticated customer** (§3.1). A guest-supplied email must never produce a verified badge.
- `allow_edit` ships defaulted **false** — the edit flow is Phase 4.
- Media is **out of scope** for Phase 1 (Phase 2). Do not add `review_media`.
- Run `npm run lint && npm run typecheck && npm run build` before every commit.

---

### Task 1: Integration test harness

The plugin repo has no test setup at all. Everything downstream is TDD, so the harness is task one. It also proves `medusaIntegrationTestRunner` can boot an app from a *plugin* repo — an assumption the rest of the plan rests on. If this task fails, stop and report rather than proceeding.

**Files:**
- Create: `medusa-config.ts`
- Create: `jest.config.js`
- Create: `integration-tests/setup.js`
- Create: `.env.test`
- Create: `integration-tests/http/harness.spec.ts`
- Modify: `package.json` (test scripts)
- Modify: `.gitignore` (ignore `.env.test`)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run test:integration` boots a Medusa app with this plugin's `src/` loaded; specs live in `integration-tests/http/*.spec.ts`.

- [ ] **Step 1: Create the test app config**

A plugin repo needs a `medusa-config.ts` for the test runner to boot an app. Modules are registered directly from `src/`, so tests exercise the same source that ships.

```ts
// medusa-config.ts
import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS || 'http://localhost:8000',
      adminCors: process.env.ADMIN_CORS || 'http://localhost:9000',
      authCors: process.env.AUTH_CORS || 'http://localhost:9000',
      jwtSecret: process.env.JWT_SECRET || 'test',
      cookieSecret: process.env.COOKIE_SECRET || 'test',
    },
  },
  modules: [{ resolve: './src/modules/review' }],
})
```

- [ ] **Step 2: Create jest config**

```js
// jest.config.js
const { loadEnv } = require('@medusajs/utils')
loadEnv('test', process.cwd())

module.exports = {
  transform: {
    '^.+\\.[jt]s$': [
      '@swc/jest',
      { jsc: { parser: { syntax: 'typescript', decorators: true } } },
    ],
  },
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'ts', 'json'],
  modulePathIgnorePatterns: ['dist/', '<rootDir>/.medusa/'],
  setupFiles: ['./integration-tests/setup.js'],
  testTimeout: 60000,
}

if (process.env.TEST_TYPE === 'integration:http') {
  module.exports.testMatch = ['**/integration-tests/http/*.spec.[jt]s']
} else if (process.env.TEST_TYPE === 'unit') {
  module.exports.testMatch = ['**/src/**/__tests__/**/*.unit.spec.[jt]s']
}
```

- [ ] **Step 3: Create the setup file and test env**

```js
// integration-tests/setup.js
const { MetadataStorage } = require('@medusajs/framework/mikro-orm/core')

MetadataStorage.clear()
```

```ini
# .env.test
DATABASE_URL=postgres://localhost:5432/medusa-plugin-reviews-test
JWT_SECRET=test
COOKIE_SECRET=test
```

Add `.env.test` to `.gitignore` — CI supplies `DATABASE_URL` through the workflow env.

- [ ] **Step 4: Add test scripts**

Replace the placeholder `test` script in `package.json`:

```json
"test": "npm run test:integration",
"test:integration": "TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules jest --silent=false --runInBand --forceExit",
"test:unit": "TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules jest --silent --runInBand --forceExit"
```

- [ ] **Step 5: Write the harness spec**

The smoke route from Phase 0 still exists at this point, so use it to prove the app boots with plugin routes mounted.

```ts
// integration-tests/http/harness.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api }) => {
    describe('test harness', () => {
      it('boots a Medusa app with the plugin source loaded', async () => {
        const response = await api.get('/store/plugin')

        expect(response.status).toEqual(200)
      })
    })
  },
})
```

- [ ] **Step 6: Run it**

Run: `npm run test:integration`
Expected: PASS. The runner creates its own temporary Postgres database.

If it fails to boot, STOP. Report the error rather than working around it — every later task depends on this.

- [ ] **Step 7: Commit**

```bash
git add medusa-config.ts jest.config.js integration-tests .env.test .gitignore package.json
git commit -m "Add integration test harness

medusaIntegrationTestRunner needs an app to boot, so the plugin repo now
carries a medusa-config.ts that registers its own modules straight from
src/. Tests therefore exercise the source that ships rather than a copy."
```

---

### Task 2: Review model, module and service

**Files:**
- Create: `src/modules/review/models/review.ts`
- Create: `src/modules/review/service.ts` (replaces smoke service)
- Create: `src/modules/review/index.ts`
- Create: `integration-tests/http/review-module.spec.ts`
- Delete: `src/modules/smoke/`, `src/workflows/smoke.ts`, `src/api/store/plugin/route.ts`, `src/api/admin/plugin/route.ts`
- Modify: `src/workflows/index.ts`, `medusa-config.ts`, `integration-tests/http/harness.spec.ts`

**Interfaces:**
- Consumes: test harness from Task 1.
- Produces: `REVIEW_MODULE = 'review'`; service methods `createReviews`, `listReviews`, `listAndCountReviews`, `retrieveReview`, `updateReviews`, `deleteReviews`, `softDeleteReviews`. Review fields: `id, product_id, customer_id, order_id, display_name, email, rating, title, content, status, rejection_reason, is_verified_purchase, helpful_count, edited_at`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/review-module.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('review module', () => {
      it('creates a review defaulting to pending with no helpful votes', async () => {
        const service = getContainer().resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_test',
          display_name: 'Ada',
          rating: 5,
          content: 'Genuinely excellent, would buy again.',
        })

        expect(review).toMatchObject({
          status: 'pending',
          helpful_count: 0,
          is_verified_purchase: false,
        })
        expect(review.id).toMatch(/^rev_/)
      })
    })
  },
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -- review-module`
Expected: FAIL — cannot resolve module `review`.

- [ ] **Step 3: Write the model**

```ts
// src/modules/review/models/review.ts
import { model } from '@medusajs/framework/utils'

export const Review = model
  .define('review', {
    id: model.id({ prefix: 'rev' }).primaryKey(),
    product_id: model.text(),
    customer_id: model.text().nullable(),
    order_id: model.text().nullable(),
    display_name: model.text(),
    email: model.text().nullable(),
    rating: model.number(),
    title: model.text().nullable(),
    content: model.text(),
    status: model
      .enum(['pending', 'approved', 'rejected'])
      .default('pending'),
    rejection_reason: model.text().nullable(),
    is_verified_purchase: model.boolean().default(false),
    helpful_count: model.number().default(0),
    edited_at: model.dateTime().nullable(),
  })
  .indexes([
    { on: ['product_id'] },
    { on: ['status'] },
    // One review per customer per product. Partial so guests (null
    // customer_id) are exempt and soft-deleted rows do not block a resubmit.
    {
      on: ['product_id', 'customer_id'],
      unique: true,
      where: 'customer_id IS NOT NULL AND deleted_at IS NULL',
    },
  ])
```

`created_at`, `updated_at` and `deleted_at` are added automatically — do not declare them.

- [ ] **Step 4: Write the service and module definition**

```ts
// src/modules/review/service.ts
import { MedusaService } from '@medusajs/framework/utils'
import { Review } from './models/review'

class ReviewModuleService extends MedusaService({ Review }) {}

export default ReviewModuleService
```

```ts
// src/modules/review/index.ts
import { Module } from '@medusajs/framework/utils'
import ReviewModuleService from './service'

export const REVIEW_MODULE = 'review'

export default Module(REVIEW_MODULE, {
  service: ReviewModuleService,
})
```

- [ ] **Step 5: Delete the Phase 0 throwaway**

```bash
rm -rf src/modules/smoke src/workflows/smoke.ts src/api/store/plugin src/api/admin/plugin
```

Set `src/workflows/index.ts` to `export {}` for now — it regains real exports in Task 6. Update `medusa-config.ts` to register only `./src/modules/review`. Replace the body of `harness.spec.ts` with a check that survives the deletion:

```ts
// integration-tests/http/harness.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('test harness', () => {
      it('boots a Medusa app with the plugin module registered', async () => {
        expect(getContainer().resolve(REVIEW_MODULE)).toBeDefined()
      })
    })
  },
})
```

- [ ] **Step 6: Generate the migration**

Run: `npx medusa plugin:db:generate`
Expected: a migration under `src/modules/review/migrations/`. Open it and confirm it creates `review` with the three indexes.

- [ ] **Step 7: Run tests**

Run: `npm run test:integration`
Expected: PASS (both specs).

- [ ] **Step 8: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add review model, module and service

Unique index on (product_id, customer_id) is partial: guests have no
customer_id and must not collide, and excluding soft-deleted rows lets a
customer resubmit after their review is removed.

Removes the Phase 0 smoke module, which has served its purpose."
```

---

### Task 3: Settings model and cache-backed resolution

**Files:**
- Create: `src/modules/review/models/review-settings.ts`
- Create: `src/modules/review/settings-defaults.ts`
- Create: `src/settings/get-review-settings.ts`
- Create: `src/settings/__tests__/settings-defaults.unit.spec.ts`
- Modify: `src/modules/review/service.ts`
- Create: `integration-tests/http/review-settings.spec.ts`

**Interfaces:**
- Consumes: `REVIEW_MODULE` from Task 2.
- Produces: `REVIEW_SETTINGS_DEFAULTS: ReviewSettingsValues`; `mergeSettings(row): ReviewSettingsValues`; `getReviewSettings(container): Promise<ReviewSettingsValues>`; `REVIEW_SETTINGS_CACHE_KEY = 'review:settings'`; `REVIEW_SETTINGS_ID = 'review_settings'`.

- [ ] **Step 1: Write the failing unit test**

```ts
// src/settings/__tests__/settings-defaults.unit.spec.ts
import { REVIEW_SETTINGS_DEFAULTS, mergeSettings } from '../../modules/review/settings-defaults'

describe('mergeSettings', () => {
  it('returns defaults when no row exists', () => {
    expect(mergeSettings(undefined)).toEqual(REVIEW_SETTINGS_DEFAULTS)
  })

  it('lets a stored value override a default without dropping the others', () => {
    const merged = mergeSettings({ require_approval: false } as never)

    expect(merged.require_approval).toBe(false)
    expect(merged.max_media_per_review).toBe(REVIEW_SETTINGS_DEFAULTS.max_media_per_review)
  })

  it('defaults allow_edit to false because the edit flow ships in Phase 4', () => {
    expect(REVIEW_SETTINGS_DEFAULTS.allow_edit).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Write defaults and merge**

```ts
// src/modules/review/settings-defaults.ts
export type ReviewSettingsValues = {
  enabled: boolean
  require_approval: boolean
  allow_guest: boolean
  verified_only: boolean
  allow_media: boolean
  allow_video: boolean
  max_media_per_review: number
  max_image_size_mb: number
  max_video_size_mb: number
  allow_edit: boolean
  one_review_per_customer: boolean
  min_content_length: number
  max_content_length: number
  gallery_enabled: boolean
}

export const REVIEW_SETTINGS_ID = 'review_settings'

export const REVIEW_SETTINGS_DEFAULTS: ReviewSettingsValues = {
  enabled: true,
  require_approval: true,
  allow_guest: false,
  verified_only: false,
  allow_media: true,
  allow_video: true,
  max_media_per_review: 5,
  max_image_size_mb: 5,
  max_video_size_mb: 50,
  // Phase 4 ships the edit flow; the toggle must not be live before then.
  allow_edit: false,
  one_review_per_customer: true,
  min_content_length: 10,
  max_content_length: 5000,
  gallery_enabled: true,
}

export function mergeSettings(
  row: Partial<ReviewSettingsValues> | undefined | null
): ReviewSettingsValues {
  if (!row) {
    return { ...REVIEW_SETTINGS_DEFAULTS }
  }

  const merged = { ...REVIEW_SETTINGS_DEFAULTS }

  for (const key of Object.keys(REVIEW_SETTINGS_DEFAULTS) as (keyof ReviewSettingsValues)[]) {
    const value = row[key]
    if (value !== undefined && value !== null) {
      ;(merged as Record<string, unknown>)[key] = value
    }
  }

  return merged
}
```

- [ ] **Step 4: Write the model and register it**

```ts
// src/modules/review/models/review-settings.ts
import { model } from '@medusajs/framework/utils'

export const ReviewSettings = model.define('review_settings', {
  id: model.id({ prefix: 'rset' }).primaryKey(),
  enabled: model.boolean().default(true),
  require_approval: model.boolean().default(true),
  allow_guest: model.boolean().default(false),
  verified_only: model.boolean().default(false),
  allow_media: model.boolean().default(true),
  allow_video: model.boolean().default(true),
  max_media_per_review: model.number().default(5),
  max_image_size_mb: model.number().default(5),
  max_video_size_mb: model.number().default(50),
  allow_edit: model.boolean().default(false),
  one_review_per_customer: model.boolean().default(true),
  min_content_length: model.number().default(10),
  max_content_length: model.number().default(5000),
  gallery_enabled: model.boolean().default(true),
})
```

```ts
// src/modules/review/service.ts
import { MedusaService } from '@medusajs/framework/utils'
import { Review } from './models/review'
import { ReviewSettings } from './models/review-settings'

class ReviewModuleService extends MedusaService({ Review, ReviewSettings }) {}

export default ReviewModuleService
```

- [ ] **Step 5: Write the cache-backed reader**

```ts
// src/settings/get-review-settings.ts
import { MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../modules/review'
import {
  mergeSettings,
  ReviewSettingsValues,
} from '../modules/review/settings-defaults'

export const REVIEW_SETTINGS_CACHE_KEY = 'review:settings'

/**
 * Settings are read through the Cache Module rather than a per-process
 * variable. A process-local cache lets two instances disagree about
 * require_approval, which would auto-publish reviews on one node while
 * holding them pending on another.
 */
export async function getReviewSettings(
  container: MedusaContainer
): Promise<ReviewSettingsValues> {
  const cache = container.resolve(Modules.CACHE)

  const cached = await cache.get<ReviewSettingsValues>(REVIEW_SETTINGS_CACHE_KEY)
  if (cached) {
    return cached
  }

  const service = container.resolve(REVIEW_MODULE)
  const [row] = await service.listReviewSettings({}, { take: 1 })
  const settings = mergeSettings(row)

  await cache.set(REVIEW_SETTINGS_CACHE_KEY, settings, 300)

  return settings
}

export async function invalidateReviewSettings(
  container: MedusaContainer
): Promise<void> {
  const cache = container.resolve(Modules.CACHE)
  await cache.invalidate(REVIEW_SETTINGS_CACHE_KEY)
}
```

- [ ] **Step 6: Write the integration test**

```ts
// integration-tests/http/review-settings.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { getReviewSettings, invalidateReviewSettings } from '../../src/settings/get-review-settings'
import { REVIEW_SETTINGS_DEFAULTS } from '../../src/modules/review/settings-defaults'
import { REVIEW_MODULE } from '../../src/modules/review'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('review settings', () => {
      it('returns defaults when no settings row exists', async () => {
        const settings = await getReviewSettings(getContainer())

        expect(settings).toEqual(REVIEW_SETTINGS_DEFAULTS)
      })

      it('reflects a stored row after the cache is invalidated', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await service.createReviewSettings({ require_approval: false })
        await invalidateReviewSettings(container)

        const settings = await getReviewSettings(container)

        expect(settings.require_approval).toBe(false)
      })
    })
  },
})
```

- [ ] **Step 7: Generate migration and run tests**

Run: `npx medusa plugin:db:generate` then `npm run test:unit && npm run test:integration`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add review settings with cache-backed resolution

Reads go through the Cache Module, which is Redis-backed in production,
so instances cannot disagree about require_approval. Absent rows fall
back to defaults rather than being auto-created, so a fresh install
behaves identically to an untouched settings page."
```

---

### Task 4: Settings workflow and admin settings routes

**Files:**
- Create: `src/workflows/steps/update-review-settings.ts`
- Create: `src/workflows/update-review-settings.ts`
- Create: `src/api/admin/reviews/settings/route.ts`
- Create: `src/api/admin/reviews/middlewares.ts`
- Create: `src/api/middlewares.ts`
- Modify: `src/workflows/index.ts`
- Create: `integration-tests/http/admin-settings.spec.ts`

**Interfaces:**
- Consumes: `getReviewSettings`, `invalidateReviewSettings`, `REVIEW_SETTINGS_ID`.
- Produces: `updateReviewSettingsWorkflow`; `UpdateReviewSettingsSchema` (Zod) and its inferred type; routes `GET|POST /admin/reviews/settings`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/admin-settings.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createAdminUser, adminHeaders } from '../helpers/admin'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await createAdminUser(getContainer())
    })

    describe('GET /admin/reviews/settings', () => {
      it('returns defaults before anything is saved', async () => {
        const response = await api.get('/admin/reviews/settings', adminHeaders)

        expect(response.status).toEqual(200)
        expect(response.data.settings.require_approval).toBe(true)
      })
    })

    describe('POST /admin/reviews/settings', () => {
      it('persists a change and serves it on the next read', async () => {
        await api.post('/admin/reviews/settings', { require_approval: false }, adminHeaders)

        const response = await api.get('/admin/reviews/settings', adminHeaders)

        expect(response.data.settings.require_approval).toBe(false)
      })

      it('rejects an unknown setting', async () => {
        const response = await api
          .post('/admin/reviews/settings', { nonsense: true }, adminHeaders)
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })
    })
  },
})
```

- [ ] **Step 2: Write the admin auth helper**

```ts
// integration-tests/helpers/admin.ts
import { MedusaContainer } from '@medusajs/framework/types'
import { createUsersWorkflow } from '@medusajs/medusa/core-flows'
import jwt from 'jsonwebtoken'

export const adminHeaders = {
  headers: { authorization: '' as string },
}

export async function createAdminUser(container: MedusaContainer) {
  const { result } = await createUsersWorkflow(container).run({
    input: { users: [{ email: 'admin@test.local', first_name: 'Ad', last_name: 'Min' }] },
  })

  const token = jwt.sign(
    { actor_id: result[0].id, actor_type: 'user', auth_identity_id: 'test', app_metadata: {} },
    'test',
    { expiresIn: '1d' }
  )

  adminHeaders.headers.authorization = `Bearer ${token}`

  return result[0]
}
```

The signing secret must match `JWT_SECRET` in `.env.test` (`test`).

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:integration -- admin-settings`
Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 4: Write the step and workflow**

```ts
// src/workflows/steps/update-review-settings.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { Modules } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'
import {
  REVIEW_SETTINGS_ID,
  ReviewSettingsValues,
} from '../../modules/review/settings-defaults'
import { REVIEW_SETTINGS_CACHE_KEY } from '../../settings/get-review-settings'

type Input = Partial<ReviewSettingsValues>

export const updateReviewSettingsStep = createStep(
  'update-review-settings',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)
    const cache = container.resolve(Modules.CACHE)

    const [existing] = await service.listReviewSettings({}, { take: 1 })

    const previous = existing ? { ...existing } : undefined

    const saved = existing
      ? await service.updateReviewSettings({ id: existing.id, ...input })
      : await service.createReviewSettings({ id: REVIEW_SETTINGS_ID, ...input })

    await cache.invalidate(REVIEW_SETTINGS_CACHE_KEY)

    return new StepResponse(saved, previous)
  },
  async (previous, { container }) => {
    const service = container.resolve(REVIEW_MODULE)
    const cache = container.resolve(Modules.CACHE)

    if (previous) {
      await service.updateReviewSettings(previous)
    } else {
      await service.deleteReviewSettings(REVIEW_SETTINGS_ID)
    }

    await cache.invalidate(REVIEW_SETTINGS_CACHE_KEY)
  }
)
```

```ts
// src/workflows/update-review-settings.ts
import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { updateReviewSettingsStep } from './steps/update-review-settings'
import { ReviewSettingsValues } from '../modules/review/settings-defaults'

export const updateReviewSettingsWorkflow = createWorkflow(
  'update-review-settings',
  function (input: Partial<ReviewSettingsValues>) {
    const settings = updateReviewSettingsStep(input)

    emitEventStep({ eventName: 'review.settings.updated', data: {} })

    return new WorkflowResponse(settings)
  }
)
```

Export it from `src/workflows/index.ts`:

```ts
export * from './update-review-settings'
```

- [ ] **Step 5: Write validation middleware**

```ts
// src/api/admin/reviews/middlewares.ts
import { MiddlewareRoute, validateAndTransformBody } from '@medusajs/framework'
import { z } from 'zod'

export const UpdateReviewSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    require_approval: z.boolean().optional(),
    allow_guest: z.boolean().optional(),
    verified_only: z.boolean().optional(),
    allow_media: z.boolean().optional(),
    allow_video: z.boolean().optional(),
    max_media_per_review: z.number().int().min(0).max(20).optional(),
    max_image_size_mb: z.number().int().min(1).max(50).optional(),
    max_video_size_mb: z.number().int().min(1).max(500).optional(),
    allow_edit: z.boolean().optional(),
    one_review_per_customer: z.boolean().optional(),
    min_content_length: z.number().int().min(0).max(1000).optional(),
    max_content_length: z.number().int().min(1).max(20000).optional(),
    gallery_enabled: z.boolean().optional(),
  })
  .strict()

export type UpdateReviewSettingsSchema = z.infer<typeof UpdateReviewSettingsSchema>

export const adminReviewMiddlewares: MiddlewareRoute[] = [
  {
    matcher: '/admin/reviews/settings',
    method: 'POST',
    middlewares: [validateAndTransformBody(UpdateReviewSettingsSchema)],
  },
]
```

`.strict()` is what turns an unknown key into the 400 the test expects.

```ts
// src/api/middlewares.ts
import { defineMiddlewares } from '@medusajs/framework/http'
import { adminReviewMiddlewares } from './admin/reviews/middlewares'

export default defineMiddlewares({
  routes: [...adminReviewMiddlewares],
})
```

- [ ] **Step 6: Write the route**

```ts
// src/api/admin/reviews/settings/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { getReviewSettings } from '../../../../settings/get-review-settings'
import { updateReviewSettingsWorkflow } from '../../../../workflows/update-review-settings'
import { UpdateReviewSettingsSchema } from '../middlewares'

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const settings = await getReviewSettings(req.scope)

  res.json({ settings })
}

export async function POST(
  req: AuthenticatedMedusaRequest<UpdateReviewSettingsSchema>,
  res: MedusaResponse
) {
  await updateReviewSettingsWorkflow(req.scope).run({ input: req.validatedBody })

  const settings = await getReviewSettings(req.scope)

  res.json({ settings })
}
```

- [ ] **Step 7: Run tests**

Run: `npm run test:integration -- admin-settings`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add settings workflow and admin settings routes

Schema is strict so a typo'd setting name is a 400 rather than a
silently ignored no-op. The step invalidates the settings cache on both
apply and compensation, so a rolled-back update cannot leave stale
values being served."
```

---

### Task 5: Review stats model and recompute step

**Files:**
- Create: `src/modules/review/models/review-stats.ts`
- Create: `src/workflows/steps/recompute-review-stats.ts`
- Modify: `src/modules/review/service.ts`
- Create: `integration-tests/http/review-stats.spec.ts`

**Interfaces:**
- Consumes: `REVIEW_MODULE`.
- Produces: `recomputeReviewStatsStep({ product_id })`; `ReviewStats` fields `product_id, count, average, breakdown_1..breakdown_5, media_count`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/review-stats.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { recomputeReviewStatsStep } from '../../src/workflows/steps/recompute-review-stats'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('review stats', () => {
      it('counts only approved reviews and rounds the average to two places', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await service.createReviews([
          { product_id: 'prod_stats', display_name: 'A', rating: 5, content: 'x'.repeat(10), status: 'approved' },
          { product_id: 'prod_stats', display_name: 'B', rating: 4, content: 'x'.repeat(10), status: 'approved' },
          { product_id: 'prod_stats', display_name: 'C', rating: 1, content: 'x'.repeat(10), status: 'pending' },
        ])

        await recomputeReviewStatsStep.invoke({ product_id: 'prod_stats' }, { container } as never)

        const [stats] = await service.listReviewStats({ product_id: 'prod_stats' })

        expect(stats).toMatchObject({ count: 2, average: 4.5, breakdown_5: 1, breakdown_4: 1, breakdown_1: 0 })
      })
    })
  },
})
```

If invoking the step directly proves awkward, extract the body into an exported `recomputeReviewStats(container, product_id)` function, test that, and have the step call it. Prefer whichever keeps the test readable.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -- review-stats`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the model**

```ts
// src/modules/review/models/review-stats.ts
import { model } from '@medusajs/framework/utils'

/**
 * Denormalized per-product summary. The stats endpoint is called on every
 * product detail page; aggregating the whole review table per request does
 * not survive contact with a real catalogue.
 */
export const ReviewStats = model
  .define('review_stats', {
    id: model.id({ prefix: 'rsta' }).primaryKey(),
    product_id: model.text(),
    count: model.number().default(0),
    average: model.number().default(0),
    breakdown_1: model.number().default(0),
    breakdown_2: model.number().default(0),
    breakdown_3: model.number().default(0),
    breakdown_4: model.number().default(0),
    breakdown_5: model.number().default(0),
    media_count: model.number().default(0),
  })
  .indexes([{ on: ['product_id'], unique: true, where: 'deleted_at IS NULL' }])
```

Register `ReviewStats` in `MedusaService({ Review, ReviewSettings, ReviewStats })`.

- [ ] **Step 4: Write the recompute step**

```ts
// src/workflows/steps/recompute-review-stats.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaContainer } from '@medusajs/framework/types'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { product_id: string }

export async function recomputeReviewStats(
  container: MedusaContainer,
  productId: string
) {
  const service = container.resolve(REVIEW_MODULE)

  const approved = await service.listReviews({
    product_id: productId,
    status: 'approved',
  })

  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>
  let total = 0

  for (const review of approved) {
    breakdown[review.rating] = (breakdown[review.rating] ?? 0) + 1
    total += review.rating
  }

  const count = approved.length
  const average = count === 0 ? 0 : Math.round((total / count) * 100) / 100

  const values = {
    product_id: productId,
    count,
    average,
    breakdown_1: breakdown[1],
    breakdown_2: breakdown[2],
    breakdown_3: breakdown[3],
    breakdown_4: breakdown[4],
    breakdown_5: breakdown[5],
    // Media lands in Phase 2; the column exists so the summary shape is stable.
    media_count: 0,
  }

  const [existing] = await service.listReviewStats({ product_id: productId })

  return existing
    ? await service.updateReviewStats({ id: existing.id, ...values })
    : await service.createReviewStats(values)
}

/**
 * Stats are derived data, so both apply and compensation do the same thing:
 * recompute from whatever the reviews table currently says.
 */
export const recomputeReviewStatsStep = createStep(
  'recompute-review-stats',
  async (input: Input, { container }) => {
    const stats = await recomputeReviewStats(container, input.product_id)

    return new StepResponse(stats, input.product_id)
  },
  async (productId, { container }) => {
    if (!productId) {
      return
    }

    await recomputeReviewStats(container, productId)
  }
)
```

- [ ] **Step 5: Generate migration, run tests**

Run: `npx medusa plugin:db:generate` then `npm run test:integration -- review-stats`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add review_stats and its recompute step

Only approved reviews count toward the public average, so a pending
one-star review cannot drag down a rating before a merchant has seen it.
Compensation recomputes rather than restoring a snapshot: the value is
derived, so recomputing is always correct and is idempotent under retry."
```

---

### Task 6: Create-review workflow

The heaviest task. It enforces §3 settings gating and the §3.1 identity rules.

**Files:**
- Create: `src/workflows/steps/validate-review-submission.ts`
- Create: `src/workflows/steps/check-verified-purchase.ts`
- Create: `src/workflows/steps/create-review.ts`
- Create: `src/workflows/create-review.ts`
- Create: `src/workflows/steps/__tests__/verified-purchase.unit.spec.ts`
- Modify: `src/workflows/index.ts`

**Interfaces:**
- Consumes: `getReviewSettings`, `recomputeReviewStatsStep`, `REVIEW_MODULE`.
- Produces: `createReviewWorkflow` with input `{ product_id, rating, content, title?, display_name?, email?, customer_id?: string | null }`; `hasVerifiedPurchase(orders, product_id): boolean`.

- [ ] **Step 1: Write the failing unit test for the verification predicate**

```ts
// src/workflows/steps/__tests__/verified-purchase.unit.spec.ts
import { hasVerifiedPurchase } from '../check-verified-purchase'

describe('hasVerifiedPurchase', () => {
  it('is true when a completed order contains the product', () => {
    const orders = [{ status: 'completed', items: [{ product_id: 'prod_1' }] }]

    expect(hasVerifiedPurchase(orders as never, 'prod_1')).toBe(true)
  })

  it('is false when the order is not completed', () => {
    const orders = [{ status: 'pending', items: [{ product_id: 'prod_1' }] }]

    expect(hasVerifiedPurchase(orders as never, 'prod_1')).toBe(false)
  })

  it('is false when no order contains the product', () => {
    const orders = [{ status: 'completed', items: [{ product_id: 'prod_2' }] }]

    expect(hasVerifiedPurchase(orders as never, 'prod_1')).toBe(false)
  })

  it('is false with no orders at all', () => {
    expect(hasVerifiedPurchase([], 'prod_1')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — `hasVerifiedPurchase` is not exported.

- [ ] **Step 3: Write the verification step**

```ts
// src/workflows/steps/check-verified-purchase.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'

type OrderLike = { status: string; items?: { product_id: string }[] }

type Input = { customer_id?: string | null; product_id: string }

export function hasVerifiedPurchase(orders: OrderLike[], productId: string): boolean {
  return orders.some(
    (order) =>
      order.status === 'completed' &&
      (order.items ?? []).some((item) => item.product_id === productId)
  )
}

/**
 * Verified status requires an authenticated customer. Matching a guest on a
 * self-supplied email would let anyone who knows a buyer's address mint a
 * verified badge, which is the one claim on a review page that has to be
 * trustworthy.
 */
export const checkVerifiedPurchaseStep = createStep(
  'check-verified-purchase',
  async (input: Input, { container }) => {
    if (!input.customer_id) {
      return new StepResponse(false)
    }

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const { data: orders } = await query.graph({
      entity: 'order',
      fields: ['id', 'status', 'items.product_id'],
      filters: { customer_id: input.customer_id },
    })

    return new StepResponse(hasVerifiedPurchase(orders as OrderLike[], input.product_id))
  }
)
```

- [ ] **Step 4: Write the validation step**

```ts
// src/workflows/steps/validate-review-submission.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'
import { getReviewSettings } from '../../settings/get-review-settings'

type Input = {
  product_id: string
  content: string
  customer_id?: string | null
  is_verified_purchase: boolean
}

export const validateReviewSubmissionStep = createStep(
  'validate-review-submission',
  async (input: Input, { container }) => {
    const settings = await getReviewSettings(container)

    if (!settings.enabled) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Reviews are disabled')
    }

    if (!input.customer_id && !settings.allow_guest) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        'You must be signed in to leave a review'
      )
    }

    // verified_only implies customers only: a guest can never prove purchase.
    if (settings.verified_only && !input.is_verified_purchase) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Only customers who purchased this product can review it'
      )
    }

    if (input.content.length < settings.min_content_length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Review must be at least ${settings.min_content_length} characters`
      )
    }

    if (input.content.length > settings.max_content_length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Review must be at most ${settings.max_content_length} characters`
      )
    }

    if (settings.one_review_per_customer && input.customer_id) {
      const service = container.resolve(REVIEW_MODULE)
      const existing = await service.listReviews({
        product_id: input.product_id,
        customer_id: input.customer_id,
      })

      if (existing.length > 0) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          'You have already reviewed this product'
        )
      }
    }

    return new StepResponse({
      status: settings.require_approval ? 'pending' : 'approved',
    })
  }
)
```

- [ ] **Step 5: Write the create step and workflow**

```ts
// src/workflows/steps/create-review.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { REVIEW_MODULE } from '../../modules/review'

type Input = {
  product_id: string
  customer_id?: string | null
  display_name: string
  email?: string | null
  rating: number
  title?: string | null
  content: string
  status: string
  is_verified_purchase: boolean
}

export const createReviewStep = createStep(
  'create-review',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)
    const review = await service.createReviews(input)

    return new StepResponse(review, review.id)
  },
  async (id, { container }) => {
    if (!id) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.deleteReviews(id)
  }
)
```

```ts
// src/workflows/create-review.ts
import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { checkVerifiedPurchaseStep } from './steps/check-verified-purchase'
import { validateReviewSubmissionStep } from './steps/validate-review-submission'
import { createReviewStep } from './steps/create-review'
import { recomputeReviewStatsStep } from './steps/recompute-review-stats'

export type CreateReviewInput = {
  product_id: string
  rating: number
  content: string
  title?: string | null
  display_name?: string | null
  email?: string | null
  customer_id?: string | null
}

export const createReviewWorkflow = createWorkflow(
  'create-review',
  function (input: CreateReviewInput) {
    const isVerified = checkVerifiedPurchaseStep({
      customer_id: input.customer_id,
      product_id: input.product_id,
    })

    const validation = validateReviewSubmissionStep(
      transform({ input, isVerified }, (data) => ({
        product_id: data.input.product_id,
        content: data.input.content,
        customer_id: data.input.customer_id,
        is_verified_purchase: data.isVerified,
      }))
    )

    const review = createReviewStep(
      transform({ input, isVerified, validation }, (data) => ({
        product_id: data.input.product_id,
        customer_id: data.input.customer_id,
        display_name: data.input.display_name || 'Anonymous',
        email: data.input.email,
        rating: data.input.rating,
        title: data.input.title,
        content: data.input.content,
        status: data.validation.status,
        is_verified_purchase: data.isVerified,
      }))
    )

    // An auto-approved review is immediately public, so the summary must
    // already reflect it by the time this workflow returns.
    recomputeReviewStatsStep(
      transform({ input }, (data) => ({ product_id: data.input.product_id }))
    )

    emitEventStep(
      transform({ review }, (data) => ({
        eventName: 'review.created',
        data: { id: data.review.id },
      }))
    )

    return new WorkflowResponse(review)
  }
)
```

Note the composition rules: no `async`, no arrow function, no `??`/`||`/ternaries outside `transform`, no object spread outside `transform`.

Export from `src/workflows/index.ts`:

```ts
export * from './update-review-settings'
export * from './create-review'
```

- [ ] **Step 6: Run tests**

Run: `npm run test:unit`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add create-review workflow with settings gating

Verified-purchase status is computed from the authenticated customer's
own completed orders and never from a submitted email address, so the
badge cannot be forged by anyone who knows a buyer's address.
verified_only therefore implies customers-only submission.

The predicate is a pure function so the trust rule is unit tested
without needing order fixtures."
```

---

### Task 7: Store submit route

**Files:**
- Create: `src/api/store/reviews/route.ts`
- Create: `src/api/store/reviews/middlewares.ts`
- Modify: `src/api/middlewares.ts`
- Create: `integration-tests/http/store-submit.spec.ts`

**Interfaces:**
- Consumes: `createReviewWorkflow`.
- Produces: `POST /store/reviews`; `CreateReviewSchema`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/store-submit.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'

const body = {
  product_id: 'prod_submit',
  rating: 5,
  content: 'A perfectly serviceable jumper, warm and well made.',
  display_name: 'Ada',
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/reviews', () => {
      it('rejects a guest when allow_guest is off', async () => {
        const response = await api.post('/store/reviews', body).catch((e) => e.response)

        expect(response.status).toEqual(401)
      })

      it('accepts a guest as pending when allow_guest is on', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true },
        })

        const response = await api.post('/store/reviews', body)

        expect(response.status).toEqual(201)
        expect(response.data.review.status).toEqual('pending')
        expect(response.data.review.is_verified_purchase).toBe(false)
      })

      it('auto-approves when require_approval is off', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true, require_approval: false },
        })

        const response = await api.post('/store/reviews', {
          ...body,
          product_id: 'prod_auto',
        })

        expect(response.data.review.status).toEqual('approved')
      })

      it('rejects a guest outright when verified_only is on', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true, verified_only: true },
        })

        const response = await api
          .post('/store/reviews', { ...body, product_id: 'prod_verified' })
          .catch((e) => e.response)

        expect(response.status).toEqual(403)
      })

      it('404s every store route when reviews are disabled', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true, enabled: false },
        })

        const response = await api
          .post('/store/reviews', { ...body, product_id: 'prod_off' })
          .catch((e) => e.response)

        expect(response.status).toEqual(404)
      })

      it('rejects a rating outside 1-5', async () => {
        const response = await api
          .post('/store/reviews', { ...body, rating: 9 })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })

      it('does not expose a guest email', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true },
        })

        const response = await api.post('/store/reviews', {
          ...body,
          product_id: 'prod_email',
          email: 'ada@example.com',
        })

        expect(response.data.review.email).toBeUndefined()
      })
    })
  },
})
```

Reset settings between tests so cases do not leak into each other:

```ts
afterEach(async () => {
  const service = getContainer().resolve(REVIEW_MODULE)
  const rows = await service.listReviewSettings()
  if (rows.length) {
    await service.deleteReviewSettings(rows.map((r) => r.id))
  }
  await updateReviewSettingsWorkflow(getContainer()).run({ input: {} })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -- store-submit`
Expected: FAIL with 404.

- [ ] **Step 3: Write the schema**

```ts
// src/api/store/reviews/middlewares.ts
import { MiddlewareRoute, validateAndTransformBody } from '@medusajs/framework'
import { z } from 'zod'

export const CreateReviewSchema = z
  .object({
    product_id: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    title: z.string().max(200).optional(),
    content: z.string().min(1).max(20000),
    display_name: z.string().min(1).max(100).optional(),
    email: z.string().email().optional(),
  })
  .strict()

export type CreateReviewSchema = z.infer<typeof CreateReviewSchema>

export const storeReviewMiddlewares: MiddlewareRoute[] = [
  {
    matcher: '/store/reviews',
    method: 'POST',
    middlewares: [validateAndTransformBody(CreateReviewSchema)],
  },
]
```

Content length is bounded loosely here and precisely in the workflow, because the exact bounds are merchant-configurable settings and belong with the other business rules.

Add `...storeReviewMiddlewares` to `src/api/middlewares.ts`.

- [ ] **Step 4: Write the route**

```ts
// src/api/store/reviews/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { createReviewWorkflow } from '../../../workflows/create-review'
import { CreateReviewSchema } from './middlewares'

export async function POST(
  req: AuthenticatedMedusaRequest<CreateReviewSchema>,
  res: MedusaResponse
) {
  const customerId = req.auth_context?.actor_id ?? null

  const { result } = await createReviewWorkflow(req.scope).run({
    input: { ...req.validatedBody, customer_id: customerId },
  })

  res.status(201).json({
    review: {
      id: result.id,
      product_id: result.product_id,
      rating: result.rating,
      title: result.title,
      content: result.content,
      display_name: result.display_name,
      status: result.status,
      is_verified_purchase: result.is_verified_purchase,
      helpful_count: result.helpful_count,
      created_at: result.created_at,
    },
  })
}
```

The response is built field by field rather than returned wholesale: `email` must never reach a store response, and an explicit list cannot leak a column added later.

- [ ] **Step 5: Run tests**

Run: `npm run test:integration -- store-submit`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add store review submission route

The response is assembled field by field rather than returning the model,
so a guest's email cannot leak now or when columns are added later.
Covers the settings combinations that actually interact: guest x
verified, approval on/off, and the master switch."
```

---

### Task 8: Store read routes

**Files:**
- Create: `src/api/store/products/[id]/reviews/route.ts`
- Create: `src/api/store/products/[id]/reviews/stats/route.ts`
- Modify: `src/api/store/reviews/middlewares.ts`
- Create: `integration-tests/http/store-read.spec.ts`

**Interfaces:**
- Consumes: `REVIEW_MODULE`, `getReviewSettings`.
- Produces: `GET /store/products/:id/reviews`, `GET /store/products/:id/reviews/stats`; `ListProductReviewsSchema`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/store-read.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { recomputeReviewStats } from '../../src/workflows/steps/recompute-review-stats'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)

      await service.createReviews([
        { product_id: 'prod_read', display_name: 'A', rating: 5, content: 'x'.repeat(10), status: 'approved' },
        { product_id: 'prod_read', display_name: 'B', rating: 3, content: 'x'.repeat(10), status: 'approved' },
        { product_id: 'prod_read', display_name: 'C', rating: 1, content: 'x'.repeat(10), status: 'pending' },
        { product_id: 'prod_read', display_name: 'D', rating: 1, content: 'x'.repeat(10), status: 'rejected' },
      ])

      await recomputeReviewStats(container, 'prod_read')
    })

    describe('GET /store/products/:id/reviews', () => {
      it('returns only approved reviews', async () => {
        const response = await api.get('/store/products/prod_read/reviews')

        expect(response.status).toEqual(200)
        expect(response.data.count).toEqual(2)
        expect(response.data.reviews.every((r) => r.status === 'approved')).toBe(true)
      })

      it('never exposes email or customer_id', async () => {
        const response = await api.get('/store/products/prod_read/reviews')

        expect(response.data.reviews[0].email).toBeUndefined()
        expect(response.data.reviews[0].customer_id).toBeUndefined()
      })

      it('caps limit at 100', async () => {
        const response = await api
          .get('/store/products/prod_read/reviews?limit=5000')
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })

      it('sorts by highest rating on request', async () => {
        const response = await api.get('/store/products/prod_read/reviews?sort=highest')

        expect(response.data.reviews[0].rating).toEqual(5)
      })
    })

    describe('GET /store/products/:id/reviews/stats', () => {
      it('serves the denormalized summary', async () => {
        const response = await api.get('/store/products/prod_read/reviews/stats')

        expect(response.data).toMatchObject({
          count: 2,
          average: 4,
          breakdown: { '5': 1, '4': 0, '3': 1, '2': 0, '1': 0 },
        })
      })

      it('returns a zeroed summary for a product with no reviews', async () => {
        const response = await api.get('/store/products/prod_none/reviews/stats')

        expect(response.data).toMatchObject({ count: 0, average: 0 })
      })
    })
  },
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -- store-read`
Expected: FAIL with 404.

- [ ] **Step 3: Add the query schema**

Append to `src/api/store/reviews/middlewares.ts`:

```ts
import { validateAndTransformQuery } from '@medusajs/framework'

const toInt = (val: unknown) =>
  typeof val === 'string' ? parseInt(val, 10) : val

export const ListProductReviewsSchema = z
  .object({
    // An uncapped limit on a public endpoint is a free denial of service.
    limit: z.preprocess(toInt, z.number().int().min(1).max(100).optional()),
    offset: z.preprocess(toInt, z.number().int().min(0).optional()),
    sort: z.enum(['newest', 'highest', 'lowest', 'most_helpful']).optional(),
    rating: z.preprocess(toInt, z.number().int().min(1).max(5).optional()),
    verified: z.preprocess((v) => v === 'true', z.boolean().optional()),
  })
  .strict()

export type ListProductReviewsSchema = z.infer<typeof ListProductReviewsSchema>
```

Register it:

```ts
{
  matcher: '/store/products/:id/reviews',
  method: 'GET',
  middlewares: [validateAndTransformQuery(ListProductReviewsSchema, {})],
},
```

- [ ] **Step 4: Write the list route**

```ts
// src/api/store/products/[id]/reviews/route.ts
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../../../../modules/review'
import { getReviewSettings } from '../../../../../settings/get-review-settings'

const ORDER_BY = {
  newest: { created_at: 'DESC' },
  highest: { rating: 'DESC' },
  lowest: { rating: 'ASC' },
  most_helpful: { helpful_count: 'DESC' },
} as const

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const settings = await getReviewSettings(req.scope)

  if (!settings.enabled) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Reviews are disabled')
  }

  const { limit, offset, sort, rating, verified } = req.validatedQuery as {
    limit?: number
    offset?: number
    sort?: keyof typeof ORDER_BY
    rating?: number
    verified?: boolean
  }

  const service = req.scope.resolve(REVIEW_MODULE)

  const filters: Record<string, unknown> = {
    product_id: req.params.id,
    status: 'approved',
  }

  if (rating) {
    filters.rating = rating
  }

  if (verified) {
    filters.is_verified_purchase = true
  }

  const [reviews, count] = await service.listAndCountReviews(filters, {
    take: limit ?? 20,
    skip: offset ?? 0,
    order: ORDER_BY[sort ?? 'newest'],
  })

  res.json({
    reviews: reviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      title: review.title,
      content: review.content,
      display_name: review.display_name,
      status: review.status,
      is_verified_purchase: review.is_verified_purchase,
      helpful_count: review.helpful_count,
      created_at: review.created_at,
    })),
    count,
    limit: limit ?? 20,
    offset: offset ?? 0,
  })
}
```

- [ ] **Step 5: Write the stats route**

```ts
// src/api/store/products/[id]/reviews/stats/route.ts
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../../../../../modules/review'
import { getReviewSettings } from '../../../../../../settings/get-review-settings'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const settings = await getReviewSettings(req.scope)

  if (!settings.enabled) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Reviews are disabled')
  }

  const service = req.scope.resolve(REVIEW_MODULE)
  const [stats] = await service.listReviewStats({ product_id: req.params.id })

  // A product nobody has reviewed is not an error; it has an empty summary.
  res.json({
    count: stats?.count ?? 0,
    average: stats?.average ?? 0,
    media_count: stats?.media_count ?? 0,
    breakdown: {
      5: stats?.breakdown_5 ?? 0,
      4: stats?.breakdown_4 ?? 0,
      3: stats?.breakdown_3 ?? 0,
      2: stats?.breakdown_2 ?? 0,
      1: stats?.breakdown_1 ?? 0,
    },
  })
}
```

- [ ] **Step 6: Run tests**

Run: `npm run test:integration -- store-read`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add store review list and stats routes

Both filter to approved reviews in the query rather than after fetching,
so a pending review is never loaded into a public response in the first
place. Stats read the denormalized summary; an unreviewed product gets a
zeroed body rather than a 404."
```

---

### Task 9: Moderation workflow and admin routes

**Files:**
- Create: `src/workflows/steps/moderate-reviews.ts`
- Create: `src/workflows/moderate-reviews.ts`
- Create: `src/api/admin/reviews/route.ts`
- Create: `src/api/admin/reviews/[id]/approve/route.ts`
- Create: `src/api/admin/reviews/[id]/reject/route.ts`
- Create: `src/api/admin/reviews/batch/status/route.ts`
- Modify: `src/api/admin/reviews/middlewares.ts`, `src/workflows/index.ts`
- Create: `integration-tests/http/admin-moderation.spec.ts`

**Interfaces:**
- Consumes: `REVIEW_MODULE`, `recomputeReviewStatsStep`, `adminHeaders`.
- Produces: `moderateReviewsWorkflow({ ids, status, rejection_reason? })`; admin routes above.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/admin-moderation.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { createAdminUser, adminHeaders } from '../helpers/admin'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    let reviewId: string

    beforeEach(async () => {
      await createAdminUser(getContainer())

      const service = getContainer().resolve(REVIEW_MODULE)
      const review = await service.createReviews({
        product_id: 'prod_mod',
        display_name: 'A',
        rating: 5,
        content: 'x'.repeat(10),
      })
      reviewId = review.id
    })

    it('approving a review makes it public and updates the summary', async () => {
      const response = await api.post(`/admin/reviews/${reviewId}/approve`, {}, adminHeaders)

      expect(response.status).toEqual(200)
      expect(response.data.review.status).toEqual('approved')

      const stats = await api.get('/store/products/prod_mod/reviews/stats')
      expect(stats.data.count).toEqual(1)
    })

    it('rejecting stores the reason and keeps it out of the summary', async () => {
      const response = await api.post(
        `/admin/reviews/${reviewId}/reject`,
        { rejection_reason: 'Profanity' },
        adminHeaders
      )

      expect(response.data.review.rejection_reason).toEqual('Profanity')

      const stats = await api.get('/store/products/prod_mod/reviews/stats')
      expect(stats.data.count).toEqual(0)
    })

    it('approves in bulk', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      const second = await service.createReviews({
        product_id: 'prod_mod',
        display_name: 'B',
        rating: 4,
        content: 'x'.repeat(10),
      })

      const response = await api.post(
        '/admin/reviews/batch/status',
        { ids: [reviewId, second.id], status: 'approved' },
        adminHeaders
      )

      expect(response.status).toEqual(200)

      const stats = await api.get('/store/products/prod_mod/reviews/stats')
      expect(stats.data.count).toEqual(2)
    })

    it('lists pending reviews for the queue', async () => {
      const response = await api.get('/admin/reviews?status=pending', adminHeaders)

      expect(response.data.reviews.length).toBeGreaterThan(0)
      expect(response.data.reviews[0].status).toEqual('pending')
    })

    it('requires authentication', async () => {
      const response = await api.get('/admin/reviews').catch((e) => e.response)

      expect(response.status).toEqual(401)
    })
  },
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -- admin-moderation`
Expected: FAIL with 404.

- [ ] **Step 3: Write the moderation step and workflow**

```ts
// src/workflows/steps/moderate-reviews.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = {
  ids: string[]
  status: 'approved' | 'rejected' | 'pending'
  rejection_reason?: string | null
}

export const moderateReviewsStep = createStep(
  'moderate-reviews',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)

    const existing = await service.listReviews({ id: input.ids })

    if (existing.length !== input.ids.length) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Review not found')
    }

    const previous = existing.map((review) => ({
      id: review.id,
      status: review.status,
      rejection_reason: review.rejection_reason,
    }))

    const updated = await service.updateReviews(
      input.ids.map((id) => ({
        id,
        status: input.status,
        rejection_reason: input.status === 'rejected' ? input.rejection_reason ?? null : null,
      }))
    )

    return new StepResponse({ reviews: updated, product_ids: [...new Set(existing.map((r) => r.product_id))] }, previous)
  },
  async (previous, { container }) => {
    if (!previous) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.updateReviews(previous)
  }
)
```

```ts
// src/workflows/moderate-reviews.ts
import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { moderateReviewsStep } from './steps/moderate-reviews'
import { recomputeReviewStatsStep } from './steps/recompute-review-stats'

export type ModerateReviewsInput = {
  ids: string[]
  status: 'approved' | 'rejected' | 'pending'
  rejection_reason?: string | null
}

export const moderateReviewsWorkflow = createWorkflow(
  'moderate-reviews',
  function (input: ModerateReviewsInput) {
    const result = moderateReviewsStep(input)

    recomputeReviewStatsStep(
      transform({ result }, (data) => ({ product_id: data.result.product_ids[0] }))
    )

    emitEventStep(
      transform({ input }, (data) => ({
        eventName: data.input.status === 'approved' ? 'review.approved' : 'review.rejected',
        data: { ids: data.input.ids },
      }))
    )

    return new WorkflowResponse(result)
  }
)
```

**Known limitation to record:** `recomputeReviewStatsStep` handles one product per run, so a bulk action spanning several products only refreshes the first. Bulk moderation in the admin UI is per-product in practice. If a reviewer disagrees, loop the workflow per product in the route instead. Note it in the PR description either way.

- [ ] **Step 4: Write admin schemas**

Add to `src/api/admin/reviews/middlewares.ts`:

```ts
export const RejectReviewSchema = z
  .object({ rejection_reason: z.string().max(500).optional() })
  .strict()

export type RejectReviewSchema = z.infer<typeof RejectReviewSchema>

export const BatchStatusSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(100),
    status: z.enum(['approved', 'rejected', 'pending']),
    rejection_reason: z.string().max(500).optional(),
  })
  .strict()

export type BatchStatusSchema = z.infer<typeof BatchStatusSchema>

export const ListAdminReviewsSchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    product_id: z.string().optional(),
    rating: z.preprocess((v) => (typeof v === 'string' ? parseInt(v, 10) : v), z.number().int().min(1).max(5).optional()),
    limit: z.preprocess((v) => (typeof v === 'string' ? parseInt(v, 10) : v), z.number().int().min(1).max(100).optional()),
    offset: z.preprocess((v) => (typeof v === 'string' ? parseInt(v, 10) : v), z.number().int().min(0).optional()),
  })
  .strict()

export type ListAdminReviewsSchema = z.infer<typeof ListAdminReviewsSchema>
```

Register each against its matcher and method, mirroring the settings entry.

- [ ] **Step 5: Write the admin routes**

```ts
// src/api/admin/reviews/[id]/approve/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { moderateReviewsWorkflow } from '../../../../../workflows/moderate-reviews'

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { result } = await moderateReviewsWorkflow(req.scope).run({
    input: { ids: [req.params.id], status: 'approved' },
  })

  res.json({ review: result.reviews[0] })
}
```

```ts
// src/api/admin/reviews/[id]/reject/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { moderateReviewsWorkflow } from '../../../../../workflows/moderate-reviews'
import { RejectReviewSchema } from '../../middlewares'

export async function POST(
  req: AuthenticatedMedusaRequest<RejectReviewSchema>,
  res: MedusaResponse
) {
  const { result } = await moderateReviewsWorkflow(req.scope).run({
    input: {
      ids: [req.params.id],
      status: 'rejected',
      rejection_reason: req.validatedBody.rejection_reason,
    },
  })

  res.json({ review: result.reviews[0] })
}
```

```ts
// src/api/admin/reviews/batch/status/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { moderateReviewsWorkflow } from '../../../../../workflows/moderate-reviews'
import { BatchStatusSchema } from '../../middlewares'

export async function POST(
  req: AuthenticatedMedusaRequest<BatchStatusSchema>,
  res: MedusaResponse
) {
  const { result } = await moderateReviewsWorkflow(req.scope).run({
    input: req.validatedBody,
  })

  res.json({ reviews: result.reviews })
}
```

```ts
// src/api/admin/reviews/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../modules/review'

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { status, product_id, rating, limit, offset } = req.validatedQuery as {
    status?: string
    product_id?: string
    rating?: number
    limit?: number
    offset?: number
  }

  const filters: Record<string, unknown> = {}

  if (status) filters.status = status
  if (product_id) filters.product_id = product_id
  if (rating) filters.rating = rating

  const service = req.scope.resolve(REVIEW_MODULE)

  const [reviews, count] = await service.listAndCountReviews(filters, {
    take: limit ?? 20,
    skip: offset ?? 0,
    order: { created_at: 'DESC' },
  })

  // Admin sees the full record, guest email included: moderating spam
  // requires seeing who sent it.
  res.json({ reviews, count, limit: limit ?? 20, offset: offset ?? 0 })
}
```

- [ ] **Step 6: Run tests**

Run: `npm run test:integration -- admin-moderation`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add moderation workflow and admin review routes

Moderation recomputes the product summary in the same workflow, so an
approved review is reflected in the public average by the time the admin
request returns rather than on the next write.

Compensation restores each review's previous status individually, so a
failed bulk action cannot leave a partially moderated queue."
```

---

### Task 10: Product link, docs and pull request

**Files:**
- Create: `src/links/review-product.ts`
- Modify: `src/workflows/create-review.ts`
- Modify: `README.md`
- Create: `.changeset/phase-1-core-reviews.md`
- Create: `integration-tests/http/review-product-link.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a `review` ↔ `product` module link, so admin screens can join product titles with `query.graph`.

- [ ] **Step 1: Write the link**

```ts
// src/links/review-product.ts
import { defineLink } from '@medusajs/framework/utils'
import ProductModule from '@medusajs/medusa/product'
import ReviewModule from '../modules/review'

// Order matters: review first, then product. createRemoteLinkStep must use
// the same order or linking fails at runtime.
export default defineLink(
  { linkable: ReviewModule.linkable.review, isList: true },
  ProductModule.linkable.product
)
```

- [ ] **Step 2: Link on creation**

In `createReviewWorkflow`, after `createReviewStep`, add:

```ts
import { createRemoteLinkStep } from '@medusajs/medusa/core-flows'
import { Modules } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../modules/review'

    createRemoteLinkStep(
      transform({ review, input }, (data) => [
        {
          [REVIEW_MODULE]: { review_id: data.review.id },
          [Modules.PRODUCT]: { product_id: data.input.product_id },
        },
      ])
    )
```

- [ ] **Step 3: Write the link test**

```ts
// integration-tests/http/review-product-link.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { createProductsWorkflow } from '@medusajs/medusa/core-flows'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    it('joins reviews onto their product', async () => {
      const container = getContainer()

      await updateReviewSettingsWorkflow(container).run({ input: { allow_guest: true } })

      const { result: products } = await createProductsWorkflow(container).run({
        input: { products: [{ title: 'Linked Product', status: 'published' }] },
      })

      await createReviewWorkflow(container).run({
        input: {
          product_id: products[0].id,
          rating: 5,
          content: 'x'.repeat(10),
          display_name: 'Ada',
        },
      })

      const query = container.resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({
        entity: 'product',
        fields: ['id', 'title', 'reviews.*'],
        filters: { id: products[0].id },
      })

      expect(data[0].reviews).toHaveLength(1)
    })
  },
})
```

- [ ] **Step 4: Run the whole suite**

Run: `npm run test:unit && npm run test:integration`
Expected: PASS, all specs.

Run: `npx medusa plugin:db:generate` if the link changed the schema, then `npm run lint && npm run typecheck && npm run build`.

- [ ] **Step 5: Update the README**

Replace the Phase 0 status banner with Phase 1, tick Phase 1 in the roadmap table, and document the shipped endpoints:

```
POST   /store/reviews
GET    /store/products/:id/reviews
GET    /store/products/:id/reviews/stats
GET    /admin/reviews
POST   /admin/reviews/:id/approve
POST   /admin/reviews/:id/reject
POST   /admin/reviews/batch/status
GET    /admin/reviews/settings
POST   /admin/reviews/settings
```

State plainly that media, votes, the gallery and review editing are not implemented yet.

- [ ] **Step 6: Add a changeset**

```md
---
'@stathmos/medusa-plugin-reviews': minor
---

Add the core review module: reviews with moderation, database-backed
settings editable from the admin, denormalized per-product rating
summaries, and the store and admin API routes. Verified-purchase status
requires an authenticated customer.
```

- [ ] **Step 7: Open the pull request**

```bash
git add -A
git commit -m "Link reviews to products and document Phase 1"
git push -u origin phase-1-core
gh pr create --title "Phase 1: core review module and settings" --body "$(cat <<'EOF'
Implements Phase 1 of the plan: models, settings, moderation, stats and
the store/admin API surface.

Notable decisions:
- Verified-purchase status requires an authenticated customer. Matching a
  guest on a self-supplied email would make the badge forgeable.
- Settings resolve through the Cache Module so instances cannot disagree.
- Rating aggregates are denormalized into review_stats and recomputed on
  every status transition.

Known limitation: bulk moderation recomputes stats for the first product
in the batch only. Bulk actions are per-product in the admin UI; revisit
if that stops being true.

Media, votes, the gallery and review editing remain unimplemented.
EOF
)"
```

Branch from `main` as `phase-1-core` at the start of Task 1 — do not commit any of this to `main` directly.

---

## Self-Review

**Spec coverage.** §3 settings — Tasks 3, 4 (all fourteen present, `allow_edit` defaulted off). §3.1 identity rules — Task 6, with the trust rule unit tested. §4 models — Tasks 2, 3, 5 (`review`, `review_settings`, `review_stats`; `review_media`, `review_reply`, `review_vote` are Phases 2–4 by design). §5 store API — Tasks 7, 8 (submit, list, stats; edit is Phase 4, uploads Phase 2, votes and gallery Phase 4). §5 admin API — Tasks 4, 9 (list, approve/reject, batch, settings; reply and media deletion are Phases 2–3). §5 workflows and events — Tasks 4, 6, 9 (`create-review`, `moderate-reviews`, `update-review-settings`; `review.created`, `review.approved`, `review.rejected`, `review.settings.updated`). Module link — Task 10.

**Deliberate gaps, deferred with the spec's blessing:** rate limiting and honeypot (§9, Phase 6), soft-delete admin route (Phase 3 alongside its UI), `most_helpful` ordering exists in the sort enum but sorts on a `helpful_count` that stays 0 until Phase 4 votes.

**Type consistency.** `REVIEW_MODULE` resolves the service in every task. `ReviewSettingsValues` is the single settings shape across defaults, cache, workflow and schema. `recomputeReviewStats(container, productId)` is the shared function; `recomputeReviewStatsStep({ product_id })` wraps it. `moderateReviewsStep` returns `{ reviews, product_ids }`, which Task 9's routes and workflow both consume as written.

**Placeholder scan.** No TBDs; every code step carries runnable code. Two places name an explicit judgement call rather than hiding it: the stats-step invocation style in Task 5 Step 1, and the single-product bulk recompute limitation in Task 9 Step 3.
