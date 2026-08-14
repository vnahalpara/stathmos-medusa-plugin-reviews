import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { deleteFilesWorkflow } from '@medusajs/medusa/core-flows'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { review_ids: string[] }

/**
 * Deletes every review_media row (and its underlying file) attached to each
 * review in review_ids. This is the rejection path, not the single-photo
 * admin delete (see delete-review-media.ts) - rejecting a review destroys
 * ALL of its media, permanently. That is the user's explicit decision: a
 * reversible alternative (soft-delete, a private-access flip, a settings
 * toggle) was offered and declined in favour of deletion.
 *
 * Two different ordering concerns apply here, and they must not be
 * confused with each other:
 *
 * 1. Relative to the review's status change: this step is never composed
 *    into moderateReviewsWorkflow's saga. It runs inside its own top-level
 *    workflow (deleteRejectedReviewMediaWorkflow, below), started only
 *    after moderateReviewsWorkflow's `.run()` has already resolved - see
 *    the reject and batch-status routes, which await the status change
 *    before calling this at all. moderateReviewsStep writes the review's
 *    new status to the database as a normal, already-committed write
 *    before its own step even returns, so by the time this step's workflow
 *    starts, that write is done and moderateReviewsWorkflow's saga has
 *    already finished successfully. There is nothing left for a failure
 *    here to compensate.
 *
 *    That separation is deliberate, not incidental: if this step's failure
 *    could reach back and compensate moderateReviewsStep, the review would
 *    revert to `pending` while some of its media is already destroyed -
 *    telling everyone the rejection "didn't happen" when it partially did,
 *    in the one direction (deleted photos) that can never be undone. So
 *    this step also never throws for an individual media item's failure
 *    (every per-item error is caught, logged and skipped, see below), and
 *    it carries no compensation function of its own - both would be
 *    meaningless for a step that must not be able to affect a saga it was
 *    never part of.
 *
 * 2. Within a single media item: file before row, exactly the reasoning
 *    documented in delete-review-media.ts - a moderator or a sweep must
 *    never be able to observe "row gone" while the file is still publicly
 *    retrievable at its storage URL, so a partial per-item failure has to
 *    fail toward "file gone, row dangling", never the reverse. See that
 *    file's docstring for the full argument; it applies unchanged here.
 *
 * A single item's failure (file delete or row delete) is caught, logged,
 * and does not stop the loop: one bad delete must not leave the rest of
 * this review's media - or another review's media in the same batch -
 * untouched. Whichever review(s) triggered this stay rejected regardless of
 * how many of these deletes succeed; anything left behind here is still
 * reachable through DELETE /admin/reviews/media/:id or the hourly orphan
 * sweep... except the orphan sweep only ever looks at unattached
 * (review_id IS NULL) rows, so a media row left behind by a failed delete
 * here - still attached to its now-rejected review - is only ever cleaned
 * up by a moderator calling the single-item delete route, or a future
 * retry of this same cleanup. It does not silently disappear on its own.
 */
export const deleteRejectedReviewMediaStep = createStep(
  'delete-rejected-review-media',
  async (input: Input, { container }) => {
    if (!input.review_ids.length) {
      return new StepResponse({ deleted: 0, failed: 0 })
    }

    const service = container.resolve(REVIEW_MODULE)
    const media = await service.listReviewMedias({ review_id: input.review_ids })

    if (!media.length) {
      return new StepResponse({ deleted: 0, failed: 0 })
    }

    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    let deleted = 0
    let failed = 0

    for (const item of media) {
      try {
        await deleteFilesWorkflow(container).run({
          input: { ids: [item.file_id] },
        })

        await service.deleteReviewMedias(item.id)
        deleted++
      } catch (error) {
        failed++

        logger.error(
          `[reviews] failed to delete media ${item.id} (file ${item.file_id}) for ` +
            `rejected review ${item.review_id}: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            `The review stays rejected; this media was left behind for ` +
            `DELETE /admin/reviews/media/:id to clean up.`
        )
      }
    }

    return new StepResponse({ deleted, failed })
  }
  // Deliberately no compensation function - see the docstring above: this
  // step must never be able to affect a saga (moderateReviewsWorkflow's)
  // that has already completed by the time it runs, and the deletions it
  // performs are meant to be irreversible in the first place.
)
