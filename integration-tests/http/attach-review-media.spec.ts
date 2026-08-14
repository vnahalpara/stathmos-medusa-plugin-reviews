import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { attachReviewMediaStep } from '../../src/workflows/steps/attach-review-media'
import { getPublishableKeyHeaders } from '../helpers/store'

/**
 * `expect(promise).rejects.toThrow()` is unreliable for workflow `.run()`
 * promises in this test runner - documented in
 * update-review-settings-compensation.spec.ts and reused throughout this
 * suite. A try/catch is used instead.
 *
 * `messageIncludes` is required: asserting only that *something* threw lets
 * a rejection test pass on a wrong error from a different gate, which is
 * exactly how upload-review-media.spec.ts's allow_video test spent its
 * whole life testing the format sniffer instead.
 */
async function expectRejection(
  promise: Promise<unknown>,
  messageIncludes: string
): Promise<void> {
  let threw = false
  try {
    await promise
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain(messageIncludes)
  }
  expect(threw).toBe(true)
}

/**
 * attachReviewMediaStep is only ever invoked from createReviewWorkflow,
 * always against a review created moments earlier in the same run - so over
 * HTTP the review always has zero media already attached and the
 * `alreadyAttached` half of the cap check is unreachable. Phase 4's edit
 * flow is what makes it live.
 *
 * This wraps the step alone so that term can be exercised directly, against
 * a review that genuinely already owns media. Without it the check reduces
 * to `uniqueIds.length > max` and nothing notices.
 */
const attachOnlyWorkflow = createWorkflow(
  'test-attach-review-media-only',
  (input: { review_id: string; media_ids: string[] }) =>
    new WorkflowResponse(attachReviewMediaStep(input))
)

async function pngBase64(): Promise<string> {
  const buf = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#abcdef' },
  })
    .png()
    .toBuffer()

  return buf.toString('base64')
}

/** A real WebM: EBML magic plus a genuine DocType element reading "webm". */
function webmBase64(): string {
  const docType = 'webm'
  const offset = 20
  const buffer = Buffer.alloc(64)

  buffer[0] = 0x1a
  buffer[1] = 0x45
  buffer[2] = 0xdf
  buffer[3] = 0xa3
  buffer[offset] = 0x42
  buffer[offset + 1] = 0x82
  buffer[offset + 2] = 0x80 | docType.length
  buffer.write(docType, offset + 3, 'ascii')

  return buffer.toString('base64')
}

