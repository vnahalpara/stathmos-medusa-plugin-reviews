# Phase 2: Review Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let shoppers attach photos and videos to a review, stored through Medusa's File Module, with server-side content validation and no orphaned files left behind.

**Architecture:** A `review_media` model in the existing `review` module holds file references — never bytes. Uploads go through a two-stage flow: `POST /store/reviews/uploads` validates and stores files, returning ids; `POST /store/reviews` then attaches those ids to the new review. Media inherits its parent review's visibility rather than carrying its own status, so approval logic stays in one place. A scheduled job deletes media that was uploaded but never attached.

**Tech Stack:** Medusa v2.18, TypeScript, MikroORM data models, Zod (`@medusajs/framework/zod`), multer (memory storage), sharp (EXIF stripping), Jest + `@medusajs/test-utils`, npm.

**Spec:** `/opt/homebrew/var/www/Medusa-review-extension/.claude/review-extension-plan.md` — §3 (settings), §4 (`review_media` model), §5 (API), §6 (media handling). Referenced below as §N.

## Global Constraints

- Medusa peer range `^2.18.0`; Node 20–24; package manager **npm** (not pnpm).
- **Only GET, POST, DELETE** — never PUT or PATCH.
- **Every mutation goes through a workflow.** Routes never call the module service to write.
- All business validation lives in workflow steps, never in route handlers.
- Import Zod from `@medusajs/framework/zod`, **never** from `zod` — the `@medusajs/zod-import-source` lint rule fails the build.
- Every `/store/*` test request needs an `x-publishable-api-key` header, or Medusa returns 400 before the handler runs. Use `integration-tests/helpers/store.ts`.
- `resolve(REVIEW_MODULE)` is globally typed by a `ModuleImplementations` augmentation — do **not** add per-call-site annotations.
- Data models must not declare `created_at`/`updated_at`/`deleted_at` (Medusa adds them) and must not use `.linkable()`.
- **Do not add a `defineLink` to any store-exposed entity.** Phase 1 removed the `review`↔`product` link because it leaked review PII through Medusa's core store product routes (`?fields=*reviews`). Any future link needs an HTTP-layer leak test first.
- Observed error mapping in this codebase: `NOT_ALLOWED` → 400, `NOT_FOUND` → 404, `UNAUTHORIZED` → 401, `INVALID_DATA` → 400.
- Run `npm run lint && npm run typecheck && npm run build` plus both test suites before every commit.
- Media belonging to a review that is not `approved` must never be reachable from any store endpoint.

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/review/models/review-media.ts` | The `review_media` data model |
| `src/media/sniff-mime.ts` | Magic-byte content sniffing + allow-list (pure, unit-tested) |
| `src/media/strip-exif.ts` | Image re-encode / EXIF removal via sharp |
| `src/workflows/steps/upload-review-media.ts` | Validate + store files, create unattached media rows |
| `src/workflows/upload-review-media.ts` | Upload workflow composition |
| `src/workflows/steps/attach-review-media.ts` | Attach uploaded media to a review |
| `src/workflows/steps/delete-review-media.ts` | Admin single-media removal |
| `src/workflows/delete-review-media.ts` | Delete workflow composition |
| `src/jobs/sweep-orphan-review-media.ts` | Scheduled orphan cleanup |
| `src/api/store/reviews/uploads/route.ts` | `POST /store/reviews/uploads` |
| `src/api/admin/reviews/media/[id]/route.ts` | `DELETE /admin/reviews/media/:id` |

---

### Task 1: Magic-byte sniffing

Content type must be determined from the bytes, never from the client's `Content-Type` header. A spoofed header on a 50 MB "video" is how a review plugin becomes arbitrary file hosting. Pure functions first, so the security rule is unit-tested without a database.

**Files:**
- Create: `src/media/sniff-mime.ts`
- Create: `src/media/__tests__/sniff-mime.unit.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sniffMime(buffer: Buffer): string | null`; `ALLOWED_IMAGE_MIMES: string[]`; `ALLOWED_VIDEO_MIMES: string[]`; `mediaTypeFor(mime: string): 'image' | 'video' | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/media/__tests__/sniff-mime.unit.spec.ts
import { sniffMime, mediaTypeFor } from '../sniff-mime'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00])

function riff(kind: string): Buffer {
  const b = Buffer.alloc(16)
  b.write('RIFF', 0, 'ascii')
  b.write(kind, 8, 'ascii')
  return b
}

function mp4(): Buffer {
  const b = Buffer.alloc(16)
  b.write('ftyp', 4, 'ascii')
  b.write('isom', 8, 'ascii')
  return b
}

const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00])

describe('sniffMime', () => {
  it('detects jpeg', () => {
    expect(sniffMime(jpeg)).toBe('image/jpeg')
  })

  it('detects png', () => {
    expect(sniffMime(png)).toBe('image/png')
  })

  it('detects webp', () => {
    expect(sniffMime(riff('WEBP'))).toBe('image/webp')
  })

  it('detects mp4', () => {
    expect(sniffMime(mp4())).toBe('video/mp4')
  })

  it('detects webm', () => {
    expect(sniffMime(webm)).toBe('video/webm')
  })

  it('returns null for a disallowed type even though it is a real image', () => {
    expect(sniffMime(gif)).toBeNull()
  })

  it('returns null for arbitrary bytes', () => {
    expect(sniffMime(Buffer.from('#!/bin/sh\nrm -rf /'))).toBeNull()
  })

  it('returns null for an empty or truncated buffer', () => {
    expect(sniffMime(Buffer.alloc(0))).toBeNull()
    expect(sniffMime(Buffer.from([0xff]))).toBeNull()
  })
})

