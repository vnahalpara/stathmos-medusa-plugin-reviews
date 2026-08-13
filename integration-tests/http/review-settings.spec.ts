import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { getReviewSettings, invalidateReviewSettings } from '../../src/settings/get-review-settings'
import { REVIEW_SETTINGS_DEFAULTS } from '../../src/modules/review/settings-defaults'
import { REVIEW_MODULE } from '../../src/modules/review'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('review settings', () => {
      it('returns defaults when no settings row exists', async () => {
        const settings = await getReviewSettings(getContainer())

        expect(settings).toEqual(REVIEW_SETTINGS_DEFAULTS)
      })

      it('reflects a stored row after the cache is invalidated', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await service.createReviewSettings({ require_approval: false })
        await invalidateReviewSettings(container)

        const settings = await getReviewSettings(container)

        expect(settings.require_approval).toBe(false)
      })
    })
  },
})
