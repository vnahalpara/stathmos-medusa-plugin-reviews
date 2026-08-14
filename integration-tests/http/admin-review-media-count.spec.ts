import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { createAdminUser, adminHeaders } from '../helpers/admin'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await createAdminUser(getContainer())
    })

    /**
     * The half that distinguishes this from the store-facing
     * countVisibleReviewMedias() rule: a moderator must see what is
     * actually attached to a review, including media they (or an earlier
     * moderator) already hid. If GET /admin/reviews reused the store rule
     * here, this review would report 2, not 3, and a moderator would never
     * think to open it and check.
     */
    it('counts all attached media in the moderation list, including a hidden item', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)

      const review = await service.createReviews({
        product_id: 'prod_media_count',
        display_name: 'Guest',
        rating: 5,
        content: 'x'.repeat(10),
      })

      await service.createReviewMedias([
        {
          review_id: review.id,
          type: 'image',
          file_id: 'file_mc_1',
          url: 'http://localhost/static/file_mc_1.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
        {
          review_id: review.id,
          type: 'image',
          file_id: 'file_mc_2',
          url: 'http://localhost/static/file_mc_2.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
      ])
      const [hidden] = await service.createReviewMedias([
        {
          review_id: review.id,
          type: 'image',
          file_id: 'file_mc_3',
          url: 'http://localhost/static/file_mc_3.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
      ])
      await service.updateReviewMedias({ id: hidden.id, hidden_at: new Date() })

      const response = await api.get('/admin/reviews?product_id=prod_media_count', adminHeaders)

      const found = response.data.reviews.find((r: { id: string }) => r.id === review.id)
      expect(found).toBeDefined()
      // 3, not 2 - the hidden item MUST still be counted.
      expect(found.media_count).toEqual(3)
    })

    it('reports 0 for a review with no media', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      await service.createReviews({
        product_id: 'prod_media_count_none',
        display_name: 'Guest',
        rating: 5,
        content: 'x'.repeat(10),
      })

      const response = await api.get(
        '/admin/reviews?product_id=prod_media_count_none',
        adminHeaders
      )

      expect(response.data.reviews).toHaveLength(1)
      expect(response.data.reviews[0].media_count).toEqual(0)
    })

    it("does not bleed one review's media count into another's", async () => {
      const service = getContainer().resolve(REVIEW_MODULE)

      const first = await service.createReviews({
        product_id: 'prod_media_count_bleed',
        display_name: 'First',
        rating: 5,
        content: 'x'.repeat(10),
      })
      const second = await service.createReviews({
        product_id: 'prod_media_count_bleed',
        display_name: 'Second',
        rating: 5,
        content: 'y'.repeat(10),
      })

      await service.createReviewMedias([
        {
          review_id: first.id,
          type: 'image',
          file_id: 'file_bleed_1',
          url: 'http://localhost/static/file_bleed_1.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
        {
          review_id: first.id,
          type: 'image',
          file_id: 'file_bleed_2',
          url: 'http://localhost/static/file_bleed_2.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
      ])
      await service.createReviewMedias([
        {
          review_id: second.id,
          type: 'image',
          file_id: 'file_bleed_3',
          url: 'http://localhost/static/file_bleed_3.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
      ])

      const response = await api.get(
        '/admin/reviews?product_id=prod_media_count_bleed',
        adminHeaders
      )

      const firstRow = response.data.reviews.find((r: { id: string }) => r.id === first.id)
      const secondRow = response.data.reviews.find((r: { id: string }) => r.id === second.id)

      expect(firstRow.media_count).toEqual(2)
      expect(secondRow.media_count).toEqual(1)
    })
  },
})
