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
 * Compensation recreates the reply VERBATIM - same id, same
 * `created_at`/`updated_at`, same content and `replied_by`. Losing a
 * merchant's published response because an unrelated later step in this
 * workflow failed would be silent data loss they never authorised: the
 * request errored, so the database must look like the delete never
 * happened, and a retry (which is what a merchant does after an error)
 * then re-runs the whole workflow, including the event nothing else would
 * ever fire.
 *
 * This restore used to be lossy - `createReviewReplies` was called with
 * content and `replied_by` only, so rollback minted a fresh id and fresh
 * timestamps, and a reply written months ago came back stamped "just now"
 * with an id that changed underneath anything holding it. That was
 * documented and accepted while nothing could ever trigger it (this
 * workflow had a single step, so there was no downstream failure to
 * compensate). Phase 5 added `emitEventStep` after this one, which made
 * the path reachable, so the warning left for "whoever adds a step after
 * this one" came due and the restore is now exact.
 *
 * Passing `id`, `created_at` and `updated_at` to a create is only worth
 * doing because it demonstrably works: all three are honoured by the ORM
 * rather than being silently replaced by a generated id and `now()`
 * (probed directly against this service, and pinned by
 * delete-review-reply-compensation.spec.ts, which backdates a reply and
 * asserts the exact id and timestamp come back). A snapshot restore whose
 * fields were quietly ignored would be worse than the honest lossy version
 * it replaced.
 *
 * Restoring by re-inserting the row rather than switching this step to a
 * soft delete is deliberate: see the hard-delete paragraph above. A soft
 * delete would make rollback trivially lossless, but it would keep every
 * deleted reply in the table forever - including the ones a merchant
 * deletes precisely because the text should not exist anywhere - with no
 * surface that can ever see or purge them.
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
        id: existing.id,
        review_id: existing.review_id,
        content: existing.content,
        replied_by: existing.replied_by,
        created_at: existing.created_at,
        updated_at: existing.updated_at,
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
