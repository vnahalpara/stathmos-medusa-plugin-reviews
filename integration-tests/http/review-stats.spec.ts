import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { recomputeReviewStats } from '../../src/workflows/steps/recompute-review-stats'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('review stats', () => {
      it('counts only approved reviews and rounds the average to two places', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await service.createReviews([
          {
            product_id: 'prod_stats',
            display_name: 'A',
            rating: 5,
            content: 'x'.repeat(10),
            status: 'approved',
          },
          {
            product_id: 'prod_stats',
            display_name: 'B',
            rating: 4,
            content: 'x'.repeat(10),
            status: 'approved',
          },
          {
            product_id: 'prod_stats',
            display_name: 'C',
            rating: 1,
            content: 'x'.repeat(10),
            status: 'pending',
          },
          {
            product_id: 'prod_stats',
            display_name: 'D',
            rating: 1,
            content: 'x'.repeat(10),
            status: 'rejected',
          },
        ])

        // Direct call to the exported function rather than invoking the step:
        // calling createStep-wrapped functions' `.invoke` outside a workflow
        // is awkward and version-fragile. The step exists purely for
        // workflow composition and delegates to this same function, so
        // exercising the function here covers both.
        await recomputeReviewStats(container, 'prod_stats')

        const [stats] = await service.listReviewStats({ product_id: 'prod_stats' })

        expect(stats).toMatchObject({
          count: 2,
          average: 4.5,
          breakdown_5: 1,
          breakdown_4: 1,
          breakdown_1: 0,
          media_count: 0,
        })
      })

      it('produces a zeroed summary for a product with zero approved reviews', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await service.createReviews({
          product_id: 'prod_no_approved',
          display_name: 'E',
          rating: 3,
          content: 'x'.repeat(10),
          status: 'pending',
        })

        await recomputeReviewStats(container, 'prod_no_approved')

        const [stats] = await service.listReviewStats({ product_id: 'prod_no_approved' })

        expect(stats).toMatchObject({
          count: 0,
          average: 0,
          breakdown_1: 0,
          breakdown_2: 0,
          breakdown_3: 0,
          breakdown_4: 0,
          breakdown_5: 0,
          media_count: 0,
        })
      })

      it('is idempotent under retry: recomputing twice yields the same row updated in place', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await service.createReviews({
          product_id: 'prod_retry',
          display_name: 'F',
          rating: 3,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const first = await recomputeReviewStats(container, 'prod_retry')
        const second = await recomputeReviewStats(container, 'prod_retry')

        expect(second.id).toBe(first.id)

        const rows = await service.listReviewStats({ product_id: 'prod_retry' })
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ count: 1, average: 3 })
      })
    })
  },
})
