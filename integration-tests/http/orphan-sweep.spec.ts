import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
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

  return { id: result.media[0].id, fileId: result.media[0].file_id }
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    beforeEach(async () => {
      await updateReviewSettingsWorkflow(getContainer()).run({
        input: { allow_guest: true },
      })
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('deletes unattached media older than the TTL, file as well as row', async () => {
      const container = getContainer()
      const { id, fileId } = await upload(container)

      // 25 hours from now, so the row created just above is past the window.
      const future = new Date(Date.now() + 25 * 60 * 60 * 1000)
      const result = await sweepOrphanReviewMedia(container, future)

      expect(result.deleted).toBeGreaterThanOrEqual(1)

      const service = container.resolve(REVIEW_MODULE)
      expect(await service.listReviewMedias({ id })).toHaveLength(0)

      // Load-bearing, and the whole reason this job exists: "without this
      // sweep, storage grows forever". Asserting only on the row lets a
      // build that never calls deleteFilesWorkflow pass while every swept
      // upload leaks its bytes permanently AND invisibly - no row is left
      // behind for a later sweep to find them by. Same assertion shape as
      // admin-media-delete.spec.ts, which gets this right.
      const fileService = container.resolve(Modules.FILE)
      await expect(fileService.getAsBuffer(fileId)).rejects.toThrow()
    })

    it('leaves recent unattached media alone', async () => {
      const container = getContainer()
      const { id, fileId } = await upload(container)

      await sweepOrphanReviewMedia(container, new Date())

      const service = container.resolve(REVIEW_MODULE)
      expect(await service.listReviewMedias({ id })).toHaveLength(1)

      const fileService = container.resolve(Modules.FILE)
      await expect(fileService.getAsBuffer(fileId)).resolves.toBeDefined()
    })

    it('never deletes media attached to a review, however old', async () => {
      const container = getContainer()
      const { id: mediaId, fileId } = await upload(container)

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

      const fileService = container.resolve(Modules.FILE)
      await expect(fileService.getAsBuffer(fileId)).resolves.toBeDefined()
    })

    /**
     * The sweep used to SELECT its orphans and then delete them by primary
     * key. Anything that attached one of those rows to a real review in
     * between - `claimMediaForReview()`, i.e. an ordinary review submission
     * - was simply overwritten: the file and the row went regardless, the
     * review was created and reported success, and the customer's photo was
     * silently gone with no error surfaced to anyone.
     *
     * This forces that interleaving deterministically rather than hoping
     * for it on timing: a real createReviewWorkflow run is executed from
     * inside the sweep's own `listReviewMedias` read, after the read has
     * produced its rows and before the sweep can act on them. That is
     * precisely the window the old code left open, so this passes only if
     * the delete itself re-checks `review_id` in the database - which is
     * exactly how claimMediaForReview() already resolves the mirror image
     * of this race on the attach side.
     */
    it('never deletes media that a concurrent submission attaches mid-sweep', async () => {
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)
      const { id: mediaId, fileId } = await upload(container)

      const originalList = service.listReviewMedias.bind(service)
      let interleaved = false

      jest
        .spyOn(service, 'listReviewMedias')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(async (...args: any[]) => {
          const filter = args[0] as
            | { review_id?: unknown; created_at?: unknown }
            | undefined

          // Only the sweep's own read: review_id === null AND a created_at
          // cutoff. attachReviewMediaStep's reads are keyed by `id` or by a
          // concrete review_id, so they cannot match this and cannot
          // recurse into the interleave below.
          const isSweepRead =
            !!filter && filter.review_id === null && filter.created_at !== undefined

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows = await (originalList as any)(...args)

          if (isSweepRead && !interleaved) {
            interleaved = true

            await createReviewWorkflow(container).run({
              input: {
                product_id: 'prod_sweep_race',
                rating: 5,
                content: 'x'.repeat(20),
                display_name: 'Ada',
                media_ids: [mediaId],
              },
            })
          }

          return rows
        })

      const future = new Date(Date.now() + 25 * 60 * 60 * 1000)
      await sweepOrphanReviewMedia(container, future)

      jest.restoreAllMocks()

      // The interleave must actually have happened, or this test proves
      // nothing at all.
      expect(interleaved).toBe(true)

      const [row] = await service.listReviewMedias({ id: mediaId })
      expect(row).toBeDefined()
      expect(row.review_id).not.toBeNull()

      // The bytes matter more than the row: a surviving row pointing at a
      // deleted file is still the customer's photo destroyed.
      const fileService = container.resolve(Modules.FILE)
      await expect(fileService.getAsBuffer(fileId)).resolves.toBeDefined()

      const reviews = await service.listReviews({ product_id: 'prod_sweep_race' })
      expect(reviews).toHaveLength(1)
    })

    /**
     * An unbounded `listReviewMedias` is how this job stops working
     * permanently: enough accumulated orphans and it OOMs or times out
     * every hour and never makes progress again, disabling the exact
     * defence it exists to provide. Two things are asserted - that every
     * query it issues carries a `take`, and that it still drains a backlog
     * larger than one batch rather than deleting a single page per run.
     */
    it('bounds every query it issues and still drains a multi-batch backlog', async () => {
      const container = getContainer()
      const service = container.resolve(REVIEW_MODULE)

      const uploaded: { id: string; fileId: string }[] = []
      for (let i = 0; i < 5; i++) {
        uploaded.push(await upload(container))
      }

      const originalList = service.listReviewMedias.bind(service)
      const takes: unknown[] = []

      jest
        .spyOn(service, 'listReviewMedias')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(async (...args: any[]) => {
          const filter = args[0] as
            | { review_id?: unknown; created_at?: unknown }
            | undefined
          const config = args[1] as { take?: unknown } | undefined

          if (!!filter && filter.review_id === null && filter.created_at !== undefined) {
            takes.push(config?.take)
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return await (originalList as any)(...args)
        })

      const future = new Date(Date.now() + 25 * 60 * 60 * 1000)
      const result = await sweepOrphanReviewMedia(container, future, 2)

      jest.restoreAllMocks()

      expect(takes.length).toBeGreaterThan(1)
      expect(takes.every((take) => typeof take === 'number')).toBe(true)

      // All five drained despite a batch size of two, so the hourly cadence
      // is not the only thing making progress.
      expect(result.deleted).toBeGreaterThanOrEqual(5)
      for (const { id } of uploaded) {
        expect(await service.listReviewMedias({ id })).toHaveLength(0)
      }
    })
  },
})
