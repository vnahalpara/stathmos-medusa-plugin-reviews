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
          replied_by: 'usr_other',
        })
      ).rejects.toThrow()
    })

    it('frees the review_id for a new reply once the old one is soft-deleted', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      const review = await service.createReviews({
        product_id: 'prod_reply_2',
        display_name: 'B',
        rating: 4,
        content: 'y'.repeat(10),
      })

      const firstReply = await service.createReviewReplies({
        review_id: review.id,
        content: 'First reply',
        replied_by: 'usr_test',
      })

      await service.softDeleteReviewReplies(firstReply.id)

      const secondReply = await service.createReviewReplies({
        review_id: review.id,
        content: 'Second reply after delete',
        replied_by: 'usr_test',
      })
      expect(secondReply.id).toMatch(/^rrep_/)
      expect(secondReply.id).not.toEqual(firstReply.id)
    })
  },
})
