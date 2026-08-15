import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { moderateReviewsWorkflow } from '../../src/workflows/moderate-reviews'
import { createAdminUser, adminHeaders } from '../helpers/admin'
import { getPublishableKeyHeaders } from '../helpers/store'

/**
 * Spec §6 / Task 4: a reply must never appear on a store route unless its
 * parent review is `approved`, and `replied_by` (the admin user's id) must
 * never reach a store route at all. This mirrors
 * store-media-visibility.spec.ts's shape deliberately - it is the same
 * rule, proven the same way, including the direct-service-call test that
 * bypasses HTTP entirely.
 */
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    it('shows a reply on an approved review', async () => {
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)
      await createAdminUser(container)

      const review = await service.createReviews({
        product_id: 'prod_reply_approved',
        display_name: 'Ada',
        rating: 5,
        content: 'x'.repeat(20),
      })

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      await api.post(`/admin/reviews/${review.id}/reply`, { content: 'Thanks!' }, adminHeaders)

      const response = await api.get('/store/products/prod_reply_approved/reviews', {
        headers: await getPublishableKeyHeaders(container),
      })

      expect(response.data.reviews).toHaveLength(1)
      expect(response.data.reviews[0].reply.content).toEqual('Thanks!')
      expect(response.data.reviews[0].reply.created_at).toBeDefined()
    })

    it('returns only the approved review\'s reply when a pending review shares the product', async () => {
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)
      await createAdminUser(container)

      // Two reviews on ONE product: one approved, one pending, each with
      // its own reply.
      //
      // The single-pending-review version of this test proved nothing. A
      // pending review is already excluded from this route's review list
      // for reasons that have nothing to do with reply filtering, so its
      // reply could never have appeared regardless - the test passed even
      // with reply filtering removed entirely. Keeping an approved review
      // in the response is what gives the assertion something to bite on:
      // the response is non-empty, so "the pending reply is absent" is a
      // real claim about reply scoping rather than a restatement of review
      // scoping.
      //
      // Specifically, this catches replies being attached by product
      // instead of per review - a plausible bug in the id->reply Map
      // lookup that the previous shape could not see.
      const approved = await service.createReviews({
        product_id: 'prod_reply_mixed',
        display_name: 'Ann',
        rating: 5,
        content: 'x'.repeat(20),
      })
      const pending = await service.createReviews({
        product_id: 'prod_reply_mixed',
        display_name: 'Bea',
        rating: 4,
        content: 'y'.repeat(20),
      })

      await api.post(`/admin/reviews/${approved.id}/approve`, {}, adminHeaders)

      await api.post(
        `/admin/reviews/${approved.id}/reply`,
        { content: 'Visible reply' },
        adminHeaders
      )
      await api.post(
        `/admin/reviews/${pending.id}/reply`,
        { content: 'Hidden reply' },
        adminHeaders
      )

      const response = await api.get('/store/products/prod_reply_mixed/reviews', {
        headers: await getPublishableKeyHeaders(container),
      })

      expect(response.data.reviews).toHaveLength(1)
      expect(response.data.reviews[0].reply.content).toEqual('Visible reply')
      expect(JSON.stringify(response.data)).not.toContain('Hidden reply')
    })

    it('never exposes replied_by on a store route', async () => {
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)
      const admin = await createAdminUser(container)

      const review = await service.createReviews({
        product_id: 'prod_reply_no_leak',
        display_name: 'Cai',
        rating: 5,
        content: 'z'.repeat(20),
      })

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      await api.post(`/admin/reviews/${review.id}/reply`, { content: 'Thanks!' }, adminHeaders)

      const response = await api.get('/store/products/prod_reply_no_leak/reviews', {
        headers: await getPublishableKeyHeaders(container),
      })

      // The admin user id genuinely was recorded as replied_by - this is
      // the leak firing, not an empty fixture passing by accident.
      const [reply] = await service.listReviewReplies({ review_id: review.id })
      expect(reply.replied_by).toEqual(admin.id)

      expect(JSON.stringify(response.data)).not.toContain(admin.id)
      expect(response.data.reviews[0].reply.replied_by).toBeUndefined()

      // The public author is the store's name, never the staff member's
      // (spec decision #3) - resolved from the real Store module row
      // rather than hardcoded, since the default store's name is an
      // implementation detail of Medusa's own bootstrap defaults.
      const storeModule = container.resolve(Modules.STORE)
      const [store] = await storeModule.listStores({}, { take: 1 })
      expect(response.data.reviews[0].reply.author).toEqual(store.name)
    })

    /**
     * Bypasses HTTP entirely: calls listVisibleReviewReplies() directly
     * with a pending review's id, the way a future store surface would if
     * it handed over an unfiltered id list. This is what proves the rule
     * lives in the service rather than being reconstructed per-route - the
     * media equivalent (store-media-visibility.spec.ts) survived a later
     * refactor precisely because this class of test existed.
     */
    it("refuses a non-approved review's reply at the service layer, with no route involved", async () => {
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)
      await createAdminUser(container)

      const review = await service.createReviews({
        product_id: 'prod_reply_service_layer',
        display_name: 'Dee',
        rating: 3,
        content: 'w'.repeat(20),
      })

      await api.post(`/admin/reviews/${review.id}/reply`, { content: 'Thanks!' }, adminHeaders)

      // The reply genuinely exists - the empty result below is the rule
      // firing, not an empty fixture.
      const [row] = await service.listReviewReplies({ review_id: review.id })
      expect(row).toBeDefined()

      const replies = await service.listVisibleReviewReplies([review.id])
      expect(replies).toHaveLength(0)

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      expect(await service.listVisibleReviewReplies([review.id])).toHaveLength(1)
    })
  },
})
