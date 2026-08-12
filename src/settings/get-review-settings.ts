import { MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../modules/review'
import {
  mergeSettings,
  ReviewSettingsValues,
} from '../modules/review/settings-defaults'

export const REVIEW_SETTINGS_CACHE_KEY = 'review:settings'

/**
 * Settings are read through the Cache Module rather than a per-process
 * variable. A process-local cache lets two instances disagree about
 * require_approval, which would auto-publish reviews on one node while
 * holding them pending on another.
 */
export async function getReviewSettings(
  container: MedusaContainer
): Promise<ReviewSettingsValues> {
  const cache = container.resolve(Modules.CACHE)

  const cached = await cache.get<ReviewSettingsValues>(REVIEW_SETTINGS_CACHE_KEY)
  if (cached) {
    return cached
  }

  const service = container.resolve(REVIEW_MODULE)
  const [row] = await service.listReviewSettings({}, { take: 1 })
  const settings = mergeSettings(row)

  await cache.set(REVIEW_SETTINGS_CACHE_KEY, settings, 300)

  return settings
}

export async function invalidateReviewSettings(
  container: MedusaContainer
): Promise<void> {
  const cache = container.resolve(Modules.CACHE)
  await cache.invalidate(REVIEW_SETTINGS_CACHE_KEY)
}
