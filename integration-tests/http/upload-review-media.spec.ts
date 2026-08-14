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

// Noise, not a flat color: a flat-color PNG compresses to well under 100
// bytes regardless of pixel dimensions, which makes it useless for proving
// a size cap actually measures real bytes. max_image_size_mb is an integer
// column (a fractional MB setting silently truncates to 0, which would
// reject everything and make the test pass for the wrong reason), so this
// needs to comfortably clear a whole-megabyte cap: 700x700 random noise
// reliably encodes to well over 1MB.
async function largeNoisyPngBuffer(): Promise<Buffer> {
  const width = 700
  const height = 700
  const raw = Buffer.alloc(width * height * 3)

  for (let i = 0; i < raw.length; i++) {
    raw[i] = Math.floor(Math.random() * 256)
  }

  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/**
 * A palette PNG that is comfortably UNDER a 1MB cap on arrival (~0.46MB)
 * but re-encodes to just OVER it (~1.05MB), because a palette image handed
 * back as full-colour RGB inflates. This is the M3 case measured in the
 * review: 770,201 bytes in, 3,392,806 bytes stored, 4.41x.
 *
 * 4900x4900 is 24MP, deliberately just under the 25MP decode budget, so
 * this exercises the size check rather than tripping the pixel bound.
 */
async function inflatingPaletteFixture(): Promise<Buffer> {
  const width = 4900
  const height = 4900
  const colours = 128
  const raw = Buffer.alloc(width * height * 3)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      const c = ((x >> 1) ^ (y >> 1)) % colours
      raw[i] = (c * 37) % 256
      raw[i + 1] = (c * 91) % 256
      raw[i + 2] = (c * 151) % 256
    }
  }

  return await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ palette: true, colours, compressionLevel: 9 })
    .toBuffer()
}

/**
 * A real WebM header: the EBML magic plus a genuine DocType element
 * (ID 0x42 0x82, single-byte size form) whose value is "webm", which is
 * what sniffMime actually reads.
 *
 * This matters more than it looks. The fixture this file used to carry was
 * the magic bytes plus 64 zeroes - no DocType element at all - so sniffMime
 * returned null and the workflow rejected it as "Unsupported file type"
 * without ever reaching the allow_video branch the test is named for.
 * Deleting the entire allow_video check left that test green.
 */
function webm(): Buffer {
  const docType = 'webm'
  const offset = 20
  const buffer = Buffer.alloc(64)

  buffer[0] = 0x1a
  buffer[1] = 0x45
  buffer[2] = 0xdf
  buffer[3] = 0xa3
  buffer[offset] = 0x42
  buffer[offset + 1] = 0x82
  buffer[offset + 2] = 0x80 | docType.length
  buffer.write(docType, offset + 3, 'ascii')

  return buffer
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
 *
 * `messageIncludes` is required, not optional: asserting only that
 * *something* threw meant every rejection test here passed on any error at
 * all - a wrong error from a different gate, a fixture typo, a dropped DB
 * connection. That is how the allow_video test above spent its whole life
 * testing the format sniffer instead.
 */
async function expectRejection(
  promise: Promise<unknown>,
  messageIncludes: string
): Promise<void> {
  let threw = false
  try {
    await promise
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain(messageIncludes)
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
          }),
          'Unsupported file type for innocent.png'
        )
      })

      it('rejects an image larger than max_image_size_mb', async () => {
        const container = getContainer()

        // 1MB: comfortably below the ~1.4MB a 700x700 noise PNG actually
        // encodes to, so this only passes if the real bytes are measured.
        await updateReviewSettingsWorkflow(container).run({
          input: { max_image_size_mb: 1 },
        })

        const buf = await largeNoisyPngBuffer()

        await expectRejection(
          uploadReviewMediaWorkflow(container).run({
            input: {
              files: [
                {
                  filename: 'huge.png',
                  content: buf.toString('base64'),
                  size_bytes: buf.length,
                },
              ],
            },
          }),
          'huge.png exceeds the 1MB limit'
        )
      })

      it('rejects a file whose real bytes exceed the limit even when size_bytes lies about being tiny', async () => {
        const container = getContainer()

        await updateReviewSettingsWorkflow(container).run({
          input: { max_image_size_mb: 1 },
        })

        const buf = await largeNoisyPngBuffer()

        // The attack: real payload is ~1.4MB, well over the 1MB cap, but
        // the client claims size_bytes: 1. This is the case that proves
        // the fix - the earlier version of this check trusted size_bytes
        // and let this straight through.
        await expectRejection(
          uploadReviewMediaWorkflow(container).run({
            input: {
              files: [
                { filename: 'lied-about-size.png', content: buf.toString('base64'), size_bytes: 1 },
              ],
            },
          }),
          'lied-about-size.png exceeds the 1MB limit'
        )
      })

      /**
       * max_image_size_mb was checked only on the bytes that arrived, but
       * stripExif re-encodes afterwards and can produce a LARGER file - so
       * a merchant setting 5MB could end up storing ~22MB. The setting is a
       * promise about what gets stored, so the encoded length is checked
       * against the same limit.
       *
       * This fixture arrives under the cap and only exceeds it after
       * processing, so the arrival check cannot be what rejects it.
       */
      it('rejects an image that only exceeds max_image_size_mb after re-encoding', async () => {
        const container = getContainer()

        await updateReviewSettingsWorkflow(container).run({
          input: { max_image_size_mb: 1 },
        })

        const buf = await inflatingPaletteFixture()

        // Load-bearing: if this ever stopped being true the test would be
        // proving the arrival check instead.
        expect(buf.length).toBeLessThan(1024 * 1024)

        await expectRejection(
          uploadReviewMediaWorkflow(container).run({
            input: {
              files: [
                { filename: 'inflates.png', content: buf.toString('base64'), size_bytes: buf.length },
              ],
            },
          }),
          'inflates.png is 2MB once processed, over the 1MB limit'
        )
      })

      it('rejects video uploads when allow_video is off', async () => {
        const container = getContainer()

        // Positive control first, with video still allowed: this proves the
        // fixture actually reaches the allow_video branch instead of dying
        // at the sniffer. Without it the rejection below proves only that
        // *something* refused the file, which is exactly how this test
        // previously passed while testing nothing about allow_video.
        const { result } = await uploadReviewMediaWorkflow(container).run({
          input: {
            files: [
              { filename: 'clip.webm', content: webm().toString('base64'), size_bytes: 100 },
            ],
          },
        })
        expect(result.media[0].mime_type).toBe('video/webm')

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_video: false },
        })

        await expectRejection(
          uploadReviewMediaWorkflow(container).run({
            input: {
              files: [
                { filename: 'clip.webm', content: webm().toString('base64'), size_bytes: 100 },
              ],
            },
          }),
          'Video uploads are disabled'
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
          }),
          'Media uploads are disabled'
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
          }),
          'At most 2 files may be uploaded'
        )
      })
    })
  },
})