describe('mediaTypeFor', () => {
  it('classifies images', () => {
    expect(mediaTypeFor('image/png')).toBe('image')
  })

  it('classifies videos', () => {
    expect(mediaTypeFor('video/mp4')).toBe('video')
  })

  it('rejects anything else', () => {
    expect(mediaTypeFor('application/pdf')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — cannot find module `../sniff-mime`.

- [ ] **Step 3: Implement**

```ts
// src/media/sniff-mime.ts

/**
 * Content type is determined from the file's own bytes, never from the
 * client-supplied Content-Type header. A spoofed header is how an upload
 * endpoint turns into arbitrary file hosting.
 */
export const ALLOWED_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const

export const ALLOWED_VIDEO_MIMES = ['video/mp4', 'video/webm'] as const

const startsWith = (buf: Buffer, bytes: number[], offset = 0): boolean => {
  if (buf.length < offset + bytes.length) {
    return false
  }

  return bytes.every((byte, i) => buf[offset + i] === byte)
}

const asciiAt = (buf: Buffer, offset: number, length: number): string =>
  buf.length < offset + length
    ? ''
    : buf.subarray(offset, offset + length).toString('ascii')

export function sniffMime(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 8) {
    return null
  }

  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg'
  }

  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }

  // RIFF containers: bytes 0-3 "RIFF", bytes 8-11 identify the payload.
  if (asciiAt(buffer, 0, 4) === 'RIFF' && asciiAt(buffer, 8, 4) === 'WEBP') {
    return 'image/webp'
  }

  // ISO base media: bytes 4-7 "ftyp", brand follows at 8.
  if (asciiAt(buffer, 4, 4) === 'ftyp') {
    const brand = asciiAt(buffer, 8, 4)

    if (brand === 'avif' || brand === 'avis') {
      return 'image/avif'
    }

    return 'video/mp4'
  }

  // Matroska/WebM EBML header.
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
    return 'video/webm'
  }

  return null
}

export function mediaTypeFor(mime: string): 'image' | 'video' | null {
  if ((ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)) {
    return 'image'
  }

  if ((ALLOWED_VIDEO_MIMES as readonly string[]).includes(mime)) {
    return 'video'
  }

  return null
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit`
Expected: PASS (11 new tests).

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add src/media
git commit -m "Add magic-byte content sniffing for review media

Content type comes from the file's own bytes, never the client's
Content-Type header — a spoofed header on a large 'video' is how an
upload endpoint becomes arbitrary file hosting. A real GIF is rejected
too: the allow-list is about what this plugin serves, not what is a
valid image."
```

---

### Task 2: The `review_media` model

**Files:**
- Create: `src/modules/review/models/review-media.ts`
- Modify: `src/modules/review/service.ts`
- Create: `integration-tests/http/review-media-model.spec.ts`

**Interfaces:**
- Consumes: `REVIEW_MODULE`.
- Produces: service methods `createReviewMedias`, `listReviewMedias`, `listAndCountReviewMedias`, `retrieveReviewMedia`, `updateReviewMedias`, `deleteReviewMedias`. Fields: `id, review_id (nullable), type, file_id, url, thumbnail_url, mime_type, size_bytes, sort_order, pinned_at, hidden_at`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/review-media-model.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('review_media model', () => {
      it('creates an unattached media row with an rmed id', async () => {
        const service = getContainer().resolve(REVIEW_MODULE)

        const media = await service.createReviewMedias({
          type: 'image',
          file_id: 'file_test_1',
          url: 'http://localhost/static/file_test_1.png',
          mime_type: 'image/png',
          size_bytes: 1234,
        })

        expect(media.id).toMatch(/^rmed_/)
        expect(media.review_id).toBeNull()
        expect(media.sort_order).toBe(0)
        expect(media.pinned_at).toBeNull()
        expect(media.hidden_at).toBeNull()
      })
    })
  },
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:integration -- review-media-model`
Expected: FAIL — `createReviewMedias` is not a function.

- [ ] **Step 3: Write the model**

```ts
// src/modules/review/models/review-media.ts
import { model } from '@medusajs/framework/utils'

/**
 * A reference to a file in Medusa's File Module — this plugin never stores
 * bytes itself.
 *
 * `review_id` is nullable because media is uploaded before the review that
 * will own it exists. Rows that are never attached are deleted by the
 * orphan sweep job, otherwise every abandoned review form would leak a
 * stored file forever.
 *
 * There is deliberately NO status column: visibility is derived from the
 * parent review, so approval logic lives in exactly one place and cannot
 * drift.
 */
export const ReviewMedia = model
  .define('review_media', {
    id: model.id({ prefix: 'rmed' }).primaryKey(),
    review_id: model.text().nullable(),
    type: model.enum(['image', 'video']),
    file_id: model.text(),
    url: model.text(),
    thumbnail_url: model.text().nullable(),
    mime_type: model.text(),
    size_bytes: model.number(),
    sort_order: model.number().default(0),
    // Gallery curation columns ship now; the admin UI for them is Phase 4.
    // Adding columns later is a migration; declaring them now is free.
    pinned_at: model.dateTime().nullable(),
    hidden_at: model.dateTime().nullable(),
  })
  .indexes([{ on: ['review_id'] }, { on: ['file_id'] }])
```

Register it in the service:

```ts
// src/modules/review/service.ts
import { MedusaService } from '@medusajs/framework/utils'
import { Review } from './models/review'
import { ReviewSettings } from './models/review-settings'
import { ReviewStats } from './models/review-stats'
import { ReviewMedia } from './models/review-media'

class ReviewModuleService extends MedusaService({
  Review,
  ReviewSettings,
  ReviewStats,
  ReviewMedia,
}) {}

export default ReviewModuleService
```

- [ ] **Step 4: Generate the migration**

Run: `npx medusa plugin:db:generate`
Open the generated file and confirm it creates `review_media` with both indexes.

- [ ] **Step 5: Run tests**

Run: `npm run test:integration -- review-media-model`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add review_media model

review_id is nullable because media is uploaded before the review exists;
unattached rows are swept later. No status column — visibility derives
from the parent review so approval logic cannot drift out of sync."
```

---

### Task 3: EXIF stripping

The spec promises EXIF removal for privacy. Photos from phones carry GPS coordinates; publishing a customer's home location alongside their review would be a serious privacy failure. `sharp` must be a real dependency, not an optional peer — as an optional peer the guarantee silently becomes a no-op when it is absent.

**Files:**
- Create: `src/media/strip-exif.ts`
- Create: `src/media/__tests__/strip-exif.unit.spec.ts`
- Modify: `package.json` (add `sharp`)

**Interfaces:**
- Consumes: `mediaTypeFor` from Task 1.
- Produces: `stripExif(buffer: Buffer, mime: string): Promise<Buffer>`.

- [ ] **Step 1: Add sharp**

```bash
npm install sharp
```

- [ ] **Step 2: Write the failing test**

```ts
// src/media/__tests__/strip-exif.unit.spec.ts
import sharp from 'sharp'
import { stripExif } from '../strip-exif'

describe('stripExif', () => {
  it('removes EXIF metadata from a jpeg', async () => {
    const withExif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
    })
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-location-data' } } })
      .jpeg()
      .toBuffer()

    expect((await sharp(withExif).metadata()).exif).toBeDefined()

    const cleaned = await stripExif(withExif, 'image/jpeg')

    expect((await sharp(cleaned).metadata()).exif).toBeUndefined()
  })

  it('still produces a valid decodable image', async () => {
    const original = await sharp({
      create: { width: 12, height: 10, channels: 3, background: '#00ff00' },
    })
      .png()
      .toBuffer()

    const cleaned = await stripExif(original, 'image/png')
    const meta = await sharp(cleaned).metadata()

    expect(meta.width).toBe(12)
    expect(meta.height).toBe(10)
  })

  it('passes video through untouched', async () => {
    const fake = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])

    expect(await stripExif(fake, 'video/webm')).toBe(fake)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — cannot find module `../strip-exif`.

- [ ] **Step 4: Implement**

```ts
// src/media/strip-exif.ts
import sharp from 'sharp'
import { mediaTypeFor } from './sniff-mime'

/**
 * Re-encodes images to drop metadata. Phone photos carry GPS coordinates in
 * EXIF, so publishing them verbatim next to a review would expose where the
 * reviewer lives.
 *
 * Video passes through: stripping container metadata needs ffmpeg, which is
 * out of scope for Phase 2 (no transcoding).
 */
export async function stripExif(buffer: Buffer, mime: string): Promise<Buffer> {
  if (mediaTypeFor(mime) !== 'image') {
    return buffer
  }

  // sharp drops all metadata unless withMetadata() is called, so a plain
  // re-encode is the strip.
  return await sharp(buffer).rotate().toBuffer()
}
```

`.rotate()` with no argument applies the EXIF orientation before the data is discarded, so stripped photos are not left sideways.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:unit`
Expected: PASS (3 new tests).

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Strip EXIF from uploaded images

sharp is a real dependency, not an optional peer: as a peer the privacy
guarantee silently no-ops when it is missing. rotate() applies the
orientation tag before the metadata is discarded so photos are not left
sideways."
```

---

### Task 4: Upload workflow

**Files:**
- Create: `src/workflows/steps/upload-review-media.ts`
- Create: `src/workflows/upload-review-media.ts`
- Modify: `src/workflows/index.ts`
- Create: `integration-tests/http/upload-review-media.spec.ts`

**Interfaces:**
- Consumes: `sniffMime`, `mediaTypeFor`, `stripExif`, `getReviewSettings`, `REVIEW_MODULE`.
- Produces: `uploadReviewMediaWorkflow` with input `{ files: { filename: string; content: string; size_bytes: number }[] }` (content is base64) returning `{ media: { id, type, url, thumbnail_url, mime_type }[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/upload-review-media.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'

async function pngBase64(): Promise<string> {
  const buf = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#0000ff' },
  })
    .png()
    .toBuffer()

  return buf.toString('base64')
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('uploadReviewMediaWorkflow', () => {
      it('stores an image and returns an unattached media row', async () => {
        const container = getContainer()

        const { result } = await uploadReviewMediaWorkflow(container).run({
          input: {
            files: [
              { filename: 'photo.png', content: await pngBase64(), size_bytes: 100 },
            ],
          },
        })

        expect(result.media).toHaveLength(1)
        expect(result.media[0].type).toBe('image')
        expect(result.media[0].mime_type).toBe('image/png')

        const service = container.resolve(REVIEW_MODULE)
        const [row] = await service.listReviewMedias({ id: result.media[0].id })

        expect(row.review_id).toBeNull()
      })

      it('rejects a file whose bytes are not an allowed type, whatever it is named', async () => {
        const shell = Buffer.from('#!/bin/sh\nrm -rf /').toString('base64')

        await expect(
          uploadReviewMediaWorkflow(getContainer()).run({
            input: { files: [{ filename: 'innocent.png', content: shell, size_bytes: 20 }] },
          })
        ).rejects.toThrow()
      })

      it('rejects an image larger than max_image_size_mb', async () => {
        const container = getContainer()

        await updateReviewSettingsWorkflow(container).run({
          input: { max_image_size_mb: 1 },
        })

        await expect(
          uploadReviewMediaWorkflow(container).run({
            input: {
              files: [
                {
                  filename: 'huge.png',
                  content: await pngBase64(),
                  size_bytes: 5 * 1024 * 1024,
                },
              ],
            },
          })
        ).rejects.toThrow()
      })

      it('rejects video uploads when allow_video is off', async () => {
        const container = getContainer()

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_video: false },
        })

        const webm = Buffer.concat([
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
          Buffer.alloc(64),
        ]).toString('base64')

        await expect(
          uploadReviewMediaWorkflow(container).run({
            input: { files: [{ filename: 'clip.webm', content: webm, size_bytes: 100 }] },
          })
        ).rejects.toThrow()
      })

      it('rejects all uploads when allow_media is off', async () => {
        const container = getContainer()

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_media: false },
        })

        await expect(
          uploadReviewMediaWorkflow(container).run({
            input: {
              files: [{ filename: 'photo.png', content: await pngBase64(), size_bytes: 100 }],
            },
          })
        ).rejects.toThrow()
      })

      it('rejects more files than max_media_per_review in one call', async () => {
        const container = getContainer()

        await updateReviewSettingsWorkflow(container).run({
          input: { max_media_per_review: 2 },
        })

        const content = await pngBase64()

        await expect(
          uploadReviewMediaWorkflow(container).run({
            input: {
              files: [
                { filename: 'a.png', content, size_bytes: 100 },
                { filename: 'b.png', content, size_bytes: 100 },
                { filename: 'c.png', content, size_bytes: 100 },
              ],
            },
          })
        ).rejects.toThrow()
      })
    })
  },
})
```

Reset settings between tests so cases do not leak:

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

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:integration -- upload-review-media`
Expected: FAIL — cannot find module `../../src/workflows/upload-review-media`.

- [ ] **Step 3: Write the step**

```ts
// src/workflows/steps/upload-review-media.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { uploadFilesWorkflow } from '@medusajs/medusa/core-flows'
import { REVIEW_MODULE } from '../../modules/review'
import { getReviewSettings } from '../../settings/get-review-settings'
import { mediaTypeFor, sniffMime } from '../../media/sniff-mime'
import { stripExif } from '../../media/strip-exif'

type InputFile = { filename: string; content: string; size_bytes: number }

type Input = { files: InputFile[] }

export const uploadReviewMediaStep = createStep(
  'upload-review-media',
  async (input: Input, { container }) => {
    const settings = await getReviewSettings(container)

    if (!settings.enabled || !settings.allow_media) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Media uploads are disabled'
      )
    }

    if (input.files.length > settings.max_media_per_review) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `At most ${settings.max_media_per_review} files may be uploaded`
      )
    }

    const prepared = await Promise.all(
      input.files.map(async (file) => {
        const raw = Buffer.from(file.content, 'base64')

        // Sniffed from the bytes — the filename and any client-declared
        // content type are untrusted.
        const mime = sniffMime(raw)
        const type = mime ? mediaTypeFor(mime) : null

        if (!mime || !type) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `Unsupported file type for ${file.filename}`
          )
        }

        if (type === 'video' && !settings.allow_video) {
          throw new MedusaError(
            MedusaError.Types.NOT_ALLOWED,
            'Video uploads are disabled'
          )
        }

        const limitMb =
          type === 'image' ? settings.max_image_size_mb : settings.max_video_size_mb

        if (file.size_bytes > limitMb * 1024 * 1024) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `${file.filename} exceeds the ${limitMb}MB limit`
          )
        }

        const content = await stripExif(raw, mime)

        return { filename: file.filename, mime, type, content, size_bytes: content.length }
      })
    )

    const { result: files } = await uploadFilesWorkflow(container).run({
      input: {
        files: prepared.map((f) => ({
          filename: f.filename,
          mimeType: f.mime,
          content: f.content.toString('base64'),
          access: 'public' as const,
        })),
      },
    })

    const service = container.resolve(REVIEW_MODULE)

    const media = await service.createReviewMedias(
      files.map((file, i) => ({
        review_id: null,
        type: prepared[i].type,
        file_id: file.id,
        url: file.url,
        mime_type: prepared[i].mime,
        size_bytes: prepared[i].size_bytes,
        sort_order: i,
      }))
    )

    const rows = Array.isArray(media) ? media : [media]

    return new StepResponse(
      { media: rows },
      { mediaIds: rows.map((m) => m.id), fileIds: files.map((f) => f.id) }
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.deleteReviewMedias(compensation.mediaIds)
  }
)
```

- [ ] **Step 4: Write the workflow**

```ts
// src/workflows/upload-review-media.ts
import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { uploadReviewMediaStep } from './steps/upload-review-media'

