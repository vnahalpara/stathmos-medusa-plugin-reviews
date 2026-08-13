import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { recomputeReviewStats } from '../../src/workflows/steps/recompute-review-stats'
import { getPublishableKeyHeaders } from '../helpers/store'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    let storeHeaders: Record<string, string>

    beforeAll(async () => {
      storeHeaders = await getPublishableKeyHeaders(getContainer())
    })

    beforeEach(async () => {
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)

      await service.createReviews([
        { product_id: 'prod_read', display_name: 'A', rating: 5, content: 'x'.repeat(10), status: 'approved' },
        { product_id: 'prod_read', display_name: 'B', rating: 3, content: 'x'.repeat(10), status: 'approved' },
        { product_id: 'prod_read', display_name: 'C', rating: 1, content: 'x'.repeat(10), status: 'pending' },
        { product_id: 'prod_read', display_name: 'D', rating: 1, content: 'x'.repeat(10), status: 'rejected' },
      ])

      await recomputeReviewStats(container, 'prod_read')
    })

    describe('GET /store/products/:id/reviews', () => {
      it('returns only approved reviews', async () => {
        const response = await api.get('/store/products/prod_read/reviews', {
          headers: storeHeaders,
        })

        expect(response.status).toEqual(200)
        expect(response.data.count).toEqual(2)
        expect(response.data.reviews.every((r: { status: string }) => r.status === 'approved')).toBe(
          true
        )
      })

      it('never exposes email or customer_id', async () => {
        const response = await api.get('/store/products/prod_read/reviews', {
          headers: storeHeaders,
        })

        expect(response.data.reviews[0].email).toBeUndefined()
        expect(response.data.reviews[0].customer_id).toBeUndefined()
      })

      // Cheap once we're already asserting shape: an allow-list can still
      // silently grow a leak if a future column is added and someone reaches
      // for the model instead of extending the allow-list deliberately.
      // Pinning the full key set (not just the absence of email) catches that.
      it('exposes exactly the allow-listed fields, nothing more', async () => {
        const response = await api.get('/store/products/prod_read/reviews', {
          headers: storeHeaders,
        })

        expect(Object.keys(response.data.reviews[0]).sort()).toEqual(
          [
            'content',
            'created_at',
            'display_name',
            'helpful_count',
            'id',
            'is_verified_purchase',
            'product_id',
            'rating',
            'status',
            'title',
          ].sort()
        )
      })

      it('caps limit at 100', async () => {
        const response = await api
          .get('/store/products/prod_read/reviews?limit=5000', { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })

      it('sorts by highest rating on request', async () => {
        const response = await api.get('/store/products/prod_read/reviews?sort=highest', {
          headers: storeHeaders,
        })

        expect(response.data.reviews[0].rating).toEqual(5)
      })
    })

    describe('GET /store/products/:id/reviews/stats', () => {
      it('serves the denormalized summary', async () => {
        const response = await api.get('/store/products/prod_read/reviews/stats', {
          headers: storeHeaders,
        })

        expect(response.data).toMatchObject({
          count: 2,
          average: 4,
          breakdown: { '5': 1, '4': 0, '3': 1, '2': 0, '1': 0 },
        })
      })

      it('returns a zeroed summary for a product with no reviews', async () => {
        const response = await api.get('/store/products/prod_none/reviews/stats', {
          headers: storeHeaders,
        })

        expect(response.data).toMatchObject({ count: 0, average: 0 })
      })
    })
  },
})
