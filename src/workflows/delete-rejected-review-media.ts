import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { deleteRejectedReviewMediaStep } from './steps/delete-rejected-review-media'

export type DeleteRejectedReviewMediaInput = { review_ids: string[] }

/**
 * Deliberately its own top-level workflow, never composed into
 * moderateReviewsWorkflow - see deleteRejectedReviewMediaStep's docstring
 * for the full reasoning. Callers must await moderateReviewsWorkflow's
 * `.run()` to completion first, and only then start this one (see
 * deleteMediaForRejectedReviews below, and the two routes that call it), so
 * the status change has already committed by the time media deletion
 * begins.
 */
export const deleteRejectedReviewMediaWorkflow = createWorkflow(
  'delete-rejected-review-media',
  function (input: DeleteRejectedReviewMediaInput) {
    const result = deleteRejectedReviewMediaStep(input)

    return new WorkflowResponse(result)
  }
)

/**
 * Thin helper so both routes that need "reject, then delete those reviews'
 * media" (POST /admin/reviews/:id/reject and POST
 * /admin/reviews/batch/status with status "rejected") share one call site
 * instead of repeating the same `.run({ input: ... })` shape and the same
 * failure handling twice. The actual mutation - deleting files and rows -
 * happens entirely inside deleteRejectedReviewMediaStep, invoked through
 * the workflow's `.run()`; this function performs no service calls itself.
 *
 * deleteRejectedReviewMediaStep already catches and logs every per-item
 * file/row failure internally and never throws for those. The try/catch
 * here is one more layer of the same guarantee for whatever is outside
 * that loop entirely (e.g. failing to resolve a container registration) -
 * belt-and-suspenders, not the primary mechanism. Either way, the review's
 * status change this runs after has already committed and must not be
 * undone by a media-cleanup failure, so this never throws: it logs and
 * returns a result reflecting nothing having been deleted.
 */
export async function deleteMediaForRejectedReviews(
  container: MedusaContainer,
  reviewIds: string[]
): Promise<{ deleted: number; failed: number }> {
  if (!reviewIds.length) {
    return { deleted: 0, failed: 0 }
  }

  try {
    const { result } = await deleteRejectedReviewMediaWorkflow(container).run({
      input: { review_ids: reviewIds },
    })

    return result
  } catch (error) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    logger.error(
      `[reviews] failed to run media deletion for rejected review(s) ` +
        `${reviewIds.join(', ')}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `The review(s) stay rejected; their media may still be present.`
    )

    return { deleted: 0, failed: reviewIds.length }
  }
}