export type UploadReviewMediaInput = {
  files: { filename: string; content: string; size_bytes: number }[]
}

export const uploadReviewMediaWorkflow = createWorkflow(
  'upload-review-media',
  function (input: UploadReviewMediaInput) {
    const result = uploadReviewMediaStep(input)

    return new WorkflowResponse(result)
  }
)
```

Append to `src/workflows/index.ts`:

```ts
export * from './upload-review-media'
```

- [ ] **Step 5: Run tests**

Run: `npm run test:integration -- upload-review-media`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add review media upload workflow

Validates from the file's own bytes and enforces the merchant's caps at
upload time rather than at submit — an upload endpoint that defers
validation still writes the bytes to storage first, which is the abuse
vector.

Rows are created unattached; the orphan sweep removes ones no review
ever claims."
```

---

### Task 5: Upload route

**Files:**
- Create: `src/api/store/reviews/uploads/route.ts`
- Modify: `src/api/store/reviews/middlewares.ts`
- Create: `integration-tests/http/store-uploads.spec.ts`

**Interfaces:**
- Consumes: `uploadReviewMediaWorkflow`.
- Produces: `POST /store/reviews/uploads` accepting `multipart/form-data` under the field name `files`, returning `{ media: { id, type, url, thumbnail_url, mime_type }[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/store-uploads.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { getPublishableKeyHeaders } from '../helpers/store'

async function png(): Promise<Buffer> {
  return await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer()
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api }) => {
    describe('POST /store/reviews/uploads', () => {
      it('accepts an image and returns media without exposing the storage path', async () => {
        const form = new FormData()
        form.append('files', new Blob([await png()], { type: 'image/png' }), 'photo.png')

        const response = await api.post(
          '/store/reviews/uploads',
          form,
          await getPublishableKeyHeaders()
        )

        expect(response.status).toEqual(201)
        expect(response.data.media).toHaveLength(1)
        expect(response.data.media[0].type).toEqual('image')
        expect(Object.keys(response.data.media[0]).sort()).toEqual(
          ['id', 'mime_type', 'thumbnail_url', 'type', 'url'].sort()
        )
      })

      it('rejects a shell script renamed to .png', async () => {
        const form = new FormData()
        form.append(
          'files',
          new Blob([Buffer.from('#!/bin/sh\nrm -rf /')], { type: 'image/png' }),
          'evil.png'
        )

        const response = await api
          .post('/store/reviews/uploads', form, await getPublishableKeyHeaders())
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })

      it('rejects a request with no files', async () => {
        const response = await api
          .post('/store/reviews/uploads', new FormData(), await getPublishableKeyHeaders())
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })
    })
  },
})
```

