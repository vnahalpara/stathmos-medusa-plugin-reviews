import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { moderateReviewsWorkflow } from '../../src/workflows/moderate-reviews'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { deleteReviewMediaWorkflow } from '../../src/workflows/delete-review-media'
import { createAdminUser, adminHeaders } from '../helpers/admin'
import { getPublishableKeyHeaders } from '../helpers/store'

async function pngBase64(background: string): Promise<string> {
  const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background } })
    .png()
    .toBuffer()

  return buf.toString('base64')
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

    it('removes one offensive photo without rejecting the review', async () => {
      const container = getContainer()

      const content = (
        await sharp({ create: { width: 4, height: 4, channels: 3, background: '#111111' } })
          .png()
          .toBuffer()
      ).toString('base64')

      const { result: uploaded } = await uploadReviewMediaWorkflow(container).run({
        input: {
          files: [
            { filename: 'a.png', content, size_bytes: 100 },
            { filename: 'b.png', content, size_bytes: 100 },
          ],
        },
      })

      const { result: review } = await createReviewWorkflow(container).run({
        input: {
          product_id: 'prod_admin_media',
          rating: 5,
          content: 'x'.repeat(20),
          display_name: 'Ada',
          media_ids: uploaded.media.map((m) => m.id),
        },
      })

      await moderateReviewsWorkflow(container).run({
        input: { ids: [review.id], status: 'approved' },
      })

      const storeHeaders = await getPublishableKeyHeaders(container)
      const statsBefore = await api.get(
        `/store/products/prod_admin_media/reviews/stats`,
        { headers: storeHeaders }
      )
      expect(statsBefore.data.media_count).toEqual(2)

      const deletedFileId = uploaded.media[0].file_id
      const survivingMediaId = uploaded.media[1].id

      const response = await api.delete(
        `/admin/reviews/media/${uploaded.media[0].id}`,
        adminHeaders
      )

      expect(response.status).toEqual(200)
      expect(response.data).toEqual({
        id: uploaded.media[0].id,
        object: 'review_media',
        deleted: true,
      })

      const service = container.resolve(REVIEW_MODULE)
      const remaining = await service.listReviewMedias({ review_id: review.id })
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toEqual(survivingMediaId)

      // The review itself must survive untouched: same status, same
      // content, only the one photo is gone.
      const [stillThere] = await service.listReviews({ id: review.id })
      expect(stillThere.status).toEqual('approved')
      expect(stillThere.content).toEqual('x'.repeat(20))

      // The public summary's media_count must drop from 2 to 1 - proof the
      // route actually recomputed stats rather than leaving them stale.
      const statsAfter = await api.get(
        `/store/products/prod_admin_media/reviews/stats`,
        { headers: storeHeaders }
      )
      expect(statsAfter.data.media_count).toEqual(1)

      // Load-bearing: the file must be genuinely gone from storage, not
      // just unreferenced. A row-only delete would leave this photo
      // publicly retrievable at its storage URL, which is the exact bug
      // this feature exists to avoid.
      const fileService = container.resolve(Modules.FILE)
      await expect(fileService.getAsBuffer(deletedFileId)).rejects.toThrow()
    })

    it('leaves the file deleted when the row delete fails afterward (the acceptable failure mode)', async () => {
      // Proves the file-before-row order: if the row delete step fails
      // *after* the file is already gone, the file must stay gone (content
      // genuinely removed) even though the row is left dangling. The
      // alternative order would leave the file recoverable here, which is
      // the exact outcome this ordering exists to avoid.
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)

      const { result: uploaded } = await uploadReviewMediaWorkflow(container).run({
        input: { files: [{ filename: 'c.png', content: await pngBase64('#222222'), size_bytes: 100 }] },
      })

      const { result: review } = await createReviewWorkflow(container).run({
        input: {
          product_id: 'prod_admin_media_partial_fail',
          rating: 5,
          content: 'x'.repeat(20),
          display_name: 'Ada',
          media_ids: uploaded.media.map((m) => m.id),
        },
      })

      const fileId = uploaded.media[0].file_id
      const mediaId = uploaded.media[0].id

      jest
        .spyOn(service, 'deleteReviewMedias')
        .mockRejectedValueOnce(new Error('forced row-delete failure'))

      let threw = false
      try {
        await deleteReviewMediaWorkflow(container).run({ input: { id: mediaId } })
      } catch (error) {
        threw = true
        expect((error as Error).message).toContain('forced row-delete failure')
      }
      expect(threw).toBe(true)

      jest.restoreAllMocks()

      // Load-bearing: the file must already be gone, since it was deleted
      // before the row-delete call that failed.
      const fileService = container.resolve(Modules.FILE)
      await expect(fileService.getAsBuffer(fileId)).rejects.toThrow()

      // The row, by contrast, is the acceptable leftover: still present,
      // now pointing at a missing file - a broken image someone can notice
      // and clean up, rather than an invisible orphan file.
      const [danglingRow] = await service.listReviewMedias({ id: mediaId })
      expect(danglingRow).toBeDefined()

      // The review itself is untouched by this failed cleanup attempt.
      const [stillThere] = await service.listReviews({ id: review.id })
      expect(stillThere.status).toEqual('pending')
    })

    it('404s an unknown media id', async () => {
      const response = await api
        .delete('/admin/reviews/media/rmed_nope', adminHeaders)
        .catch((e) => e.response)

      expect(response.status).toEqual(404)
    })

    it('requires authentication', async () => {
      const response = await api
        .delete('/admin/reviews/media/rmed_nope')
        .catch((e) => e.response)

      expect(response.status).toEqual(401)
    })
  },
})
