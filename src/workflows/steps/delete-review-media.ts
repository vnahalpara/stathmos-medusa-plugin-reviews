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
 * File deleted before row, on purpose - for a feature whose whole point is
 * making offensive content actually go away, a partial failure must fail
 * toward "content gone, tidying incomplete", never toward "tidying done,
 * content still public". Compare the two possible partial failures:
 *
 *   - File first, then row delete fails: the offensive content is
 *     genuinely gone from storage. What's left is a row pointing at a
 *     missing file - a broken image, visible in the admin and cleanable by
 *     hand or a future sweep.
 *   - Row first, then file delete fails: the row (the only thing that
 *     referenced the file) is already gone, so the file becomes invisible
 *     to everything, including the Task 9 orphan sweep, which only ever
 *     looks at unattached rows, never at storage directly. The image is
 *     still live at its direct storage URL. The moderator believes they
 *     removed it. They did not.
 *
 * The second outcome is unacceptable for this feature, so file-first is the
 * only order that fails safely.
 */
export const deleteReviewMediaStep = createStep(
  'delete-review-media',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)
    const [media] = await service.listReviewMedias({ id: input.id })

    if (!media) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Media not found')
    }

    await deleteFilesWorkflow(container).run({
      input: { ids: [media.file_id] },
    })

    await service.deleteReviewMedias(input.id)

    return new StepResponse({ id: media.id, review_id: media.review_id })
  }
)
