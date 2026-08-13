import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { deleteFilesWorkflow } from '@medusajs/medusa/core-flows'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { id: string }

/**
 * Deletes both the review_media row and its underlying file. This is a
 * moderator removing a single offensive photo, not just hiding it - leaving
 * the file reachable at its storage URL after "deleting" it would defeat the
 * entire point of the feature, so the file goes too, not only the database
 * row.
 *
 * Deliberately has NO compensation. Restoring the row on some later step's
 * failure would leave it pointing at a file that may already be gone
 * (deleted below), which renders as a broken image - worse than not
 * restoring it at all. Nothing runs after this step that can fail, so there
 * is no later failure for a compensation to guard against, and this
 * deletion is meant to be irreversible: an offensive photo a moderator
 * removed should never come back from a saga replay.
 *
 * Row deleted before file, per plan ruling: if the file delete below fails,
 * the review_media row is already gone, so review_media/product summaries
 * never surface a dangling reference. See task-8-report.md for a note on an
 * inconsistency between this stated order and the sweep-style reasoning
 * used to justify it.
 */
export const deleteReviewMediaStep = createStep(
  'delete-review-media',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)
    const [media] = await service.listReviewMedias({ id: input.id })

    if (!media) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Media not found')
    }

    await service.deleteReviewMedias(input.id)

    await deleteFilesWorkflow(container).run({
      input: { ids: [media.file_id] },
    })

    return new StepResponse({ id: media.id, review_id: media.review_id })
  }
)
