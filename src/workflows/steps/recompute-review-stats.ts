import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaContainer } from '@medusajs/framework/types'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { product_id: string }

/**
 * Two concurrent first-time recomputes for the same product both see no
 * existing review_stats row and race to create one. Postgres's unique index
 * on product_id catches the loser, but the DB layer (see @medusajs/utils's
 * db-error-mapper) remaps that from a raw driver error into a MedusaError
 * before it reaches here - it never carries the Postgres error code, so a
 * generic "is this a unique-violation" check (e.g. isDuplicateError) cannot
 * see it. Matching on the mapper's own INVALID_DATA + "already exists"
 * shape is what's actually observable at this layer, scoped further to
 * "product_id" so it cannot accidentally swallow an unrelated INVALID_DATA
 * error from elsewhere in this function.
 */
function isDuplicateProductStatsError(error: unknown): boolean {
  return (
    error instanceof MedusaError &&
    error.type === MedusaError.Types.INVALID_DATA &&
    error.message.includes('already exists') &&
    error.message.includes('product_id')
  )
}

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

  const approvedIds = approved.map((review) => review.id)

  // Same rule as the store routes: media is only ever counted for reviews
  // already filtered to approved, in one query keyed by the whole id set,
  // and hidden media is excluded - visibility stays derived from the
  // parent review, never a separately stored fact that could drift.
  const media = approvedIds.length
    ? await service.listReviewMedias({ review_id: approvedIds, hidden_at: null })
    : []

  const values = {
    product_id: productId,
    count,
    average,
    breakdown_1: breakdown[1],
    breakdown_2: breakdown[2],
    breakdown_3: breakdown[3],
    breakdown_4: breakdown[4],
    breakdown_5: breakdown[5],
    media_count: media.length,
  }

  const [existing] = await service.listReviewStats({ product_id: productId })

  if (existing) {
    return await service.updateReviewStats({ id: existing.id, ...values })
  }

  try {
    return await service.createReviewStats(values)
  } catch (error) {
    if (!isDuplicateProductStatsError(error)) {
      throw error
    }

    // Fall back to updating whichever row won the race instead of failing
    // the caller - the data is derived and idempotent, so converging on a
    // single row is correct regardless of which insert actually landed.
    const [winner] = await service.listReviewStats({ product_id: productId })

    if (!winner) {
      throw error
    }

    return await service.updateReviewStats({ id: winner.id, ...values })
  }
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
