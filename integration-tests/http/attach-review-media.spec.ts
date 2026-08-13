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

      // max_media_per_review must bound the media a review ends up with in
      // total, not just the file count of one upload call - a client that
      // spreads uploads across several separate requests (each
      // individually under the cap, so upload-review-media-files.ts's own
      // per-call check never fires) must still be refused at attach time
      // once the combined total exceeds the setting. Four separate
      // uploadReviewMediaWorkflow runs, one file each, prove this is
      // enforced across calls, not just within a single one.
      it('refuses more media than max_media_per_review even when assembled across multiple upload requests', async () => {
        const container = getContainer()

        await updateReviewSettingsWorkflow(container).run({
          input: { max_media_per_review: 3 },
        })

        const mediaIds = [
          await uploadOne(container),
          await uploadOne(container),
          await uploadOne(container),
          await uploadOne(container),
        ]

        await expectRejection(
          createReviewWorkflow(container).run({
            input: {
              product_id: 'prod_over_cap',
              rating: 5,
              content: 'x'.repeat(20),
              display_name: 'Overcap',
              media_ids: mediaIds,
            },
          })
        )

        // Load-bearing: the rejection must not have left any of the batch
        // claimed - not a partial attach, not all four.
        const service = container.resolve(REVIEW_MODULE)
        const rows = await service.listReviewMedias({ id: mediaIds })
        expect(rows.every((row) => row.review_id === null)).toBe(true)
      })

      // Regression test for the Phase 1 bug this task was warned not to
      // reintroduce: an unknown-id check written as a length comparison
      // (`rows.length !== media_ids.length`) under-counts a batch that
      // repeats a single valid id, and wrongly reports "unknown media" for
      // an entirely valid submission. Set-membership handles this
      // correctly - this pins that the id is attached exactly once, not
      // rejected and not duplicated.
      it('attaches the same valid id once even when it is submitted twice in one batch', async () => {
        const container = getContainer()
        const mediaId = await uploadOne(container)

        const { result: review } = await createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_dup',
            rating: 5,
            content: 'x'.repeat(20),
            display_name: 'Dup',
            media_ids: [mediaId, mediaId],
          },
        })

        const service = container.resolve(REVIEW_MODULE)
        const rows = await service.listReviewMedias({ id: mediaId })

        expect(rows).toHaveLength(1)
        expect(rows[0].review_id).toEqual(review.id)
      })
    })
  },
})
