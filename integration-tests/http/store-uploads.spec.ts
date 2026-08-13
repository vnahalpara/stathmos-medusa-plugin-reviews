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
    })
  },
})