If the test client cannot build multipart bodies this way, use `form-data` plus its `getHeaders()` merged into the publishable-key headers. Adapt the mechanics, keep the three assertions.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:integration -- store-uploads`
Expected: FAIL with 404.

- [ ] **Step 3: Register multer middleware**

Add to `src/api/store/reviews/middlewares.ts`:

```ts
import multer from 'multer'

// Files are held in memory only long enough to sniff and re-encode them;
// the File Module owns persistence.
const upload = multer({ storage: multer.memoryStorage() })

// ...append to storeReviewMiddlewares:
{
  matcher: '/store/reviews/uploads',
  method: 'POST',
  middlewares: [upload.array('files')],
},
```

- [ ] **Step 4: Write the route**

```ts
// src/api/store/reviews/uploads/route.ts
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { MedusaError } from '@medusajs/framework/utils'
import { uploadReviewMediaWorkflow } from '../../../../workflows/upload-review-media'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const files = (req as MedusaRequest & { files?: Express.Multer.File[] }).files

  if (!files?.length) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'No files were uploaded')
  }

  const { result } = await uploadReviewMediaWorkflow(req.scope).run({
    input: {
      files: files.map((file) => ({
        filename: file.originalname,
        content: file.buffer.toString('base64'),
        size_bytes: file.size,
      })),
    },
  })

  // Explicit allow-list: file_id and size_bytes are internal, and an
  // allow-list cannot leak a column added in a later phase.
  res.status(201).json({
    media: result.media.map((m) => ({
      id: m.id,
      type: m.type,
      url: m.url,
      thumbnail_url: m.thumbnail_url,
      mime_type: m.mime_type,
    })),
  })
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test:integration -- store-uploads`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add store media upload route

multer keeps bytes in memory only long enough to sniff and re-encode
them; the File Module owns persistence. The response is an explicit
allow-list so internal file ids never reach a storefront."
```

