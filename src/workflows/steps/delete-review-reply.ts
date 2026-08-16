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
 *
 * The recreated row is not a perfect restore: `createReviewReplies` mints
 * a fresh `id` and stamps fresh `created_at`/`updated_at` at rollback time,
 * so a merchant would see "replied just now" rather than the true original
 * reply time. Accepted for now because this compensation function is
 * unreachable in production today - `deleteReviewReplyWorkflow` has only
 * this one step, so nothing downstream can ever fail and trigger it.
 * Whoever adds a step after this one should know the recreate is lossy in
 * both id and timestamps before relying on it.
 *
 * Returns the parent review's `product_id` so the workflow can put it on
 * `review.reply.deleted` - the reply row itself only knows `review_id`,
 * and a subscriber invalidating a cached product page needs the product.
 * Resolved BEFORE the delete, while there is still a row to resolve it
 * from. It is `null` only if the reply outlived its review, which nothing
 * in this plugin can currently produce (there is no delete-review route);
 * the workflow documents what happens in that case rather than pretending
 * it cannot.
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

    const [review] = await service.listReviews({ id: existing.review_id }, { take: 1 })

    await service.deleteReviewReplies(existing.id)

    return new StepResponse(
      {
        id: existing.id,
        review_id: existing.review_id,
        product_id: review?.product_id ?? null,
      },
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
