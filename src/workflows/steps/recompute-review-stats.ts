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

/**
 * How many approved reviews are materialised at a time. Medusa applies no
 * implicit default here - `buildQuery` leaves `limit: undefined` when
 * `config.take` is absent - so without this the recompute loads every
 * approved review for a product into memory and then issues an `IN` list of
 * every one of their ids against review_media. That runs on every review
 * submission, every moderation action and every media delete, so its cost
 * grows without bound on exactly the products that are doing well.
 */
export const STATS_PAGE_SIZE = 500

/**
 * Ceiling on pages per recompute, so a single write cannot walk an
 * unbounded table. 500 x 200 = 100,000 approved reviews for one product.
 */
const STATS_MAX_PAGES = 200

export async function recomputeReviewStats(
  container: MedusaContainer,
  productId: string,
  pageSize: number = STATS_PAGE_SIZE
) {
  const service = container.resolve(REVIEW_MODULE)

  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>
  let total = 0
  let count = 0
  let mediaCount = 0

  for (let page = 0; page < STATS_MAX_PAGES; page++) {
    const approved = await service.listReviews(
      { product_id: productId, status: 'approved' },
      { take: pageSize, skip: page * pageSize, order: { id: 'ASC' } }
    )

    if (!approved.length) {
      break
    }

    for (const review of approved) {
      breakdown[review.rating] = (breakdown[review.rating] ?? 0) + 1
      total += review.rating
    }

    count += approved.length

    // Same rule as the store routes: media is only ever counted for
    // reviews already filtered to approved, and hidden media is excluded -
    // visibility stays derived from the parent review, never a separately
    // stored fact that could drift. Counted with listAndCount so the rows
    // are never materialised, and keyed by one page of ids at a time so
    // the `IN` list stays bounded too.
    const [, pageMediaCount] = await service.listAndCountReviewMedias(
      { review_id: approved.map((review) => review.id), hidden_at: null },
      { take: 1, select: ['id'] }
    )

    mediaCount += pageMediaCount

    if (approved.length < pageSize) {
      break
    }
  }

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
    media_count: mediaCount,
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