---

### Task 6: Attaching media to a review

**Files:**
- Create: `src/workflows/steps/attach-review-media.ts`
- Modify: `src/workflows/create-review.ts`
- Modify: `src/api/store/reviews/middlewares.ts` (accept `media_ids`)
- Modify: `src/api/store/reviews/route.ts`
- Create: `integration-tests/http/attach-review-media.spec.ts`

**Interfaces:**
- Consumes: `uploadReviewMediaWorkflow`, `createReviewWorkflow`.
- Produces: `attachReviewMediaStep({ review_id, media_ids })`; `CreateReviewSchema` gains optional `media_ids: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/attach-review-media.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'

async function uploadOne(container) {
  const content = (
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#abcdef' } })
      .png()
      .toBuffer()
  ).toString('base64')

  const { result } = await uploadReviewMediaWorkflow(container).run({
    input: { files: [{ filename: 'p.png', content, size_bytes: 100 }] },
  })

  return result.media[0].id
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    beforeEach(async () => {
      await updateReviewSettingsWorkflow(getContainer()).run({
        input: { allow_guest: true },
      })
    })

    it('attaches uploaded media to the created review', async () => {
      const container = getContainer()
      const mediaId = await uploadOne(container)

      const { result: review } = await createReviewWorkflow(container).run({
        input: {
          product_id: 'prod_media',
          rating: 5,
          content: 'x'.repeat(20),
          display_name: 'Ada',
          media_ids: [mediaId],
        },
      })

      const service = container.resolve(REVIEW_MODULE)
      const [media] = await service.listReviewMedias({ id: mediaId })

      expect(media.review_id).toEqual(review.id)
    })

    it('refuses media that is already attached to another review', async () => {
      const container = getContainer()
      const mediaId = await uploadOne(container)

      await createReviewWorkflow(container).run({
        input: {
          product_id: 'prod_a',
          rating: 5,
          content: 'x'.repeat(20),
          display_name: 'A',
          media_ids: [mediaId],
        },
      })

      await expect(
        createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_b',
            rating: 4,
            content: 'x'.repeat(20),
            display_name: 'B',
            media_ids: [mediaId],
          },
        })
      ).rejects.toThrow()
    })

    it('refuses an unknown media id', async () => {
      await expect(
        createReviewWorkflow(getContainer()).run({
          input: {
            product_id: 'prod_c',
            rating: 4,
            content: 'x'.repeat(20),
            display_name: 'C',
            media_ids: ['rmed_does_not_exist'],
          },
        })
      ).rejects.toThrow()
    })
  },
})
```

The second test is the important one: without it, one shopper could claim another's uploaded photo by guessing its id.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:integration -- attach-review-media`
Expected: FAIL — `media_ids` is not accepted.

- [ ] **Step 3: Write the attach step**

```ts
// src/workflows/steps/attach-review-media.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { review_id: string; media_ids: string[] }

export const attachReviewMediaStep = createStep(
  'attach-review-media',
  async (input: Input, { container }) => {
    if (!input.media_ids.length) {
      return new StepResponse({ attached: [] as string[] }, [] as string[])
    }

    const service = container.resolve(REVIEW_MODULE)
    const rows = await service.listReviewMedias({ id: input.media_ids })

    if (rows.length !== new Set(input.media_ids).size) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Unknown media')
    }

    // Refusing already-attached media stops one shopper claiming another's
    // upload by guessing its id.
    const claimed = rows.filter((row) => row.review_id !== null)

    if (claimed.length) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Media is already attached to a review'
      )
    }

    await service.updateReviewMedias(
      rows.map((row, i) => ({ id: row.id, review_id: input.review_id, sort_order: i }))
    )

    return new StepResponse({ attached: rows.map((r) => r.id) }, rows.map((r) => r.id))
  },
  async (mediaIds, { container }) => {
    if (!mediaIds?.length) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.updateReviewMedias(
      mediaIds.map((id) => ({ id, review_id: null }))
    )
  }
)
```

- [ ] **Step 4: Compose it into create-review**

In `src/workflows/create-review.ts`, add `media_ids?: string[]` to `CreateReviewInput`, then after `createReviewStep`:

```ts
    attachReviewMediaStep(
      transform({ review, input }, (data) => ({
        review_id: data.review.id,
        media_ids: data.input.media_ids || [],
      }))
    )
```

The `||` sits inside `transform()`, which is where it is legal.

- [ ] **Step 5: Accept `media_ids` at the route**

Add to `CreateReviewSchema` in `src/api/store/reviews/middlewares.ts`:

```ts
    media_ids: z.array(z.string().min(1)).max(20).optional(),
```

The route already spreads `req.validatedBody` into the workflow input, so no route change is needed beyond confirming that.

- [ ] **Step 6: Run tests**

Run: `npm run test:integration -- attach-review-media`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Attach uploaded media to reviews

