import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = {
  id: string
  pinned?: boolean
  hidden?: boolean
}

// Only the fields this request actually touched are ever present here -
// never both, unconditionally. That is what lets the compensation below
// restore exactly what this step changed and nothing else: a request that
// only sets `hidden` must never have its compensation branch also reset
// `pinned_at`, which it never touched in the first place and has no
// captured "previous" value for.
type Compensation = {
  id: string
  previous_pinned_at?: Date | null
  previous_hidden_at?: Date | null
}

/**
 * Sets or clears one or both of `review_media.pinned_at`/`hidden_at` - the
 * two curation columns Task 4's gallery query already reads
 * (`pinned_at DESC NULLS LAST` for ordering, `hidden_at IS NULL` for
 * visibility) but that, until this step, nothing could ever write.
 *
 * `pinned: true`/`hidden: true` stamp a fresh `new Date()`, not a
 * caller-supplied timestamp - a curation column records "when a moderator
 * acted", not an arbitrary value a request could backdate.
 * `pinned: false`/`hidden: false` null the corresponding column out.
 * `undefined` (the field omitted from the request) leaves that column
 * untouched entirely - CurateMediaSchema requires at least one of the two
 * to be present, but never both is guaranteed, so this step must handle
 * "only one of the two given" as the common case, not the exception.
 *
 * Compensation restores the PREVIOUS value of whichever column(s) this
 * request touched - never null, unconditionally. Nulling on rollback would
 * silently erase curation a moderator set in some earlier, unrelated
 * request (e.g. this call only unhides an item that has been pinned since
 * last week; a downstream failure must put `hidden_at` back to what it
 * was, not also wipe the pin nothing here ever asked to change). See
 * update-review-settings.ts's `previous` snapshot for the same shape of
 * guarantee applied to a different table.
 *
 * Returns `{ media, review_id, product_id }` rather than the bare row -
 * the same shape applyReviewEditStep already uses for the same reason.
 * curateReviewMediaWorkflow needs a PRODUCT id to put on its
 * `review.media.curated` event, because a subscriber's whole reason to
 * listen is invalidating the cache of the page this media is shown on, and
 * neither the media row nor the curation request carries one - only the
 * parent review does. Resolving it here, in the step that has already
 * loaded the media, costs one extra read on a path a moderator triggers by
 * hand; making every host's subscriber resolve it instead would push a
 * plugin-internal join into the revalidation recipe. `product_id` is null
 * exactly when `review_id` is - an uploaded-but-never-attached row, which
 * the orphan sweep deletes and which no storefront page has ever shown.
 */
export const setMediaCurationStep = createStep(
  'set-media-curation',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)
    const [media] = await service.listReviewMedias({ id: input.id })

    if (!media) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Media not found')
    }

    const changes: { pinned_at?: Date | null; hidden_at?: Date | null } = {}
    const compensation: Compensation = { id: input.id }

    if (input.pinned !== undefined) {
      compensation.previous_pinned_at = media.pinned_at
      changes.pinned_at = input.pinned ? new Date() : null
    }

    if (input.hidden !== undefined) {
      compensation.previous_hidden_at = media.hidden_at
      changes.hidden_at = input.hidden ? new Date() : null
    }

    const updated = await service.updateReviewMedias({ id: input.id, ...changes })

    const [review] = media.review_id
      ? await service.listReviews({ id: media.review_id }, { take: 1 })
      : []

    return new StepResponse(
      {
        media: updated,
        review_id: media.review_id,
        product_id: review?.product_id ?? null,
      },
      compensation
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }

    const restore: { id: string; pinned_at?: Date | null; hidden_at?: Date | null } = {
      id: compensation.id,
    }

    // `in` rather than `!== undefined`: a captured previous value of
    // `null` (the ordinary "was not pinned/hidden before this request"
    // case) is itself a value this branch must restore, not skip - `in`
    // is the only check that tells "field was never touched by this
    // request" (skip) apart from "field was touched and its previous
    // value happened to be null" (restore null).
    if ('previous_pinned_at' in compensation) {
      restore.pinned_at = compensation.previous_pinned_at
    }
    if ('previous_hidden_at' in compensation) {
      restore.hidden_at = compensation.previous_hidden_at
    }

    // Nothing to restore if this step never reached its write (e.g. the
    // 404 branch above threw before returning a StepResponse at all, so
    // this compensation never runs for that case) - defensive only, since
    // `compensation` always carries at least one of the two `previous_*`
    // keys whenever this function does run.
    if (restore.pinned_at === undefined && restore.hidden_at === undefined) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.updateReviewMedias(restore)
  }
)
