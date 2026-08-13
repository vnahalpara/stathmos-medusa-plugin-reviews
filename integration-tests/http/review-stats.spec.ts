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

      it('resolves both callers without error when two first-time recomputes race for the same product', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        // A never-before-seen product_id: no review_stats row exists yet,
        // which is exactly the window where two concurrent recomputes both
        // see "nothing exists" and race to create the row.
        await service.createReviews({
          product_id: 'prod_race',
          display_name: 'G',
          rating: 4,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const results = await Promise.all([
          recomputeReviewStats(container, 'prod_race'),
          recomputeReviewStats(container, 'prod_race'),
        ])

        expect(results).toHaveLength(2)

        const rows = await service.listReviewStats({ product_id: 'prod_race' })
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ count: 1, average: 4 })
      })

      /**
       * This runs on every review submission, every moderation action and
       * every media delete. Unbounded, it loads every approved review for a
       * product into memory and then issues an `IN` list of all of their
       * ids against review_media - a cost that grows without limit on
       * exactly the products that are selling. Medusa applies no implicit
       * default: `buildQuery` leaves `limit: undefined` when `config.take`
       * is absent, so the bound has to be passed explicitly.
       *
       * Asserted two ways: that every query it issues actually carries a
       * `take`, and that paging does not lose or double-count anything -
       * a bound that silently truncated the result would be worse than no
       * bound at all.
       */
      it('bounds its queries and still counts every approved review across pages', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const ratings = [5, 4, 3, 5, 5]
        for (const [i, rating] of ratings.entries()) {
          await service.createReviews({
            product_id: 'prod_paged',
            display_name: `P${i}`,
            rating,
            content: 'x'.repeat(10),
            status: 'approved',
          })
        }

        await service.createReviews({
          product_id: 'prod_paged',
          display_name: 'pending',
          rating: 1,
          content: 'x'.repeat(10),
          status: 'pending',
        })

        const reviewTakes: unknown[] = []
        const mediaTakes: unknown[] = []
        const originalListReviews = service.listReviews.bind(service)
        const originalCountMedia = service.listAndCountReviewMedias.bind(service)

        jest
          .spyOn(service, 'listReviews')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .mockImplementation(async (...args: any[]) => {
            reviewTakes.push((args[1] as { take?: unknown } | undefined)?.take)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await (originalListReviews as any)(...args)
          })

        jest
          .spyOn(service, 'listAndCountReviewMedias')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .mockImplementation(async (...args: any[]) => {
            mediaTakes.push((args[1] as { take?: unknown } | undefined)?.take)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await (originalCountMedia as any)(...args)
          })

        // A page size of 2 against 5 approved reviews forces three pages,
        // so a single-page implementation cannot pass this by accident.
        const stats = await recomputeReviewStats(container, 'prod_paged', 2)

        jest.restoreAllMocks()

        expect(reviewTakes.length).toBeGreaterThan(1)
        expect(reviewTakes.every((take) => typeof take === 'number')).toBe(true)
        expect(mediaTakes.length).toBeGreaterThan(0)
        expect(mediaTakes.every((take) => typeof take === 'number')).toBe(true)

        expect(stats).toMatchObject({
          count: 5,
          average: 4.4,
          breakdown_3: 1,
          breakdown_4: 1,
          breakdown_5: 3,
        })
      })
    })
  },
})