Media already attached to another review is refused, so a shopper cannot
claim someone else's upload by guessing its id. Attachment is a workflow
step with compensation, so a failed submission releases the media rather
than stranding it."
```

---

### Task 7: Media in store responses

**Files:**
- Modify: `src/api/store/products/[id]/reviews/route.ts`
- Modify: `src/api/store/reviews/route.ts`
- Modify: `src/workflows/steps/recompute-review-stats.ts` (real `media_count`)
- Create: `integration-tests/http/store-media-visibility.spec.ts`

**Interfaces:**
- Consumes: `REVIEW_MODULE`, `recomputeReviewStats`.
- Produces: each review in the store list response gains `media: { id, type, url, thumbnail_url }[]`; `review_stats.media_count` counts media on approved reviews.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/store-media-visibility.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { moderateReviewsWorkflow } from '../../src/workflows/moderate-reviews'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { getPublishableKeyHeaders } from '../helpers/store'

async function reviewWithMedia(container, productId: string) {
  const content = (
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#654321' } })
      .png()
      .toBuffer()
  ).toString('base64')

  const { result: uploaded } = await uploadReviewMediaWorkflow(container).run({
    input: { files: [{ filename: 'p.png', content, size_bytes: 100 }] },
  })

  const { result: review } = await createReviewWorkflow(container).run({
    input: {
      product_id: productId,
      rating: 5,
      content: 'x'.repeat(20),
      display_name: 'Ada',
      media_ids: [uploaded.media[0].id],
    },
  })

  return review
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await updateReviewSettingsWorkflow(getContainer()).run({
        input: { allow_guest: true },
      })
    })

    it('hides media of a pending review from the store', async () => {
      const container = getContainer()
      await reviewWithMedia(container, 'prod_pending_media')

      const response = await api.get(
        '/store/products/prod_pending_media/reviews',
        await getPublishableKeyHeaders()
      )

      expect(response.data.count).toEqual(0)
      expect(JSON.stringify(response.data)).not.toContain('.png')
    })

    it('exposes media once the review is approved', async () => {
      const container = getContainer()
      const review = await reviewWithMedia(container, 'prod_approved_media')

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      const response = await api.get(
        '/store/products/prod_approved_media/reviews',
        await getPublishableKeyHeaders()
      )

      expect(response.data.reviews[0].media).toHaveLength(1)
      expect(Object.keys(response.data.reviews[0].media[0]).sort()).toEqual(
        ['id', 'thumbnail_url', 'type', 'url'].sort()
      )
    })

    it('counts media of approved reviews in stats', async () => {
      const container = getContainer()
      const review = await reviewWithMedia(container, 'prod_media_stats')

      const before = await api.get(
        '/store/products/prod_media_stats/reviews/stats',
        await getPublishableKeyHeaders()
      )
      expect(before.data.media_count).toEqual(0)

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      const after = await api.get(
        '/store/products/prod_media_stats/reviews/stats',
        await getPublishableKeyHeaders()
      )
      expect(after.data.media_count).toEqual(1)
    })

    it('omits hidden media from an approved review', async () => {
      const container = getContainer()
      const review = await reviewWithMedia(container, 'prod_hidden_media')

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      const service = container.resolve(REVIEW_MODULE)
      const [media] = await service.listReviewMedias({ review_id: review.id })
      await service.updateReviewMedias({ id: media.id, hidden_at: new Date() })

      const response = await api.get(
        '/store/products/prod_hidden_media/reviews',
        await getPublishableKeyHeaders()
      )

      expect(response.data.reviews[0].media).toHaveLength(0)
    })
  },
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:integration -- store-media-visibility`
Expected: FAIL — `media` is undefined on the response.

- [ ] **Step 3: Include media in the list route**

In `src/api/store/products/[id]/reviews/route.ts`, after fetching reviews:

```ts
  const media = reviews.length
    ? await service.listReviewMedias({
        review_id: reviews.map((r) => r.id),
        hidden_at: null,
      })
    : []

  const mediaByReview = new Map<string, typeof media>()

  for (const item of media) {
    const list = mediaByReview.get(item.review_id!) ?? []
    list.push(item)
    mediaByReview.set(item.review_id!, list)
  }
```

Then add to each mapped review:

```ts
      media: (mediaByReview.get(review.id) ?? [])
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((m) => ({
          id: m.id,
          type: m.type,
          url: m.url,
          thumbnail_url: m.thumbnail_url,
        })),
```

Media is only ever fetched for reviews already filtered to `approved`, so unapproved media cannot appear — the visibility rule stays derived from the parent, exactly as the model comment promises.

- [ ] **Step 4: Include media in the submit response**

In `src/api/store/reviews/route.ts`, after running the workflow, fetch the review's media the same way and add the same `media` array to the response object.

- [ ] **Step 5: Count media in stats**

In `recomputeReviewStats`, replace the hard-coded `media_count: 0`:

```ts
  const approvedIds = approved.map((review) => review.id)

  const media = approvedIds.length
    ? await service.listReviewMedias({ review_id: approvedIds, hidden_at: null })
    : []
```

and use `media_count: media.length`.

- [ ] **Step 6: Run tests**

Run: `npm run test:integration`
Expected: PASS, whole suite.

- [ ] **Step 7: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Expose review media on store responses

Media is fetched only for reviews already filtered to approved, so
visibility stays derived from the parent review rather than duplicated —
there is no second place for the rule to drift. Hidden media is excluded
here and from the stats count."
```

---

### Task 8: Admin media deletion

**Files:**
- Create: `src/workflows/steps/delete-review-media.ts`
- Create: `src/workflows/delete-review-media.ts`
- Create: `src/api/admin/reviews/media/[id]/route.ts`
- Modify: `src/workflows/index.ts`
- Create: `integration-tests/http/admin-media-delete.spec.ts`

**Interfaces:**
- Consumes: `REVIEW_MODULE`, `deleteFilesWorkflow`, `recomputeReviewStatsStep`, admin test helpers.
- Produces: `deleteReviewMediaWorkflow({ id })`; `DELETE /admin/reviews/media/:id`.

- [ ] **Step 1: Write the failing test**

```ts
// integration-tests/http/admin-media-delete.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { moderateReviewsWorkflow } from '../../src/workflows/moderate-reviews'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { createAdminUser, adminHeaders } from '../helpers/admin'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await createAdminUser(getContainer())
      await updateReviewSettingsWorkflow(getContainer()).run({
        input: { allow_guest: true },
      })
    })

    it('removes one offensive photo without rejecting the review', async () => {
      const container = getContainer()

      const content = (
        await sharp({ create: { width: 4, height: 4, channels: 3, background: '#111111' } })
          .png()
          .toBuffer()
      ).toString('base64')

      const { result: uploaded } = await uploadReviewMediaWorkflow(container).run({
        input: {
          files: [
            { filename: 'a.png', content, size_bytes: 100 },
            { filename: 'b.png', content, size_bytes: 100 },
          ],
        },
      })

      const { result: review } = await createReviewWorkflow(container).run({
        input: {
          product_id: 'prod_admin_media',
          rating: 5,
          content: 'x'.repeat(20),
          display_name: 'Ada',
          media_ids: uploaded.media.map((m) => m.id),
        },
      })

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      const response = await api.delete(
        `/admin/reviews/media/${uploaded.media[0].id}`,
        adminHeaders
      )

      expect(response.status).toEqual(200)

      const service = container.resolve(REVIEW_MODULE)
      const remaining = await service.listReviewMedias({ review_id: review.id })
      expect(remaining).toHaveLength(1)

      const [stillThere] = await service.listReviews({ id: review.id })
      expect(stillThere.status).toEqual('approved')
    })

    it('404s an unknown media id', async () => {
      const response = await api
        .delete('/admin/reviews/media/rmed_nope', adminHeaders)
        .catch((e) => e.response)

      expect(response.status).toEqual(404)
    })

    it('requires authentication', async () => {
      const response = await api
        .delete('/admin/reviews/media/rmed_nope')
        .catch((e) => e.response)

      expect(response.status).toEqual(401)
    })
  },
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:integration -- admin-media-delete`
Expected: FAIL with 404.

- [ ] **Step 3: Write the step and workflow**

```ts
// src/workflows/steps/delete-review-media.ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { id: string }

