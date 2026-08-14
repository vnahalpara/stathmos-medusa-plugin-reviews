import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { review_id: string; content: string; replied_by?: string }

/**
 * One reply per review (Task 1's partial unique index enforces this at the
 * database level too), so this step upserts rather than always inserting: a
 * second POST to the same review edits the existing reply in place instead
 * of racing that constraint into a 500.
 */
export const upsertReviewReplyStep = createStep(
  'upsert-review-reply',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)

    const [review] = await service.listReviews({ id: input.review_id }, { take: 1 })
    if (!review) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Review not found')
    }

    const [existing] = await service.listReviewReplies(
      { review_id: input.review_id },
      { take: 1 }
    )

    if (existing) {
      const updated = await service.updateReviewReplies({
        id: existing.id,
        content: input.content,
        replied_by: input.replied_by ?? null,
      })

      // Compensation restores the previous text rather than deleting a
      // reply the merchant had already published - an edit that fails
      // downstream in the workflow must roll back to what was live before,
      // not erase the merchant's original reply. `previous_content` is
      // always present (empty on the create branch, below, and unused
      // there) so both StepResponse compensation payloads share one
      // structural shape - a discriminated union here gets its `created`
      // literal widened to `boolean` by TS's generic inference across the
      // two return sites, silently dropping whichever field only one
      // branch declared.
      return new StepResponse(
        { reply: updated, created: false },
        { created: false, id: existing.id, previous_content: existing.content }
      )
    }

    const created = await service.createReviewReplies({
      review_id: input.review_id,
      content: input.content,
      replied_by: input.replied_by ?? null,
    })

    return new StepResponse(
      { reply: created, created: true },
      { created: true, id: created.id, previous_content: '' }
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)

    if (compensation.created) {
      // A brand-new reply never went live for anyone to have seen as
      // canon, so undoing it is a hard delete, not a soft one -
      // deleteReviewReplies() is the hard-delete method on this service;
      // softDeleteReviewReplies() would leave the row (and the partial
      // unique index) blocking a future reply to this review.
      await service.deleteReviewReplies(compensation.id)
      return
    }

    await service.updateReviewReplies({
      id: compensation.id,
      content: compensation.previous_content,
    })
  }
)
