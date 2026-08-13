import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { createAdminUser, adminHeaders } from '../helpers/admin'
import { getPublishableKeyHeaders } from '../helpers/store'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    let reviewId: string
    let storeHeaders: Record<string, string>

    beforeAll(async () => {
      storeHeaders = await getPublishableKeyHeaders(getContainer())
    })

    beforeEach(async () => {
      await createAdminUser(getContainer())

      const service = getContainer().resolve(REVIEW_MODULE)
      const review = await service.createReviews({
        product_id: 'prod_mod',
        display_name: 'A',
        rating: 5,
        content: 'x'.repeat(10),
      })
      reviewId = review.id
    })

    it('approving a review makes it public and updates the summary', async () => {
      const response = await api.post(`/admin/reviews/${reviewId}/approve`, {}, adminHeaders)

      expect(response.status).toEqual(200)
      expect(response.data.review.status).toEqual('approved')

      const stats = await api.get('/store/products/prod_mod/reviews/stats', {
        headers: storeHeaders,
      })
      expect(stats.data.count).toEqual(1)
    })

    it('rejecting stores the reason and keeps it out of the summary', async () => {
      const response = await api.post(
        `/admin/reviews/${reviewId}/reject`,
        { rejection_reason: 'Profanity' },
        adminHeaders
      )

      expect(response.data.review.rejection_reason).toEqual('Profanity')

      const stats = await api.get('/store/products/prod_mod/reviews/stats', {
        headers: storeHeaders,
      })
      expect(stats.data.count).toEqual(0)
    })

    it('approves in bulk', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      const second = await service.createReviews({
        product_id: 'prod_mod',
        display_name: 'B',
        rating: 4,
        content: 'x'.repeat(10),
      })

      const response = await api.post(
        '/admin/reviews/batch/status',
        { ids: [reviewId, second.id], status: 'approved' },
        adminHeaders
      )

      expect(response.status).toEqual(200)

      const stats = await api.get('/store/products/prod_mod/reviews/stats', {
        headers: storeHeaders,
      })
      expect(stats.data.count).toEqual(2)
    })

    it('lists pending reviews for the queue', async () => {
      const response = await api.get('/admin/reviews?status=pending', adminHeaders)

      expect(response.data.reviews.length).toBeGreaterThan(0)
      expect(response.data.reviews[0].status).toEqual('pending')
    })

    it('requires authentication', async () => {
      const response = await api.get('/admin/reviews').catch((e) => e.response)

      // Medusa's own automatic auth middleware rejects this before the route
      // ever runs. Observed here (see task-9-report.md) as 401, matching the
      // brief.
      expect(response.status).toEqual(401)
    })
  },
})
