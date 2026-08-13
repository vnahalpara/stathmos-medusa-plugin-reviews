import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'

type Input = { review_id: string; media_ids: string[] }

/**
 * Media is uploaded anonymously (Task 4) before the review that will own it
 * exists, so `media_ids` arriving here are bare, guessable-looking ids with
 * no proof of who uploaded them. Refusing an id that is already attached to
 * a review is what stops one shopper claiming another shopper's uploaded
 * photo by guessing or reusing its id - see the "already attached" check
 * below, which is the load-bearing assertion for this step.
 */
export const attachReviewMediaStep = createStep(
  'attach-review-media',
  async (input: Input, { container }) => {
    if (!input.media_ids.length) {
      return new StepResponse({ attached: [] as string[] }, [] as string[])
    }

    const service = container.resolve(REVIEW_MODULE)
    const rows = await service.listReviewMedias({ id: input.media_ids })

    // Set membership, not a length comparison: a batch containing the same
    // id twice would under-count against media_ids.length and wrongly
    // report "unknown media" even though every id is valid.
    if (rows.length !== new Set(input.media_ids).size) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Unknown media')
    }

    const claimed = rows.filter((row) => row.review_id !== null)

    if (claimed.length) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Media is already attached to a review'
      )
    }

    await service.updateReviewMedias(
      rows.map((row, i) => ({ id: row.id, review_id: input.review_id, sort_order: i }))
    )

    return new StepResponse({ attached: rows.map((r) => r.id) }, rows.map((r) => r.id))
  },
  async (mediaIds, { container }) => {
    if (!mediaIds?.length) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.updateReviewMedias(
      mediaIds.map((id) => ({ id, review_id: null }))
    )
  }
)
