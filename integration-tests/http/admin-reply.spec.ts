import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    it('stores one reply per review and refuses a second', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      const review = await service.createReviews({
        product_id: 'prod_reply',
        display_name: 'A',
        rating: 5,
        content: 'x'.repeat(10),
      })

      const reply = await service.createReviewReplies({
        review_id: review.id,
        content: 'Thanks for the feedback!',
        replied_by: 'usr_test',
      })
      expect(reply.id).toMatch(/^rrep_/)

      await expect(
        service.createReviewReplies({
          review_id: review.id,
          content: 'Second reply',
          replied_by: 'usr_test',
        })
      ).rejects.toThrow()
    })
  },
})
