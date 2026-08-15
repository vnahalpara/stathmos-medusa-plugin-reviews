import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { createAdminUser, adminHeaders } from '../helpers/admin'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await createAdminUser(getContainer())
    })

    it('matches a term found in display_name', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      await service.createReviews([
        {
          product_id: 'prod_search',
          display_name: 'Jamie Fraser',
          rating: 5,
          content: 'x'.repeat(10),
        },
        {
          product_id: 'prod_search',
          display_name: 'Someone else',
          rating: 4,
          content: 'y'.repeat(10),
        },
      ])

      const response = await api.get('/admin/reviews?q=Fraser', adminHeaders)

      expect(response.data.reviews).toHaveLength(1)
      expect(response.data.reviews[0].display_name).toEqual('Jamie Fraser')
      expect(response.data.count).toEqual(1)
    })

    it('matches a term found in email', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      await service.createReviews([
        {
          product_id: 'prod_search',
          display_name: 'Guest',
          email: 'spammer@example.com',
          rating: 1,
          content: 'x'.repeat(10),
        },
        {
          product_id: 'prod_search',
          display_name: 'Guest',
          email: 'regular@example.com',
          rating: 5,
          content: 'y'.repeat(10),
        },
      ])

      const response = await api.get('/admin/reviews?q=spammer', adminHeaders)

      expect(response.data.reviews).toHaveLength(1)
      expect(response.data.reviews[0].email).toEqual('spammer@example.com')
      expect(response.data.count).toEqual(1)
    })

    it('matches a term found in content', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      await service.createReviews([
        {
          product_id: 'prod_search',
          display_name: 'Guest',
          rating: 5,
          content: 'Arrived broken out of the box',
        },
        {
          product_id: 'prod_search',
          display_name: 'Guest',
          rating: 5,
          content: 'Works great, love it',
        },
      ])

      const response = await api.get('/admin/reviews?q=broken', adminHeaders)

      expect(response.data.reviews).toHaveLength(1)
      expect(response.data.reviews[0].content).toEqual('Arrived broken out of the box')
      expect(response.data.count).toEqual(1)
    })

    it('matches case-insensitively', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      await service.createReviews([
        {
          product_id: 'prod_search',
          display_name: 'CaseTest',
          rating: 5,
          content: 'x'.repeat(10),
        },
        // Decoy that must NOT match "casetest" anywhere - without it this
        // test would pass even with `q` disabled entirely server-side,
        // since a single seeded row always comes back alone regardless of
        // whether filtering happened. This is the same shape as the
        // display_name/email/content tests above, which already seed a
        // non-matching second review for the same reason.
        {
          product_id: 'prod_search',
          display_name: 'Someone else entirely',
          rating: 4,
          content: 'A completely unrelated review',
        },
      ])

      const response = await api.get('/admin/reviews?q=casetest', adminHeaders)

      expect(response.data.reviews).toHaveLength(1)
      expect(response.data.reviews[0].display_name).toEqual('CaseTest')
      expect(response.data.count).toEqual(1)
    })

    it('combines q with a status filter - the most common real usage (searching a name while on the Pending tab)', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      await service.createReviews([
        // The target: matches q AND status.
        {
          product_id: 'prod_search_status',
          display_name: 'Combotest Pending',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'pending',
        },
        // Matches q but NOT status - proves status is still applied
        // alongside q, not bypassed.
        {
          product_id: 'prod_search_status',
          display_name: 'Combotest Approved',
          rating: 5,
          content: 'y'.repeat(10),
          status: 'approved',
        },
        // Matches status but NOT q - the decoy that makes this test
        // load-bearing for q. Without it, `status=pending` alone already
        // narrows to exactly one row, so this test would pass even with
        // q silently ignored - the same vacuous-test shape flagged
        // elsewhere in this suite.
        {
          product_id: 'prod_search_status',
          display_name: 'Unrelated Pending Review',
          rating: 3,
          content: 'z'.repeat(10),
          status: 'pending',
        },
      ])

      const response = await api.get(
        '/admin/reviews?q=combotest&status=pending',
        adminHeaders
      )

      expect(response.data.reviews).toHaveLength(1)
      expect(response.data.reviews[0].display_name).toEqual('Combotest Pending')
      expect(response.data.reviews[0].status).toEqual('pending')
      // Not 2 (the two pending reviews) and not 2 (both Combotest reviews)
      // - proves q and status apply together (AND), neither one alone.
      expect(response.data.count).toEqual(1)
    })

    it('finds a match beyond the first page, with count reflecting the filtered total', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)

      // Created FIRST (oldest), before 24 generic filler reviews - with the
      // route's default `created_at DESC` ordering this sorts the target
      // last, past `limit=5`. A client-side filter over only the already-
      // fetched first page (the bug this test exists to catch) would never
      // see it; a real WHERE-level filter, applied before LIMIT/OFFSET,
      // finds it regardless of where it falls in unfiltered order.
      const target = await service.createReviews({
        product_id: 'prod_search_paged',
        display_name: 'Guest',
        rating: 5,
        content: 'Distinctivemarkerphrase for this test',
      })

      const filler = Array.from({ length: 24 }, (_, i) => ({
        product_id: 'prod_search_paged',
        display_name: 'Guest',
        rating: 3,
        content: `Generic filler review number ${i}`,
      }))
      await service.createReviews(filler)

      const response = await api.get(
        '/admin/reviews?q=distinctivemarkerphrase&limit=5&offset=0',
        adminHeaders
      )

      expect(response.data.reviews).toHaveLength(1)
      expect(response.data.reviews[0].id).toEqual(target.id)
      // Not 25 (the unfiltered total) - proves `count` is computed against
      // the same filtered query as `reviews`, not the whole table.
      expect(response.data.count).toEqual(1)
    })

    it('rejects an unknown query parameter, proving the schema is still strict', async () => {
      const response = await api.get('/admin/reviews?bogus=1', adminHeaders).catch((e) => e.response)

      expect(response.status).toEqual(400)
    })
  },
})
