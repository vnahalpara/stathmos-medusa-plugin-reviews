import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('test harness', () => {
      it('boots a Medusa app with the plugin module registered', async () => {
        expect(getContainer().resolve(REVIEW_MODULE)).toBeDefined()
      })
    })
  },
})
