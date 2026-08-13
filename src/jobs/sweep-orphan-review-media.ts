import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { deleteFilesWorkflow } from '@medusajs/medusa/core-flows'
import { REVIEW_MODULE } from '../modules/review'
import { orphanCutoff } from '../media/orphan-cutoff'

/**
 * Uploads happen before the review exists, so every abandoned review form
 * leaves a stored file behind. Without this sweep, storage grows forever
 * with media no moderator will ever see.
 *
 * `now` is a parameter rather than read from the clock so the behaviour is
 * testable without waiting a day.
 */
export async function sweepOrphanReviewMedia(
  container: MedusaContainer,
  now: Date
): Promise<{ deleted: number }> {
  const service = container.resolve(REVIEW_MODULE)

  const orphans = await service.listReviewMedias({
    review_id: null,
    created_at: { $lt: orphanCutoff(now) },
  })

  if (!orphans.length) {
    return { deleted: 0 }
  }

  // File deleted before row, on purpose. If the row were deleted first and
  // the file delete below then failed, the row - the only thing that
  // referenced the file - would already be gone: the file becomes an
  // invisible orphan, unreachable from anything, including this very sweep,
  // which only ever finds unattached rows and never scans storage directly.
  //
  // File-first fails the other way: if the row delete below fails after the
  // file is already gone, what's left is a row pointing at a missing file.
  // That's still an unattached row older than the TTL, so the next hourly
  // run picks it straight back up and finishes the job. This sweep runs
  // hourly and is naturally idempotent, so file-first buys a free retry
  // that row-first would forfeit permanently.
  await deleteFilesWorkflow(container).run({
    input: { ids: orphans.map((media) => media.file_id) },
  })

  await service.deleteReviewMedias(orphans.map((media) => media.id))

  return { deleted: orphans.length }
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
