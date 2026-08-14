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
        product_id: 'prod_stats',
        display_name: 'A',
        rating: 5,
        content: 'x'.repeat(10),
      })
      reviewId = review.id
    })

    it('returns the denormalized summary for a product', async () => {
      await api.post(`/admin/reviews/${reviewId}/approve`, {}, adminHeaders)

      const response = await api.get('/admin/reviews/stats/prod_stats', adminHeaders)

      expect(response.status).toEqual(200)
      expect(response.data.count).toEqual(1)
      expect(response.data.average).toEqual(5)
      // A numeric average matters here: the widget this feeds does
      // arithmetic on it, and Postgres numeric/float columns sometimes
      // arrive as strings through the driver - a "5" would concatenate
      // rather than add.
      expect(typeof response.data.average).toBe('number')
    })

    it('returns zeros for a product with no reviews', async () => {
      const response = await api.get('/admin/reviews/stats/prod_none', adminHeaders)

      expect(response.status).toEqual(200)
      expect(response.data.count).toEqual(0)
      expect(response.data.average).toEqual(0)
      expect(response.data.media_count).toEqual(0)
      expect(response.data.breakdown).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
    })

    it('requires authentication', async () => {
      const err = await api.get('/admin/reviews/stats/prod_stats').catch((e) => e.response)

      expect(err.status).toEqual(401)
    })
  },
})
