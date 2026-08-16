import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { createAdminUser, adminHeaders } from '../helpers/admin'
import { getPublishableKeyHeaders } from '../helpers/store'
import { emittedEvents, REVIEW_WORKFLOW_EVENTS } from '../helpers/events'

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

    /**
     * `review.approved`/`review.rejected` predate Phase 5; `product_ids` on
     * their payload does not. It is what makes them usable for cache
     * invalidation at all - a subscriber handed only review ids has to read
     * the reviews back just to learn which product pages went stale.
     *
     * The batch case is the interesting one, and it is asserted here rather
     * than the single-review one because it is the only place the plural is
     * load-bearing: two reviews on two DIFFERENT products must both appear,
     * deduped, or a bulk approval silently leaves one product's cache
     * stale. `expect.arrayContaining` is not enough for that - an
     * implementation returning only the first product would pass it - so
     * this sorts and compares exactly.
     */
    it('puts every affected product_id on review.approved, deduped, across a multi-product batch', async () => {
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)

      // Same product as `reviewId`, so the dedup below is exercised by real
      // data rather than assumed.
      const sameProduct = await service.createReviews({
        product_id: 'prod_mod',
        display_name: 'B',
        rating: 4,
        content: 'x'.repeat(10),
      })
      const otherProduct = await service.createReviews({
        product_id: 'prod_mod_other',
        display_name: 'C',
        rating: 3,
        content: 'x'.repeat(10),
      })

      const emitSpy = jest.spyOn(container.resolve(Modules.EVENT_BUS), 'emit')

      const response = await api.post(
        '/admin/reviews/batch/status',
        { ids: [reviewId, sameProduct.id, otherProduct.id], status: 'approved' },
        adminHeaders
      )
      expect(response.status).toEqual(200)

      const [event, ...rest] = emittedEvents(emitSpy, REVIEW_WORKFLOW_EVENTS)
      expect(rest).toEqual([])
      expect(event.name).toEqual('review.approved')

      const data = event.data as { ids: string[]; product_ids: string[] }
      expect(data.ids).toEqual([reviewId, sameProduct.id, otherProduct.id])
      expect([...data.product_ids].sort()).toEqual(['prod_mod', 'prod_mod_other'])

      emitSpy.mockRestore()
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
