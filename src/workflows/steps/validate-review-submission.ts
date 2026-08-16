import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'
import { getReviewSettings } from '../../settings/get-review-settings'
import { ReviewSettingsValues } from '../../modules/review/settings-defaults'

type Input = {
  product_id: string
  content: string
  customer_id?: string | null
  is_verified_purchase: boolean
}

/**
 * The one place review content is measured against `min_content_length` /
 * `max_content_length`. Exported so applyReviewEditStep (update-review.ts)
 * can enforce the exact same bounds a new submission does, rather than a
 * second, independently-maintained pair of `if`s that could quietly drift
 * from these - the two call sites must always agree on what "too short" and
 * "too long" mean for the same settings row.
 */
export function assertContentLengthWithinBounds(
  content: string,
  settings: Pick<ReviewSettingsValues, 'min_content_length' | 'max_content_length'>
): void {
  if (content.length < settings.min_content_length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Review must be at least ${settings.min_content_length} characters`
    )
  }

  if (content.length > settings.max_content_length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Review must be at most ${settings.max_content_length} characters`
    )
  }
}

export const validateReviewSubmissionStep = createStep(
  'validate-review-submission',
  async (input: Input, { container }) => {
    const settings = await getReviewSettings(container)

    if (!settings.enabled) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Reviews are disabled')
    }

    if (!input.customer_id && !settings.allow_guest) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        'You must be signed in to leave a review'
      )
    }

    // verified_only implies customers only: a guest can never prove purchase.
    if (settings.verified_only && !input.is_verified_purchase) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Only customers who purchased this product can review it'
      )
    }

    assertContentLengthWithinBounds(input.content, settings)

    if (settings.one_review_per_customer && input.customer_id) {
      const service = container.resolve(REVIEW_MODULE)
      const existing = await service.listReviews({
        product_id: input.product_id,
        customer_id: input.customer_id,
      })

      if (existing.length > 0) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          'You have already reviewed this product'
        )
      }
    }

    // Annotated so the literal union survives generic inference through
    // StepResponse instead of widening to `string` (which would then fail
    // to satisfy createReviewStep's narrower Input.status type downstream).
    const status: 'pending' | 'approved' = settings.require_approval
      ? 'pending'
      : 'approved'

    return new StepResponse({ status })
  }
)
