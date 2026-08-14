import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { review_id: string; content: string; replied_by?: string }

/**
 * One reply per review (Task 1's partial unique index enforces this at the
 * database level too), so this upserts rather than always inserting: a
 * second POST to the same review edits the existing reply in place instead
 * of racing that constraint into a 500.
 *
 * The create-or-update decision itself is made by a single atomic
 * statement - `service.upsertReviewReply()`, see its docstring in
 * `src/modules/review/service.ts` - not by reading first and branching
 * here. Two concurrent first replies to the same review both call that one
 * statement; Postgres's `ON CONFLICT DO UPDATE` resolves which one "wins"
 * as a create and which becomes an edit, atomically, so there is no window
 * for both to observe "no existing reply" and race each other into the
 * unique index.
 */
export const upsertReviewReplyStep = createStep(
  'upsert-review-reply',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)

    const [review] = await service.listReviews({ id: input.review_id }, { take: 1 })
    if (!review) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Review not found')
    }

    // Read purely for compensation bookkeeping - it plays no part in the
    // create-or-update decision below, so it cannot reopen the race the
    // atomic upsert exists to close. In the ordinary, non-concurrent path
    // (the only path either compensation test below exercises) this
    // accurately captures the text that was live immediately before this
    // call. It is not immune to every pathological interleaving: if this
    // very request loses a concurrent first-reply race (its upsert becomes
    // the *update* branch even though this read saw nothing), this read
    // sees no row and cannot report the true prior text - restoring on a
    // later failure would then be a no-op rather than an accurate rollback.
    // That compound case (a race AND a downstream failure in the same
    // request) is out of scope here; nothing in this task's test coverage
    // requires it, and closing it would need locking the read together
    // with the write inside one statement, trading simplicity for a
    // corner nobody has asked to guard yet.
    const [existingBeforeWrite] = await service.listReviewReplies(
      { review_id: input.review_id },
      { take: 1 }
    )

    const reply = await service.upsertReviewReply({
      review_id: input.review_id,
      content: input.content,
      replied_by: input.replied_by ?? null,
    })

    if (!reply.created) {
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
        { reply, created: false },
        {
          created: false,
          id: reply.id,
          previous_content: existingBeforeWrite?.content ?? reply.content,
        }
      )
    }

    return new StepResponse(
      { reply, created: true },
      { created: true, id: reply.id, previous_content: '' }
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
      // deleteReviewReplies() is the hard-delete method on this service.
      // softDeleteReviewReplies() would NOT block a future reply here -
      // the partial unique index is `WHERE deleted_at IS NULL`, so a
      // soft-deleted row is excluded from it, not blocked by it - but it
      // would still leave a permanent, orphaned row that nothing ever
      // cleans up, for a reply that was never actually published. Same
      // decision, same reasoning, as delete-review-reply.ts's docstring.
      await service.deleteReviewReplies(compensation.id)
      return
    }

    await service.updateReviewReplies({
      id: compensation.id,
      content: compensation.previous_content,
    })
  }
)
