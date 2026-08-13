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
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/reviews/uploads', () => {
      let storeHeaders: Record<string, string>

      beforeAll(async () => {
        storeHeaders = await getPublishableKeyHeaders(getContainer())
      })

      it('accepts an image and returns media without exposing the storage path', async () => {
        const form = new FormData()
        form.append('files', new Blob([await png()] as BlobPart[], { type: 'image/png' }), 'photo.png')

        const response = await api.post('/store/reviews/uploads', form, {
          headers: storeHeaders,
        })

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
          new Blob([Buffer.from('#!/bin/sh\nrm -rf /')] as BlobPart[], { type: 'image/png' }),
          'evil.png'
        )

        const response = await api
          .post('/store/reviews/uploads', form, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })

      it('rejects a request with no files', async () => {
        const response = await api
          .post('/store/reviews/uploads', new FormData(), { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })

      // Proves the multer `limits.fileSize` ceiling (100MB, set in
      // src/api/store/reviews/middlewares.ts) is enforced at the transport
      // layer, before a single byte is buffered into the route/workflow -
      // not by the workflow's own settings-driven max_image_size_mb/
      // max_video_size_mb check, which is a distinct, later gate. A
      // transport-layer rejection surfaces as a raw MulterError, which
      // this repo's error-handler does not special-case (see the status
      // assertion below and the report for what that means).
      it('rejects a file larger than the multer fileSize ceiling, at the transport layer', async () => {
        const oversized = Buffer.alloc(100 * 1024 * 1024 + 1)

        const form = new FormData()
        form.append('files', new Blob([oversized] as BlobPart[], { type: 'image/png' }), 'huge.png')

        const response = await api
          .post('/store/reviews/uploads', form, { headers: storeHeaders })
          .catch((e) => e.response)

        // Not 400: a MulterError has neither `.type` (MedusaError) nor an
        // `http-errors` statusCode, so it falls through the framework's
        // error-handler switch to its `default` branch, which leaves
        // statusCode at 500. This is a real gap - a transport-layer
        // rejection surfacing as an opaque 500 instead of a clean 4xx -
        // flagged in the report as a follow-up, not fixed here (fixing it
        // would mean building error-mapping machinery, out of scope for
        // this round).
        expect(response.status).toEqual(500)
      })

      // Proves the multer `limits.files` ceiling (20) is enforced at the
      // transport layer too, independent of the workflow's
      // max_media_per_review setting (default 5, checked later and
      // separately - see upload-review-media.spec.ts for that case).
      it('rejects a request with more files than the multer files ceiling', async () => {
        const form = new FormData()
        for (let i = 0; i < 21; i++) {
          form.append('files', new Blob([Buffer.from('x')] as BlobPart[], { type: 'image/png' }), `f${i}.png`)
        }

        const response = await api
          .post('/store/reviews/uploads', form, { headers: storeHeaders })
          .catch((e) => e.response)

        // Same reasoning as the fileSize case above: a MulterError is
        // unmapped by the framework's error-handler and falls through to
        // its default 500.
        expect(response.status).toEqual(500)
      })
    })
  },
})
