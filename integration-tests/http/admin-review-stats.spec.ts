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

    it('returns only the requested product\'s summary', async () => {
      // Two products with different ratings, both with live stats rows.
      //
      // Without this, every test in the file runs against a database
      // holding exactly one stats row, because the test runner truncates
      // between tests - which makes an unfiltered `listReviewStats({})`
      // indistinguishable from a correctly filtered one. Dropping the
      // `product_id` filter from the route passed all three original
      // tests. A second product is what turns "the right numbers came
      // back" into a claim about filtering rather than a coincidence of
      // there being only one row to return.
      const service = getContainer().resolve(REVIEW_MODULE)
      const other = await service.createReviews({
        product_id: 'prod_stats_other',
        display_name: 'B',
        rating: 1,
        content: 'y'.repeat(10),
      })

      // The OTHER product is approved first, deliberately. An unfiltered
      // `listReviewStats({})` destructures the first row it gets back, so
      // if the product under test were approved first this test would pass
      // against a dropped filter by pure luck of insertion order. Approving
      // the decoy first means an unfiltered query returns the decoy, and
      // the assertions below fail loudly.
      await api.post(`/admin/reviews/${other.id}/approve`, {}, adminHeaders)
      await api.post(`/admin/reviews/${reviewId}/approve`, {}, adminHeaders)

      const response = await api.get('/admin/reviews/stats/prod_stats', adminHeaders)

      expect(response.status).toEqual(200)
      expect(response.data.count).toEqual(1)
      expect(response.data.average).toEqual(5)
      expect(response.data.breakdown[5]).toEqual(1)
      // The other product's 1-star review must not appear in this bucket.
      expect(response.data.breakdown[1]).toEqual(0)
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
