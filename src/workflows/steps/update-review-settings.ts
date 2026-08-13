import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { Modules } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'
import {
  REVIEW_SETTINGS_ID,
  ReviewSettingsValues,
} from '../../modules/review/settings-defaults'
import { REVIEW_SETTINGS_CACHE_KEY } from '../../settings/get-review-settings'

type Input = Partial<ReviewSettingsValues>

// Compensation must undo exactly the row this step touched. For an update
// that is the previous snapshot; for a create it is the id the module
// service actually assigned, which is not guaranteed to be the id we asked
// for (see the createReviewSettings call below), so we capture it from the
// create result rather than assuming a constant.
type Compensation =
  | { existed: true; previous: Record<string, unknown> }
  | { existed: false; createdId: string }

export const updateReviewSettingsStep = createStep(
  'update-review-settings',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)
    const cache = container.resolve(Modules.CACHE)

    const [existing] = await service.listReviewSettings({}, { take: 1 })

    // id here is a hint, not a guarantee: the underlying entity assigns its
    // own rset_-prefixed id unless the DML layer honours a client-supplied
    // one, so the compensation branch below never relies on this constant.
    const saved = existing
      ? await service.updateReviewSettings({ id: existing.id, ...input })
      : await service.createReviewSettings({ id: REVIEW_SETTINGS_ID, ...input })

    await cache.invalidate(REVIEW_SETTINGS_CACHE_KEY)

    const compensation: Compensation = existing
      ? { existed: true, previous: { ...existing } }
      : { existed: false, createdId: saved.id }

    return new StepResponse(saved, compensation)
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    const cache = container.resolve(Modules.CACHE)

    if (compensation.existed) {
      await service.updateReviewSettings(compensation.previous)
    } else {
      await service.deleteReviewSettings(compensation.createdId)
    }

    await cache.invalidate(REVIEW_SETTINGS_CACHE_KEY)
  }
)
