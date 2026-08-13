import { REVIEW_SETTINGS_DEFAULTS, mergeSettings } from '../../modules/review/settings-defaults'

describe('mergeSettings', () => {
  it('returns defaults when no row exists', () => {
    expect(mergeSettings(undefined)).toEqual(REVIEW_SETTINGS_DEFAULTS)
  })

  it('lets a stored value override a default without dropping the others', () => {
    const merged = mergeSettings({ require_approval: false } as never)

    expect(merged.require_approval).toBe(false)
    expect(merged.max_media_per_review).toBe(REVIEW_SETTINGS_DEFAULTS.max_media_per_review)
  })

  it('defaults allow_edit to false because the edit flow ships in Phase 4', () => {
    expect(REVIEW_SETTINGS_DEFAULTS.allow_edit).toBe(false)
  })
})