export const deleteReviewMediaStep = createStep(
  'delete-review-media',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)
    const [media] = await service.listReviewMedias({ id: input.id })

    if (!media) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Media not found')
    }

    await service.deleteReviewMedias(input.id)

    return new StepResponse({ id: input.id, review_id: media.review_id }, media)
  },
  async (media, { container }) => {
    if (!media) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.createReviewMedias({
      id: media.id,
      review_id: media.review_id,
      type: media.type,
      file_id: media.file_id,
      url: media.url,
      thumbnail_url: media.thumbnail_url,
      mime_type: media.mime_type,
      size_bytes: media.size_bytes,
      sort_order: media.sort_order,
    })
  }
)
```

```ts
// src/workflows/delete-review-media.ts
import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { deleteReviewMediaStep } from './steps/delete-review-media'
import { recomputeReviewStatsStep } from './steps/recompute-review-stats'

export const deleteReviewMediaWorkflow = createWorkflow(
  'delete-review-media',
  function (input: { id: string }) {
    const deleted = deleteReviewMediaStep(input)

    return new WorkflowResponse(deleted)
  }
)
```

**Note on stats:** deleting media changes `media_count`, but the step only knows the media's `review_id`, not its `product_id`. Rather than adding a second query inside a composition function (illegal) or widening the step's contract, have the route resolve the review's `product_id` after the workflow and call the exported `recomputeReviewStats(container, productId)` directly. Say in your report if you find a cleaner arrangement.

- [ ] **Step 4: Write the route**

```ts
// src/api/admin/reviews/media/[id]/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../../../modules/review'
import { deleteReviewMediaWorkflow } from '../../../../../workflows/delete-review-media'
import { recomputeReviewStats } from '../../../../../workflows/steps/recompute-review-stats'

export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { result } = await deleteReviewMediaWorkflow(req.scope).run({
    input: { id: req.params.id },
  })

  if (result.review_id) {
    const service = req.scope.resolve(REVIEW_MODULE)
    const [review] = await service.listReviews({ id: result.review_id })

    if (review) {
      await recomputeReviewStats(req.scope, review.product_id)
    }
  }

  res.json({ id: result.id, object: 'review_media', deleted: true })
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test:integration -- admin-media-delete`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Add admin media deletion

Removes a single offensive photo without rejecting the whole review,
which is what a moderator usually wants. Compensation restores the row,
and the product summary is recomputed so media_count stays honest."
```

---

### Task 9: Orphan sweep job

Every abandoned review form leaves an uploaded file behind. Without this, storage grows forever and unattached media — which no moderator ever sees — accumulates indefinitely.

**Files:**
- Create: `src/jobs/sweep-orphan-review-media.ts`
- Create: `src/media/orphan-cutoff.ts`
- Create: `src/media/__tests__/orphan-cutoff.unit.spec.ts`
- Create: `integration-tests/http/orphan-sweep.spec.ts`

**Interfaces:**
- Consumes: `REVIEW_MODULE`, `deleteFilesWorkflow`.
- Produces: `sweepOrphanReviewMedia(container, now: Date): Promise<{ deleted: number }>`; `ORPHAN_TTL_HOURS = 24`.

- [ ] **Step 1: Write the failing unit test**

```ts
// src/media/__tests__/orphan-cutoff.unit.spec.ts
import { ORPHAN_TTL_HOURS, orphanCutoff } from '../orphan-cutoff'

describe('orphanCutoff', () => {
  it('is TTL hours before the given time', () => {
    const now = new Date('2026-08-13T12:00:00.000Z')

    expect(orphanCutoff(now).toISOString()).toBe('2026-08-12T12:00:00.000Z')
  })

  it('uses a 24 hour window', () => {
    expect(ORPHAN_TTL_HOURS).toBe(24)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — cannot find module `../orphan-cutoff`.

- [ ] **Step 3: Implement the cutoff**

```ts
// src/media/orphan-cutoff.ts

/**
 * How long an uploaded file may sit unattached before it is swept. Long
 * enough that a shopper can upload photos, wander off to write their review
 * and come back; short enough that abandoned forms do not accumulate.
 */
export const ORPHAN_TTL_HOURS = 24

export function orphanCutoff(now: Date): Date {
  return new Date(now.getTime() - ORPHAN_TTL_HOURS * 60 * 60 * 1000)
}
```

- [ ] **Step 4: Write the sweep integration test**

```ts
// integration-tests/http/orphan-sweep.spec.ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { sweepOrphanReviewMedia } from '../../src/jobs/sweep-orphan-review-media'

async function upload(container) {
  const content = (
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#222222' } })
      .png()
      .toBuffer()
  ).toString('base64')

  const { result } = await uploadReviewMediaWorkflow(container).run({
    input: { files: [{ filename: 'p.png', content, size_bytes: 100 }] },
  })

  return result.media[0].id
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    beforeEach(async () => {
      await updateReviewSettingsWorkflow(getContainer()).run({
        input: { allow_guest: true },
      })
    })

    it('deletes unattached media older than the TTL', async () => {
      const container = getContainer()
      const id = await upload(container)

      // 25 hours from now, so the row created just above is past the window.
      const future = new Date(Date.now() + 25 * 60 * 60 * 1000)
      const result = await sweepOrphanReviewMedia(container, future)

      expect(result.deleted).toBeGreaterThanOrEqual(1)

      const service = container.resolve(REVIEW_MODULE)
      expect(await service.listReviewMedias({ id })).toHaveLength(0)
    })

    it('leaves recent unattached media alone', async () => {
      const container = getContainer()
      const id = await upload(container)

      await sweepOrphanReviewMedia(container, new Date())

      const service = container.resolve(REVIEW_MODULE)
      expect(await service.listReviewMedias({ id })).toHaveLength(1)
    })

    it('never deletes media attached to a review, however old', async () => {
      const container = getContainer()
      const mediaId = await upload(container)

      await createReviewWorkflow(container).run({
        input: {
          product_id: 'prod_sweep',
          rating: 5,
          content: 'x'.repeat(20),
          display_name: 'Ada',
          media_ids: [mediaId],
        },
      })

      const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365)
      await sweepOrphanReviewMedia(container, future)

      const service = container.resolve(REVIEW_MODULE)
      expect(await service.listReviewMedias({ id: mediaId })).toHaveLength(1)
    })
  },
})
```

The third test is the one that matters: a sweep bug that deletes attached media would destroy published reviews' photos.

- [ ] **Step 5: Implement the job**

```ts
// src/jobs/sweep-orphan-review-media.ts
import { MedusaContainer } from '@medusajs/framework/types'
import { deleteFilesWorkflow } from '@medusajs/medusa/core-flows'
import { REVIEW_MODULE } from '../modules/review'
import { orphanCutoff } from '../media/orphan-cutoff'

