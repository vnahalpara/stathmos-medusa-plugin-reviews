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

/**
 * `expect(promise).rejects.toThrow()` is unreliable for workflow `.run()`
 * promises in this test runner - documented already in
 * update-review-settings-compensation.spec.ts, where it intermittently
 * reported "did not throw" even though the workflow demonstrably rejected.
 * The same thing was verified here directly: every rejection case below
 * throws when awaited in a plain try/catch, but `.rejects.toThrow()`
 * reported "did not throw" for all five of them. A try/catch is used
 * instead, matching the existing house pattern.
 */
async function expectRejection(promise: Promise<unknown>): Promise<void> {
  let threw = false
  try {
    await promise
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('uploadReviewMediaWorkflow', () => {
      afterEach(async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const rows = await service.listReviewSettings()
        if (rows.length) {
          await service.deleteReviewSettings(rows.map((r) => r.id))
        }
        await updateReviewSettingsWorkflow(getContainer()).run({ input: {} })
      })

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

        await expectRejection(
          uploadReviewMediaWorkflow(getContainer()).run({
            input: { files: [{ filename: 'innocent.png', content: shell, size_bytes: 20 }] },
          })
        )
      })

      it('rejects an image larger than max_image_size_mb', async () => {
        const container = getContainer()

        await updateReviewSettingsWorkflow(container).run({
          input: { max_image_size_mb: 1 },
        })

        await expectRejection(
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
        )
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

        await expectRejection(
          uploadReviewMediaWorkflow(container).run({
            input: { files: [{ filename: 'clip.webm', content: webm, size_bytes: 100 }] },
          })
        )
      })

      it('rejects all uploads when allow_media is off', async () => {
        const container = getContainer()

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_media: false },
        })

        await expectRejection(
          uploadReviewMediaWorkflow(container).run({
            input: {
              files: [{ filename: 'photo.png', content: await pngBase64(), size_bytes: 100 }],
            },
          })
        )
      })

      it('rejects more files than max_media_per_review in one call', async () => {
        const container = getContainer()

        await updateReviewSettingsWorkflow(container).run({
          input: { max_media_per_review: 2 },
        })

        const content = await pngBase64()

        await expectRejection(
          uploadReviewMediaWorkflow(container).run({
            input: {
              files: [
                { filename: 'a.png', content, size_bytes: 100 },
                { filename: 'b.png', content, size_bytes: 100 },
                { filename: 'c.png', content, size_bytes: 100 },
              ],
            },
          })
        )
      })
    })
  },
})
