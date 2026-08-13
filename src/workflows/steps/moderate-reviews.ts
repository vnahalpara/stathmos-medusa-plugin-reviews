import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = {
  ids: string[]
  status: 'approved' | 'rejected' | 'pending'
  rejection_reason?: string | null
}

type PreviousState = {
  id: string
  status: 'pending' | 'approved' | 'rejected'
  rejection_reason: string | null
}[]

export const moderateReviewsStep = createStep(
  'moderate-reviews',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)

    const existing = await service.listReviews({ id: input.ids })

    if (existing.length !== input.ids.length) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Review not found')
    }

    const previous: PreviousState = existing.map((review) => ({
      id: review.id,
      status: review.status,
      rejection_reason: review.rejection_reason,
    }))

    const updated = await service.updateReviews(
      input.ids.map((id) => ({
        id,
        status: input.status,
        rejection_reason: input.status === 'rejected' ? input.rejection_reason ?? null : null,
      }))
    )

    return new StepResponse(
      { reviews: updated, product_ids: [...new Set(existing.map((r) => r.product_id))] },
      previous
    )
  },
  async (previous, { container }) => {
    if (!previous) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)

    // Restore each review's own previous status/reason individually rather
    // than blanket-resetting the whole batch to one value - a failed bulk
    // action must not silently flip a review the merchant never touched, and
    // must not leave the queue in a half-moderated state.
    await service.updateReviews(previous)
  }
)
