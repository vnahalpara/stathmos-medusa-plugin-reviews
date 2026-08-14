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
