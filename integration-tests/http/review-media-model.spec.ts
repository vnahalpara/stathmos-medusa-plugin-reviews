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
