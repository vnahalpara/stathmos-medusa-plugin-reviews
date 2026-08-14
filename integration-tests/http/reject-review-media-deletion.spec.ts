import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { createAdminUser, adminHeaders } from '../helpers/admin'

async function pngBase64(background: string): Promise<string> {
  const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background } })
    .png()
    .toBuffer()

  return buf.toString('base64')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reviewWithMedia(container: any, productId: string, mediaCount = 1) {
  const files: { filename: string; content: string; size_bytes: number }[] = []
  for (let i = 0; i < mediaCount; i++) {
    files.push({
      filename: `m${i}.png`,
      content: await pngBase64(`#${(i + 1).toString(16).repeat(6).slice(0, 6)}`),
      size_bytes: 100,
    })
  }

  const { result: uploaded } = await uploadReviewMediaWorkflow(container).run({
    input: { files },
  })

  const { result: review } = await createReviewWorkflow(container).run({
    input: {
      product_id: productId,
      rating: 5,
      content: 'x'.repeat(20),
      display_name: 'Ada',
      media_ids: uploaded.media.map((m: { id: string }) => m.id),
    },
  })

  return { review, media: uploaded.media as { id: string; file_id: string }[] }
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await createAdminUser(getContainer())
      await updateReviewSettingsWorkflow(getContainer()).run({
        input: { allow_guest: true },
      })
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('deletes a rejected review media rows AND files from storage', async () => {
      const container = getContainer()
      const { review, media } = await reviewWithMedia(container, 'prod_reject_media', 2)

      const response = await api.post(
        `/admin/reviews/${review.id}/reject`,
        { rejection_reason: 'Offensive' },
        adminHeaders
      )

      expect(response.status).toEqual(200)
      expect(response.data.review.status).toEqual('rejected')

      const service = container.resolve(REVIEW_MODULE)
      const remaining = await service.listReviewMedias({ review_id: review.id })
      expect(remaining).toHaveLength(0)

      // Load-bearing: the file must be genuinely gone from storage, not
      // just unreferenced. A row-only delete would leave these photos
      // publicly retrievable at their storage URLs.
      const fileService = container.resolve(Modules.FILE)
      for (const item of media) {
        await expect(fileService.getAsBuffer(item.file_id)).rejects.toThrow()
      }
    })

    it('approving a review with media leaves the media intact', async () => {
      const container = getContainer()
      const { review, media } = await reviewWithMedia(container, 'prod_approve_media', 1)

      const response = await api.post(`/admin/reviews/${review.id}/approve`, {}, adminHeaders)
      expect(response.status).toEqual(200)
      expect(response.data.review.status).toEqual('approved')

      const service = container.resolve(REVIEW_MODULE)
      const remaining = await service.listReviewMedias({ review_id: review.id })
      expect(remaining).toHaveLength(1)

      const fileService = container.resolve(Modules.FILE)
      await expect(fileService.getAsBuffer(media[0].file_id)).resolves.toBeDefined()
    })

    it('resetting a review to pending leaves media intact', async () => {
      const container = getContainer()
      const { review, media } = await reviewWithMedia(container, 'prod_pending_media', 1)

      // First approve, then reset back to pending - a batch status change
      // to 'pending' must never touch media either.
      await api.post(`/admin/reviews/${review.id}/approve`, {}, adminHeaders)

      const response = await api.post(
        '/admin/reviews/batch/status',
        { ids: [review.id], status: 'pending' },
        adminHeaders
      )
      expect(response.status).toEqual(200)
      expect(response.data.reviews[0].status).toEqual('pending')

      const service = container.resolve(REVIEW_MODULE)
      const remaining = await service.listReviewMedias({ review_id: review.id })
      expect(remaining).toHaveLength(1)

      const fileService = container.resolve(Modules.FILE)
      await expect(fileService.getAsBuffer(media[0].file_id)).resolves.toBeDefined()
    })

    it('a batch rejection spanning two reviews deletes both reviews media', async () => {
      const container = getContainer()
      const first = await reviewWithMedia(container, 'prod_batch_reject_a', 1)
      const second = await reviewWithMedia(container, 'prod_batch_reject_b', 1)

      const response = await api.post(
        '/admin/reviews/batch/status',
        { ids: [first.review.id, second.review.id], status: 'rejected' },
        adminHeaders
      )
      expect(response.status).toEqual(200)
      expect(
        response.data.reviews.every((r: { status: string }) => r.status === 'rejected')
      ).toBe(true)

      const service = container.resolve(REVIEW_MODULE)
      expect(await service.listReviewMedias({ review_id: first.review.id })).toHaveLength(0)
      expect(await service.listReviewMedias({ review_id: second.review.id })).toHaveLength(0)

      const fileService = container.resolve(Modules.FILE)
      await expect(fileService.getAsBuffer(first.media[0].file_id)).rejects.toThrow()
      await expect(fileService.getAsBuffer(second.media[0].file_id)).rejects.toThrow()
    })

    it('leaves the review rejected when media deletion fails, and does not 500', async () => {
      const container = getContainer()
      const { review, media } = await reviewWithMedia(container, 'prod_reject_media_fail', 1)

      const fileService = container.resolve(Modules.FILE)
      jest.spyOn(fileService, 'deleteFiles').mockRejectedValue(new Error('forced file-delete failure'))

      const response = await api.post(
        `/admin/reviews/${review.id}/reject`,
        { rejection_reason: 'Offensive' },
        adminHeaders
      )

      // Must not 500, and the review must still be reported rejected.
      expect(response.status).toEqual(200)
      expect(response.data.review.status).toEqual('rejected')

      jest.restoreAllMocks()

      const service = container.resolve(REVIEW_MODULE)
      const [stillThere] = await service.listReviews({ id: review.id })
      expect(stillThere.status).toEqual('rejected')

      // The media deletion failed, so the row (and file) must still be
      // present - this is the acceptable leftover, not a silent loss.
      const remaining = await service.listReviewMedias({ review_id: review.id })
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toEqual(media[0].id)
    })

    it('rejecting a review with no media succeeds', async () => {
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)
      const review = await service.createReviews({
        product_id: 'prod_reject_no_media',
        display_name: 'No Media',
        rating: 3,
        content: 'x'.repeat(20),
      })

      const response = await api.post(
        `/admin/reviews/${review.id}/reject`,
        { rejection_reason: 'Spam' },
        adminHeaders
      )

      expect(response.status).toEqual(200)
      expect(response.data.review.status).toEqual('rejected')
    })

    /**
     * Priority 4 from the code review: nothing in the original 7 tests
     * pinned the per-item try/catch inside deleteRejectedReviewMediaStep's
     * loop (delete-rejected-review-media.ts). Deleting that try/catch
     * entirely - letting one item's exception abort the whole loop - made
     * all 7 original tests pass anyway, because the outer catch in
     * deleteMediaForRejectedReviews still swallowed the eventual rejection
     * and kept the route from 500ing. That outer catch is real
     * belt-and-suspenders, but it is the WRONG mechanism for batch
     * isolation: it stops the request from failing, it does not make the
     * loop keep going.
     *
     * This forces exactly one item's file-delete to fail - identified by
     * file id, not by call order, so the assertion does not depend on
     * `listReviewMedias`'s unspecified row ordering - and proves the loop
     * still reaches every other item: another item on the SAME review, and
     * every item belonging to a DIFFERENT review in the same batch.
     */
    it('one media item failing to delete does not stop the rest - same review and across a batch', async () => {
      const container = getContainer()
      const withTwoItems = await reviewWithMedia(container, 'prod_partial_fail_a', 2)
      const otherReviewInBatch = await reviewWithMedia(container, 'prod_partial_fail_b', 1)

      const failingFileId = withTwoItems.media[0].file_id

      const fileService = container.resolve(Modules.FILE)
      const originalDeleteFiles = fileService.deleteFiles.bind(fileService)

      jest.spyOn(fileService, 'deleteFiles').mockImplementation(async (...args: unknown[]) => {
        const ids = args[0] as string[]

        if (ids.includes(failingFileId)) {
          throw new Error('forced failure for one media item')
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalDeleteFiles as any)(...args)
      })

      const response = await api.post(
        '/admin/reviews/batch/status',
        { ids: [withTwoItems.review.id, otherReviewInBatch.review.id], status: 'rejected' },
        adminHeaders
      )

      expect(response.status).toEqual(200)
      expect(
        response.data.reviews.every((r: { status: string }) => r.status === 'rejected')
      ).toBe(true)

      jest.restoreAllMocks()

      const service = container.resolve(REVIEW_MODULE)

      // The one item whose file-delete was forced to fail is the
      // acceptable leftover: row and file both survive.
      const survivor = await service.listReviewMedias({ id: withTwoItems.media[0].id })
      expect(survivor).toHaveLength(1)
      await expect(fileService.getAsBuffer(failingFileId)).resolves.toBeDefined()

      // Load-bearing: the SECOND item on that same review must still have
      // been deleted - the per-item catch must not have aborted the rest
      // of this review's own loop iterations.
      const sameReviewOtherItem = await service.listReviewMedias({
        id: withTwoItems.media[1].id,
      })
      expect(sameReviewOtherItem).toHaveLength(0)
      await expect(
        fileService.getAsBuffer(withTwoItems.media[1].file_id)
      ).rejects.toThrow()

      // Load-bearing: the OTHER review in the same batch must have its
      // media fully deleted too - one review's failure must not abort
      // another review's cleanup within the same batch.
      const otherReviewMedia = await service.listReviewMedias({
        review_id: otherReviewInBatch.review.id,
      })
      expect(otherReviewMedia).toHaveLength(0)
      await expect(
        fileService.getAsBuffer(otherReviewInBatch.media[0].file_id)
      ).rejects.toThrow()
    })

    it('rejecting an already-rejected review does not error on missing media', async () => {
      const container = getContainer()
      const { review } = await reviewWithMedia(container, 'prod_reject_twice', 1)

      const first = await api.post(
        `/admin/reviews/${review.id}/reject`,
        { rejection_reason: 'Spam' },
        adminHeaders
      )
      expect(first.status).toEqual(200)

      const second = await api.post(
        `/admin/reviews/${review.id}/reject`,
        { rejection_reason: 'Spam again' },
        adminHeaders
      )
      expect(second.status).toEqual(200)
      expect(second.data.review.status).toEqual('rejected')

      const service = container.resolve(REVIEW_MODULE)
      const remaining = await service.listReviewMedias({ review_id: review.id })
      expect(remaining).toHaveLength(0)
    })
  },
})
