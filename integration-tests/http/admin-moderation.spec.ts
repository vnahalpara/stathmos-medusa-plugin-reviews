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
      // Approve first and confirm the summary actually counts it - otherwise
      // this test would still pass even if rejection did nothing at all,
      // since a never-approved review also leaves count at 0.
      await api.post(`/admin/reviews/${reviewId}/approve`, {}, adminHeaders)

      const approvedStats = await api.get('/store/products/prod_mod/reviews/stats', {
        headers: storeHeaders,
      })
      expect(approvedStats.data.count).toEqual(1)

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
      // Seed reviews of differing statuses so the assertion below can only
      // pass if the status filter is actually applied - with a single
      // pending review in play, asserting just reviews[0] would still pass
      // even with the filter removed entirely.
      const service = getContainer().resolve(REVIEW_MODULE)
      await service.createReviews([
        {
          product_id: 'prod_mod',
          display_name: 'Approved one',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        },
        {
          product_id: 'prod_mod',
          display_name: 'Rejected one',
          rating: 1,
          content: 'x'.repeat(10),
          status: 'rejected',
        },
      ])

      const response = await api.get('/admin/reviews?status=pending', adminHeaders)

      expect(response.data.reviews.length).toBeGreaterThan(0)
      expect(
        response.data.reviews.every((r: { status: string }) => r.status === 'pending')
      ).toBe(true)
    })

    it('treats a repeated id in a batch as valid rather than a false NOT_FOUND', async () => {
      // moderateReviewsStep used to guard with existing.length !==
      // input.ids.length, a count check rather than set membership - a
      // batch that names the same real id twice under-counted against
      // input.ids.length and threw NOT_FOUND even though the id was valid.
      const response = await api.post(
        '/admin/reviews/batch/status',
        { ids: [reviewId, reviewId], status: 'approved' },
        adminHeaders
      )

      expect(response.status).toEqual(200)
      expect(response.data.reviews).toHaveLength(1)
      expect(response.data.reviews[0].status).toEqual('approved')

      const stats = await api.get('/store/products/prod_mod/reviews/stats', {
        headers: storeHeaders,
      })
      expect(stats.data.count).toEqual(1)
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
