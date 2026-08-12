import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import ReviewModuleService from '../../src/modules/review/service'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('review module', () => {
      it('creates a review defaulting to pending with no helpful votes', async () => {
        const service: ReviewModuleService = getContainer().resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_test',
          display_name: 'Ada',
          rating: 5,
          content: 'Genuinely excellent, would buy again.',
        })

        expect(review).toMatchObject({
          status: 'pending',
          helpful_count: 0,
          is_verified_purchase: false,
        })
        expect(review.id).toMatch(/^rev_/)
      })
    })
  },
})
