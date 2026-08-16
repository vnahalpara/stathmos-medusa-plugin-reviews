import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'
import { getReviewSettings } from '../../settings/get-review-settings'
import { assertContentLengthWithinBounds } from './validate-review-submission'

type Input = {
  review_id: string
  customer_id: string | null
  rating?: number
  title?: string | null
  content?: string
}

type PreviousState = {
  id: string
  rating: number
  title: string | null
  content: string
  status: 'pending' | 'approved' | 'rejected'
  edited_at: Date | null
}

/**
 * Ownership is the whole security boundary for this step - see the two
 * checks below, both of which throw MedusaError.Types.FORBIDDEN (403) with
 * a message that explains why, never a bare framework 403/401. That is
 * deliberate: editing someone else's review would let one customer rewrite
 * another's public words, the worst outcome available on this endpoint, so
 * ownership is verified against the row itself (`review.customer_id`), not
 * inferred from a scoped query that could silently 404 instead of refusing.
 *
 *   1. A guest request (`customer_id` null - no session/bearer token, see
 *      the route's `allowUnauthenticated: true`) has no credential tying it
 *      to any review at all. There is nothing to check it against, so this
 *      is refused before the review is even looked up.
 *   2. A signed-in customer whose id does not match the review's own
 *      `customer_id` - including a guest-authored review, whose
 *      `customer_id` is null and can therefore never match any signed-in
 *      customer's id.
 */
export const applyReviewEditStep = createStep(
  'apply-review-edit',
  async (input: Input, { container }) => {
    const settings = await getReviewSettings(container)

    if (!settings.enabled) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Reviews are disabled')
    }

    if (!settings.allow_edit) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Editing reviews is not enabled for this store'
      )
    }

    if (!input.customer_id) {
      throw new MedusaError(
        MedusaError.Types.FORBIDDEN,
        'A guest submission cannot be edited: there is no account to verify it belongs to you. Sign in with the account you used, if any.'
      )
    }

    const service = container.resolve(REVIEW_MODULE)
    const [review] = await service.listReviews({ id: input.review_id }, { take: 1 })

    if (!review) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Review not found')
    }

    if (review.customer_id !== input.customer_id) {
      throw new MedusaError(
        MedusaError.Types.FORBIDDEN,
        'You may only edit your own review'
      )
    }

    if (input.content !== undefined) {
      assertContentLengthWithinBounds(input.content, settings)
    }

    // Mirrors validateReviewSubmissionStep's identical status decision for
    // a brand-new submission: `require_approval` on means edited text has
    // not been reviewed, so the review must go back to `pending` - the
    // whole point of re-moderation - and stay approved otherwise.
    //
    // BUT a review whose current status is `rejected` is never allowed to
    // fall through to `approved`, even when require_approval is off. Do
    // not "simplify" this back to the require_approval-only rule above:
    // require_approval is a store-wide POLICY about content nobody has
    // looked at yet, whereas a rejection is a human moderator's judgment
    // about THIS SPECIFIC review. Auto-approval settings must never let an
    // edit silently overturn that judgment - only a moderator re-approving
    // it should. Editing stays allowed (the customer can still fix a
    // rejected review), they just cannot republish it themselves; it lands
    // in `pending` for a human to look at again, same as any other edit
    // under require_approval.
    const status: 'pending' | 'approved' =
      review.status === 'rejected' || settings.require_approval ? 'pending' : 'approved'

    const previous: PreviousState = {
      id: review.id,
      rating: review.rating,
      title: review.title,
      content: review.content,
      status: review.status,
      edited_at: review.edited_at,
    }

    const [updated] = await service.updateReviews([
      {
        id: review.id,
        rating: input.rating ?? review.rating,
        title: input.title !== undefined ? input.title : review.title,
        content: input.content ?? review.content,
        status,
        edited_at: new Date(),
      },
    ])

    return new StepResponse({ review: updated, product_id: review.product_id }, previous)
  },
  async (previous, { container }) => {
    if (!previous) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.updateReviews([previous])
  }
)
