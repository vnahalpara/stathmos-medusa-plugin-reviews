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
import { emittedEvents, REVIEW_WORKFLOW_EVENTS } from '../helpers/events'

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

    // Not optional bookkeeping: a test that fails before its own
    // `mockRestore()` leaves the event bus spied, and the next test's spy
    // then stacks on top of it - turning one real failure into two
    // confusing ones. Observed while red/green-checking these tests.
    // Matches admin-reply.spec.ts and admin-media-curation.spec.ts.
    afterEach(() => {
      jest.restoreAllMocks()
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

    /**
     * Deleting a photo is the more final half of the pair curation began.
     * Hiding one is revalidated the instant a moderator acts; destroying
     * one - the action taken when an image must never be served again -
     * had no event at all, so a host's cache kept serving it for a full
     * stale-while-revalidate window. Same payload shape as
     * `review.media.curated`, so a host writes one subscriber for both.
     *
     * The decoy is the same one the curation event needed: a second review
     * on a DIFFERENT product, seeded first, so a delete step that resolved
     * "some review" instead of "this media's review" emits the decoy's
     * product id and fails here. `review_id` is asserted too - it is the
     * only trace of the parent left once the row is gone.
     */
    it("emits review.media.deleted carrying the deleted media's own product_id", async () => {
      const container = getContainer()
      const content = await pngBase64('#222222')

      const { result: decoyUpload } = await uploadReviewMediaWorkflow(container).run({
        input: { files: [{ filename: 'decoy.png', content, size_bytes: 100 }] },
      })
      await createReviewWorkflow(container).run({
        input: {
          product_id: 'prod_media_deleted_decoy',
          rating: 1,
          content: 'x'.repeat(20),
          display_name: 'Decoy',
          media_ids: decoyUpload.media.map((m) => m.id),
        },
      })

      const { result: uploaded } = await uploadReviewMediaWorkflow(container).run({
        input: { files: [{ filename: 'target.png', content, size_bytes: 100 }] },
      })
      const { result: review } = await createReviewWorkflow(container).run({
        input: {
          product_id: 'prod_media_deleted',
          rating: 5,
          content: 'x'.repeat(20),
          display_name: 'Ada',
          media_ids: uploaded.media.map((m) => m.id),
        },
      })

      const emitSpy = jest.spyOn(container.resolve(Modules.EVENT_BUS), 'emit')

      const response = await api.delete(
        `/admin/reviews/media/${uploaded.media[0].id}`,
        adminHeaders
      )
      expect(response.status).toEqual(200)

      expect(emittedEvents(emitSpy, REVIEW_WORKFLOW_EVENTS)).toEqual([
        {
          name: 'review.media.deleted',
          data: {
            id: uploaded.media[0].id,
            review_id: review.id,
            product_id: 'prod_media_deleted',
          },
        },
      ])

      emitSpy.mockRestore()
    })

    it('emits nothing when deleting media that was never attached to a review', async () => {
      // An abandoned upload: no review, so no product page has ever shown
      // it and there is no cache to invalidate. Same guard as curation.
      const container = getContainer()

      const { result: uploaded } = await uploadReviewMediaWorkflow(container).run({
        input: {
          files: [{ filename: 'orphan.png', content: await pngBase64('#333333'), size_bytes: 100 }],
        },
      })

      const emitSpy = jest.spyOn(container.resolve(Modules.EVENT_BUS), 'emit')

      const response = await api.delete(
        `/admin/reviews/media/${uploaded.media[0].id}`,
        adminHeaders
      )

      // Deleted all the same - the guard is on the event, not the write.
      expect(response.status).toEqual(200)
      expect(emittedEvents(emitSpy, REVIEW_WORKFLOW_EVENTS)).toEqual([])

      emitSpy.mockRestore()
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
