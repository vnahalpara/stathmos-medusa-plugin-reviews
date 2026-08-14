import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'

async function pngBase64(): Promise<string> {
  const buf = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer()

  return buf.toString('base64')
}

/**
 * `expect(promise).rejects.toThrow()` on a workflow `.run()` promise is
 * unreliable in this test runner - documented in
 * update-review-settings-compensation.spec.ts. A try/catch is used instead.
 */
async function runAndExpectRejection(promise: Promise<unknown>, messageIncludes: string) {
  let threw = false
  try {
    await promise
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain(messageIncludes)
  }
  expect(threw).toBe(true)
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('createReviewWorkflow media-attachment compensation', () => {
      beforeEach(async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true },
        })
      })

      afterEach(() => {
        jest.restoreAllMocks()
      })

      /**
       * attachReviewMediaStep runs before recomputeReviewStatsStep in
       * createReviewWorkflow, so a failure in the real recompute step (the
       * next step downstream, forced here by making the review-stats module
       * call fail) is a real "attach already committed, a later step in the
       * same real workflow then fails" scenario - not a synthetic stand-in
       * workflow. This is the first real composition of
       * attachReviewMediaStep's compensation: until Task 6, nothing invoked
       * it outside a hand-written unit-style test.
       *
       * The load-bearing assertion is that the media row's review_id goes
       * back to null - i.e. the upload is released back to the unattached
       * pool - rather than being left permanently claimed by a review that
       * itself got rolled back and no longer exists.
       */
      it('releases previously-attached media back to null when a later step fails', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const { result: uploaded } = await uploadReviewMediaWorkflow(container).run({
          input: {
            files: [{ filename: 'p.png', content: await pngBase64(), size_bytes: 100 }],
          },
        })
        const mediaId = uploaded.media[0].id

        jest.spyOn(service, 'createReviewStats').mockImplementation(async () => {
          throw new Error('forced recompute failure for compensation test')
        })

        await runAndExpectRejection(
          createReviewWorkflow(container).run({
            input: {
              product_id: 'prod_compensation',
              rating: 5,
              content: 'x'.repeat(20),
              display_name: 'Comp',
              media_ids: [mediaId],
            },
          }),
          'forced recompute failure for compensation test'
        )

        jest.restoreAllMocks()

        const [media] = await service.listReviewMedias({ id: mediaId })
        expect(media.review_id).toBeNull()

        // The review itself must also have been rolled back by
        // createReviewStep's own compensation, confirming this is a genuine
        // multi-step rollback and not a case where the review survived but
        // media happened to look unattached for an unrelated reason.
        expect(await service.listReviews({ product_id: 'prod_compensation' })).toHaveLength(0)
      })
    })
  },
})
