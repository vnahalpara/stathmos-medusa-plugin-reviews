import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { sweepOrphanReviewMedia } from '../../src/jobs/sweep-orphan-review-media'

async function upload(container) {
  const content = (
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#222222' } })
      .png()
      .toBuffer()
  ).toString('base64')

  const { result } = await uploadReviewMediaWorkflow(container).run({
    input: { files: [{ filename: 'p.png', content, size_bytes: 100 }] },
  })

  return result.media[0].id
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    beforeEach(async () => {
      await updateReviewSettingsWorkflow(getContainer()).run({
        input: { allow_guest: true },
      })
    })

    it('deletes unattached media older than the TTL', async () => {
      const container = getContainer()
      const id = await upload(container)

      // 25 hours from now, so the row created just above is past the window.
      const future = new Date(Date.now() + 25 * 60 * 60 * 1000)
      const result = await sweepOrphanReviewMedia(container, future)

      expect(result.deleted).toBeGreaterThanOrEqual(1)

      const service = container.resolve(REVIEW_MODULE)
      expect(await service.listReviewMedias({ id })).toHaveLength(0)
    })

    it('leaves recent unattached media alone', async () => {
      const container = getContainer()
      const id = await upload(container)

      await sweepOrphanReviewMedia(container, new Date())

      const service = container.resolve(REVIEW_MODULE)
      expect(await service.listReviewMedias({ id })).toHaveLength(1)
    })

    it('never deletes media attached to a review, however old', async () => {
      const container = getContainer()
      const mediaId = await upload(container)

      await createReviewWorkflow(container).run({
        input: {
          product_id: 'prod_sweep',
          rating: 5,
          content: 'x'.repeat(20),
          display_name: 'Ada',
          media_ids: [mediaId],
        },
      })

      const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365)
      await sweepOrphanReviewMedia(container, future)

      const service = container.resolve(REVIEW_MODULE)
      expect(await service.listReviewMedias({ id: mediaId })).toHaveLength(1)
    })
  },
})
