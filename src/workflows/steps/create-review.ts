import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { REVIEW_MODULE } from '../../modules/review'

type Input = {
  product_id: string
  customer_id?: string | null
  display_name: string
  email?: string | null
  rating: number
  title?: string | null
  content: string
  status: 'pending' | 'approved' | 'rejected'
  is_verified_purchase: boolean
}

export const createReviewStep = createStep(
  'create-review',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)
    const review = await service.createReviews(input)

    return new StepResponse(review, review.id)
  },
  async (id, { container }) => {
    if (!id) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.deleteReviews(id)
  }
)