async function uploadOne(
  container: Parameters<typeof uploadReviewMediaWorkflow>[0],
  content?: string
) {
  const { result } = await uploadReviewMediaWorkflow(container).run({
    input: {
      files: [{ filename: 'p.png', content: content ?? (await pngBase64()), size_bytes: 100 }],
    },
  })

  return result.media[0].id
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('attach review media', () => {
      // Every media-relevant setting is reset per test: these tests turn
      // allow_media/allow_video off and change max_media_per_review, and a
      // leaked value would silently change what a later test is proving.
      beforeEach(async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: {
            allow_guest: true,
            allow_media: true,
            allow_video: true,
            max_media_per_review: 5,
          },
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
          }),
          'Unknown or unavailable media'
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
          }),
          'Unknown or unavailable media'
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
          }),
          'at most 3 media item(s)'
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

      // The upload step checks allow_media; the attach step did not. Since
      // an upload survives for the orphan TTL (24h by default), a merchant
      // who switched media off kept receiving media on new reviews for a
      // full day - the ids were already uploaded, and nothing on the way in
      // looked at the setting again.
      it('refuses media uploaded before allow_media was turned off', async () => {
        const container = getContainer()
        const mediaId = await uploadOne(container)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_media: false },
        })

        await expectRejection(
          createReviewWorkflow(container).run({
            input: {
              product_id: 'prod_media_off',
              rating: 5,
              content: 'x'.repeat(20),
              display_name: 'Ada',
              media_ids: [mediaId],
            },
          }),
          'Media uploads are disabled'
        )

        // The rejection must leave the media unclaimed - it is checked
        // before the atomic claim, so there is nothing to release.
        const service = container.resolve(REVIEW_MODULE)
        const [row] = await service.listReviewMedias({ id: mediaId })
        expect(row.review_id).toBeNull()
      })

      it('refuses a video uploaded before allow_video was turned off, while still accepting images', async () => {
        const container = getContainer()
        const videoId = await uploadOne(container, webmBase64())
        const imageId = await uploadOne(container)

        const service = container.resolve(REVIEW_MODULE)
        const [videoRow] = await service.listReviewMedias({ id: videoId })
        // Proves the fixture really is a video row, so the rejection below
        // can only be the allow_video branch.
        expect(videoRow.type).toEqual('video')

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_video: false },
        })

        await expectRejection(
          createReviewWorkflow(container).run({
            input: {
              product_id: 'prod_video_off',
              rating: 5,
              content: 'x'.repeat(20),
              display_name: 'Ada',
              media_ids: [videoId],
            },
          }),
          'Video uploads are disabled'
        )

        // allow_video is narrower than allow_media: an image must still
        // attach fine with video switched off.
        const { result: review } = await createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_video_off',
            rating: 5,
            content: 'x'.repeat(20),
            display_name: 'Ada',
            media_ids: [imageId],
          },
        })

        const [imageRow] = await service.listReviewMedias({ id: imageId })
        expect(imageRow.review_id).toEqual(review.id)
      })

      /**
       * `alreadyAttached.length + uniqueIds.length > max` is unreachable
       * over HTTP: attachReviewMediaStep only ever runs from
       * createReviewWorkflow, against a review created moments earlier in
       * the same run, so `alreadyAttached` is always empty and the check
       * collapses to `uniqueIds.length > max`. Phase 4's edit flow makes it
       * live. This exercises the step directly against a review that
       * genuinely already owns media.
       *
       * The numbers are chosen so ONLY the alreadyAttached term can reject:
       * cap 3, two already attached, two more incoming. The incoming count
       * alone (2) is under the cap.
       */
      it('counts media already attached to the review against the cap', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { max_media_per_review: 3 },
        })

        const first = [await uploadOne(container), await uploadOne(container)]

        const { result: review } = await createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_already_attached',
            rating: 5,
            content: 'x'.repeat(20),
            display_name: 'Ada',
            media_ids: first,
          },
        })

        expect(await service.listReviewMedias({ review_id: review.id })).toHaveLength(2)

        const more = [await uploadOne(container), await uploadOne(container)]

        await expectRejection(
          attachOnlyWorkflow(container).run({
            input: { review_id: review.id, media_ids: more },
          }),
          'at most 3 media item(s)'
        )

        // Nothing from the refused batch may have been claimed.
        const rows = await service.listReviewMedias({ id: more })
        expect(rows).toHaveLength(2)
        expect(rows.every((row) => row.review_id === null)).toBe(true)

        // And the review still owns exactly what it did before.
        expect(await service.listReviewMedias({ review_id: review.id })).toHaveLength(2)
      })

      /**
       * A 404 for "no such media" next to a 400 for "already attached" is a
       * clean existence oracle: the status code alone tells an
       * unauthenticated caller whether an `rmed_` id exists. Immaterial
       * against 80-bit ULIDs, but free to close - and this asserts the
       * whole response is indistinguishable, not merely the status.
       */
      it('answers an unknown media id and an already-attached one identically', async () => {
        const container = getContainer()
        const headers = await getPublishableKeyHeaders(container)
        const mediaId = await uploadOne(container)

        const body = {
          rating: 5,
          content: 'x'.repeat(20),
          display_name: 'Ada',
        }

        await createReviewWorkflow(container).run({
          input: { ...body, product_id: 'prod_oracle_owner', media_ids: [mediaId] },
        })

        const unknown = await api
          .post(
            '/store/reviews',
            { ...body, product_id: 'prod_oracle', media_ids: ['rmed_does_not_exist'] },
            { headers }
          )
          .catch((e) => e.response)

        const taken = await api
          .post(
            '/store/reviews',
            { ...body, product_id: 'prod_oracle', media_ids: [mediaId] },
            { headers }
          )
          .catch((e) => e.response)

        expect(unknown.status).toEqual(taken.status)
        expect(unknown.data.type).toEqual(taken.data.type)
        expect(unknown.data.message).toEqual(taken.data.message)
        expect(unknown.data.message).toEqual('Unknown or unavailable media')
      })
    })
  },
})
