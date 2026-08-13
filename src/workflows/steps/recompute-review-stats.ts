import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaContainer } from '@medusajs/framework/types'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { product_id: string }

export async function recomputeReviewStats(
  container: MedusaContainer,
  productId: string
) {
  const service = container.resolve(REVIEW_MODULE)

  const approved = await service.listReviews({
    product_id: productId,
    status: 'approved',
  })

  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>
  let total = 0

  for (const review of approved) {
    breakdown[review.rating] = (breakdown[review.rating] ?? 0) + 1
    total += review.rating
  }

  const count = approved.length
  const average = count === 0 ? 0 : Math.round((total / count) * 100) / 100

  const values = {
    product_id: productId,
    count,
    average,
    breakdown_1: breakdown[1],
    breakdown_2: breakdown[2],
    breakdown_3: breakdown[3],
    breakdown_4: breakdown[4],
    breakdown_5: breakdown[5],
    // Media lands in Phase 2; the column exists so the summary shape is stable.
    media_count: 0,
  }

  const [existing] = await service.listReviewStats({ product_id: productId })

  return existing
    ? await service.updateReviewStats({ id: existing.id, ...values })
    : await service.createReviewStats(values)
}

/**
 * Stats are derived data, so both apply and compensation do the same thing:
 * recompute from whatever the reviews table currently says.
 */
export const recomputeReviewStatsStep = createStep(
  'recompute-review-stats',
  async (input: Input, { container }) => {
    const stats = await recomputeReviewStats(container, input.product_id)

    return new StepResponse(stats, input.product_id)
  },
  async (productId, { container }) => {
    if (!productId) {
      return
    }

    await recomputeReviewStats(container, productId)
  }
)
