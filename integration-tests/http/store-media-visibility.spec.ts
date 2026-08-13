import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { moderateReviewsWorkflow } from '../../src/workflows/moderate-reviews'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { getPublishableKeyHeaders } from '../helpers/store'

async function reviewWithMedia(container: any, productId: string) {
  const content = (
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#654321' } })
      .png()
      .toBuffer()
  ).toString('base64')

  const { result: uploaded } = await uploadReviewMediaWorkflow(container).run({
    input: { files: [{ filename: 'p.png', content, size_bytes: 100 }] },
  })

  const { result: review } = await createReviewWorkflow(container).run({
    input: {
      product_id: productId,
      rating: 5,
      content: 'x'.repeat(20),
      display_name: 'Ada',
      media_ids: [uploaded.media[0].id],
    },
  })

  return review
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await updateReviewSettingsWorkflow(getContainer()).run({
        input: { allow_guest: true },
      })
    })

    it('hides media of a pending review from the store', async () => {
      const container = getContainer()
      await reviewWithMedia(container, 'prod_pending_media')

      const response = await api.get(
        '/store/products/prod_pending_media/reviews',
        { headers: await getPublishableKeyHeaders(container) }
      )

      expect(response.data.count).toEqual(0)
      expect(JSON.stringify(response.data)).not.toContain('.png')
    })

    it('exposes media once the review is approved', async () => {
      const container = getContainer()
      const review = await reviewWithMedia(container, 'prod_approved_media')

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      const response = await api.get(
        '/store/products/prod_approved_media/reviews',
        { headers: await getPublishableKeyHeaders(container) }
      )

      expect(response.data.reviews[0].media).toHaveLength(1)
      expect(Object.keys(response.data.reviews[0].media[0]).sort()).toEqual(
        ['id', 'thumbnail_url', 'type', 'url'].sort()
      )
    })

    it('counts media of approved reviews in stats', async () => {
      const container = getContainer()
      const review = await reviewWithMedia(container, 'prod_media_stats')

      const before = await api.get(
        '/store/products/prod_media_stats/reviews/stats',
        { headers: await getPublishableKeyHeaders(container) }
      )
      expect(before.data.media_count).toEqual(0)

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      const after = await api.get(
        '/store/products/prod_media_stats/reviews/stats',
        { headers: await getPublishableKeyHeaders(container) }
      )
      expect(after.data.media_count).toEqual(1)
    })

    it('omits hidden media from an approved review', async () => {
      const container = getContainer()
      const review = await reviewWithMedia(container, 'prod_hidden_media')

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      const service = container.resolve(REVIEW_MODULE)
      const [media] = await service.listReviewMedias({ review_id: review.id })
      await service.updateReviewMedias({ id: media.id, hidden_at: new Date() })

      const response = await api.get(
        '/store/products/prod_hidden_media/reviews',
        { headers: await getPublishableKeyHeaders(container) }
      )

      expect(response.data.reviews[0].media).toHaveLength(0)
    })
  },
})
