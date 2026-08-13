import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'

/**
 * `expect(promise).rejects.toThrow()` is unreliable for workflow `.run()`
 * promises in this test runner - documented in
 * update-review-settings-compensation.spec.ts and reused throughout this
 * suite. A try/catch is used instead.
 */
async function expectRejection(promise: Promise<unknown>): Promise<void> {
  let threw = false
  try {
    await promise
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
}

async function uploadOne(container: Parameters<typeof uploadReviewMediaWorkflow>[0]) {
  const content = (
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#abcdef' } })
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
    describe('attach review media', () => {
      beforeEach(async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true },
        })
      })

      it('attaches uploaded media to the created review', async () => {
        const container = getContainer()
        const mediaId = await uploadOne(container)

        const { result: review } = await createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_media',
            rating: 5,
            content: 'x'.repeat(20),
            display_name: 'Ada',
            media_ids: [mediaId],
          },
        })

        const service = container.resolve(REVIEW_MODULE)
        const [media] = await service.listReviewMedias({ id: mediaId })

        expect(media.review_id).toEqual(review.id)
      })

      it('refuses media that is already attached to another review', async () => {
        const container = getContainer()
        const mediaId = await uploadOne(container)

        await createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_a',
            rating: 5,
            content: 'x'.repeat(20),
            display_name: 'A',
            media_ids: [mediaId],
          },
        })

        await expectRejection(
          createReviewWorkflow(container).run({
            input: {
              product_id: 'prod_b',
              rating: 4,
              content: 'x'.repeat(20),
              display_name: 'B',
              media_ids: [mediaId],
            },
          })
        )

        // Load-bearing: the second (rejected) submission must not have
        // stolen the media away from the review that legitimately owns it.
        const service = container.resolve(REVIEW_MODULE)
        const [media] = await service.listReviewMedias({ id: mediaId })
        const [ownerReview] = await service.listReviews({ product_id: 'prod_a' })
        expect(media.review_id).toEqual(ownerReview.id)
      })

      it('refuses an unknown media id', async () => {
        await expectRejection(
          createReviewWorkflow(getContainer()).run({
            input: {
              product_id: 'prod_c',
              rating: 4,
              content: 'x'.repeat(20),
              display_name: 'C',
              media_ids: ['rmed_does_not_exist'],
            },
          })
        )
      })
    })
  },
})
