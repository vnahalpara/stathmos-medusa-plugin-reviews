import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { review_id: string }

/**
 * Deletes the (at most one, per Task 1's partial unique index) reply on a
 * review.
 *
 * Hard delete, deliberately - `service.deleteReviewReplies()`, not
 * `service.softDeleteReviewReplies()`. A soft-deleted row would still sit
 * under the `review_id` partial unique index (`WHERE deleted_at IS NULL`
 * only excludes it, it doesn't drop it - see the model's index comment),
 * so a soft delete here would work today but is the wrong default: it
 * leaves an orphaned, invisible row behind for no benefit, where a hard
 * delete leaves none. Contrast this with `upsertReviewReplyStep`'s
 * compensation, which also hard-deletes a freshly-created reply on
 * rollback for the identical reason - a row nothing else needs to keep
 * around.
 *
 * Compensation recreates the reply with its original content. Losing a
 * merchant's published response because an unrelated later step in this
 * workflow failed would be silent data loss they never authorised - the
 * merchant asked for the reply to go away, not for it to vanish as a side
 * effect of something else breaking.
 */
export const deleteReviewReplyStep = createStep(
  'delete-review-reply',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)

    const [existing] = await service.listReviewReplies(
      { review_id: input.review_id },
      { take: 1 }
    )
    if (!existing) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Reply not found')
    }

    await service.deleteReviewReplies(existing.id)

    return new StepResponse(
      { id: existing.id },
      {
        review_id: existing.review_id,
        content: existing.content,
        replied_by: existing.replied_by,
      }
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }
    const service = container.resolve(REVIEW_MODULE)
    await service.createReviewReplies(compensation)
  }
)