/**
 * Uploads happen before the review exists, so every abandoned review form
 * leaves a stored file behind. Without this sweep, storage grows forever
 * with media no moderator will ever see.
 *
 * `now` is a parameter rather than read from the clock so the behaviour is
 * testable without waiting a day.
 */
export async function sweepOrphanReviewMedia(
  container: MedusaContainer,
  now: Date
): Promise<{ deleted: number }> {
  const service = container.resolve(REVIEW_MODULE)

  const orphans = await service.listReviewMedias({
    review_id: null,
    created_at: { $lt: orphanCutoff(now) },
  })

  if (!orphans.length) {
    return { deleted: 0 }
  }

  await service.deleteReviewMedias(orphans.map((media) => media.id))

  await deleteFilesWorkflow(container).run({
    input: { ids: orphans.map((media) => media.file_id) },
  })

  return { deleted: orphans.length }
}

export default async function sweepOrphanReviewMediaJob(container: MedusaContainer) {
  const logger = container.resolve('logger')
  const { deleted } = await sweepOrphanReviewMedia(container, new Date())

  if (deleted > 0) {
    logger.info(`[reviews] swept ${deleted} orphaned media upload(s)`)
  }
}

export const config = {
  name: 'sweep-orphan-review-media',
  schedule: '0 * * * *',
}
```

Delete the database rows before the files: if file deletion fails, a row pointing at a missing file is a broken image, whereas a file with no row is invisible and will never be swept again.

- [ ] **Step 6: Run tests**

Run: `npm run test:unit && npm run test:integration -- orphan-sweep`
Expected: PASS (2 unit + 3 integration).

- [ ] **Step 7: Commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A
git commit -m "Sweep orphaned review media uploads

Uploads precede the review that owns them, so every abandoned form leaks
a stored file. The sweep runs hourly over media unattached for more than
24 hours. `now` is injected so the window is testable without waiting a
day, and attached media is never touched regardless of age."
```

---

### Task 10: Docs and changeset

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `.changeset/phase-2-media.md`

- [ ] **Step 1: Update the README**

Move Phase 2 to ✅ in the roadmap and update the status banner. Add the two new endpoints to the API table:

```
POST   /store/reviews/uploads      Upload review photos/videos (multipart, field name "files")
DELETE /admin/reviews/media/:id    Remove a single media item
```

Document, in plain language:
- accepted formats: JPEG, PNG, WebP, AVIF, MP4, WebM — determined from file contents, not the filename;
- that size and count limits come from the settings (`max_media_per_review`, `max_image_size_mb`, `max_video_size_mb`) and can be changed without a redeploy;
- that images are re-encoded to strip EXIF, so GPS coordinates in phone photos are not published;
- that uploads not attached to a review within 24 hours are deleted automatically;
- that video is stored as uploaded — **no transcoding and no server-generated poster frame in Phase 2**; storefronts should supply their own poster or use the first frame.

Keep the "not implemented" list honest: the gallery API, helpful votes, merchant replies and review editing are still absent.

- [ ] **Step 2: Update the CHANGELOG**

Add to `## Unreleased` describing photo/video support, the validation approach, EXIF stripping and the sweep job, and state the no-transcoding limitation.

- [ ] **Step 3: Add the changeset**

```md
---
'@stathmos/medusa-plugin-reviews': minor
---

Add photo and video review media: uploads through Medusa's File Module
with content-sniffed validation, EXIF stripping, merchant-configurable
size and count limits, media on store review responses, admin media
deletion, and an hourly sweep of uploads never attached to a review.
```

- [ ] **Step 4: Full verification**

Run: `npm run lint && npm run typecheck && npm run build && npm run test:unit && npm run test:integration`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Document Phase 2 media support"
```

Do **not** push or open a PR — the controller handles that.

---

## Self-Review

**Spec coverage.** §4 `review_media` — Task 2, with `pinned_at`/`hidden_at` present and no mirrored status column, as the spec requires. §6 File Module storage — Task 4; magic-byte sniffing — Task 1; upload-time validation of type, size and count — Task 4; EXIF stripping with sharp as a real dependency — Task 3; orphan sweep — Task 9; "media of non-approved reviews is never returned by any store endpoint, enforced in the service layer" — Task 7, where media is only fetched for reviews already filtered to approved. §5 `POST /store/reviews/uploads` — Task 5; media on `POST /store/reviews` — Task 6; `DELETE /admin/reviews/media/:id` — Task 8. §3 settings `allow_media`, `allow_video`, `max_media_per_review`, `max_image_size_mb`, `max_video_size_mb` — all enforced in Task 4; they already exist from Phase 1, so no settings changes are needed.

**Deliberate gaps.** No video transcoding and no server-generated poster frame (§6 defers both; `thumbnail_url` exists and stays null, documented in Task 10). Rate limiting on the upload endpoint is §9/Phase 6 — worth noting that until then this is an unauthenticated write to object storage, which the README should not oversell. Gallery curation UI for `pinned_at`/`hidden_at` is Phase 4; the columns ship here and `hidden_at` is already honoured on read.

**Type consistency.** `sniffMime(Buffer): string | null` and `mediaTypeFor(string): 'image' | 'video' | null` from Task 1 are used unchanged in Tasks 3 and 4. `uploadReviewMediaWorkflow` input `{ files: { filename, content, size_bytes }[] }` is identical in Tasks 4, 5, 6, 7, 8 and 9. `attachReviewMediaStep({ review_id, media_ids })` in Task 6 matches its call site in `create-review.ts`. `recomputeReviewStats(container, productId)` in Task 8 matches the Phase 1 signature. `sweepOrphanReviewMedia(container, now)` in Task 9 matches both its test and the job wrapper.

**Placeholder scan.** No TBDs; every code step carries runnable code. Two places name a judgement call rather than hiding it: the multipart mechanics in Task 5 Step 1 (adapt the client, keep the assertions) and the stats recompute arrangement in Task 8 Step 3.
