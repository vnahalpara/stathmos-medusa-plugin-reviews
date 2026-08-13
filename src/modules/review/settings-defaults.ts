export type ReviewSettingsValues = {
  enabled: boolean
  require_approval: boolean
  allow_guest: boolean
  verified_only: boolean
  allow_media: boolean
  allow_video: boolean
  max_media_per_review: number
  max_image_size_mb: number
  max_video_size_mb: number
  allow_edit: boolean
  one_review_per_customer: boolean
  min_content_length: number
  max_content_length: number
  gallery_enabled: boolean
}

export const REVIEW_SETTINGS_ID = 'review_settings'

export const REVIEW_SETTINGS_DEFAULTS: ReviewSettingsValues = {
  enabled: true,
  require_approval: true,
  allow_guest: false,
  verified_only: false,
  allow_media: true,
  allow_video: true,
  max_media_per_review: 5,
  max_image_size_mb: 5,
  max_video_size_mb: 50,
  // Phase 4 ships the edit flow; the toggle must not be live before then.
  allow_edit: false,
  one_review_per_customer: true,
  min_content_length: 10,
  max_content_length: 5000,
  gallery_enabled: true,
}

export function mergeSettings(
  row: Partial<ReviewSettingsValues> | undefined | null
): ReviewSettingsValues {
  if (!row) {
    return { ...REVIEW_SETTINGS_DEFAULTS }
  }

  const merged = { ...REVIEW_SETTINGS_DEFAULTS }

  for (const key of Object.keys(REVIEW_SETTINGS_DEFAULTS) as (keyof ReviewSettingsValues)[]) {
    const value = row[key]
    if (value !== undefined && value !== null) {
      ;(merged as Record<string, unknown>)[key] = value
    }
  }

  return merged
}
