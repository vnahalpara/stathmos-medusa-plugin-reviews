import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { deleteFilesWorkflow } from '@medusajs/medusa/core-flows'
import { REVIEW_MODULE } from '../modules/review'
import { orphanCutoff } from '../media/orphan-cutoff'

/**
 * How many orphan rows one pass over the table claims at a time. Without a
 * bound this job loads every orphan row into memory and issues one delete
 * with the whole id set - so past some backlog it OOMs or times out every
 * hour and never makes progress again, permanently disabling the very
 * defence it exists to provide (and letting storage grow without bound,
 * which is precisely the failure it was written to prevent).
 */
export const SWEEP_BATCH_SIZE = 500

/**
 * Ceiling on batches per run, so one invocation cannot run unboundedly long
 * against a huge backlog and collide with the next hourly tick. 500 x 40 =
 * 20,000 rows per run; anything beyond that drains on subsequent runs.
 */
const SWEEP_MAX_BATCHES = 40

/**
 * Uploads happen before the review exists, so every abandoned review form
 * leaves a stored file behind. Without this sweep, storage grows forever
 * with media no moderator will ever see.
 *
 * `now` is a parameter rather than read from the clock so the behaviour is
 * testable without waiting a day. `batchSize` is likewise a parameter so
 * multi-batch draining can be exercised without inserting 500+ rows.
 */
export async function sweepOrphanReviewMedia(
  container: MedusaContainer,
  now: Date,
  batchSize: number = SWEEP_BATCH_SIZE
): Promise<{ deleted: number }> {
  const service = container.resolve(REVIEW_MODULE)
  const cutoff = orphanCutoff(now)

  let deleted = 0

  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const orphans = await service.listReviewMedias(
      { review_id: null, created_at: { $lt: cutoff } },
      { take: batchSize, order: { created_at: 'ASC' } }
    )

    if (!orphans.length) {
      break
    }

    // Row deleted before file, and the row delete is the gate. This is a
    // deliberate inversion of the file-first order this job used to use.
    //
    // The read above cannot be trusted as the basis for the delete: it is a
    // separate round trip, and claimMediaForReview() - an ordinary review
    // submission - can attach any of these rows in the window before the
    // delete lands. Deleting by primary key then destroys a live review's
    // media, file and row, with the review reported as successfully
    // created and no error surfaced to anyone. deleteUnattachedMedia()
    // re-checks `review_id IS NULL` inside the DELETE's own WHERE clause,
    // so the database decides, and returns only the rows it actually
    // removed.
    //
    // Once the row delete is the conditional gate, file-first's rationale
    // no longer holds: if the row delete wins, the file delete below is
    // guaranteed to be operating on media nothing references; if it loses
    // (or deletes nothing), no file is touched at all. The idempotency
    // argument survives - a file delete that fails after its row is gone
    // leaves an orphaned object, but that is strictly better than the
    // alternative this ordering buys us, which is never deleting a live
    // review's bytes.
    const removed = await service.deleteUnattachedMedia(orphans.map((media) => media.id))

    if (removed.length) {
      await deleteFilesWorkflow(container).run({
        input: { ids: removed.map((media) => media.file_id) },
      })

      deleted += removed.length
    }

    if (orphans.length < batchSize) {
      break
    }
  }

  return { deleted }
}

export default async function sweepOrphanReviewMediaJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const { deleted } = await sweepOrphanReviewMedia(container, new Date())

  if (deleted > 0) {
    logger.info(`[reviews] swept ${deleted} orphaned media upload(s)`)
  }
}

export const config = {
  name: 'sweep-orphan-review-media',
  schedule: '0 * * * *',
}
