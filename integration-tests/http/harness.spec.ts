import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { ApiKeyType, Modules } from '@medusajs/framework/utils'
import { IApiKeyModuleService } from '@medusajs/framework/types'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('test harness', () => {
      let publishableApiKey: string

      // Every /store route requires a valid publishable API key
      // (see ensurePublishableApiKeyMiddleware in @medusajs/framework), so
      // the harness has to mint one before it can prove the plugin's store
      // route is reachable.
      beforeAll(async () => {
        const apiKeyModuleService: IApiKeyModuleService = getContainer().resolve(
          Modules.API_KEY,
        )
        const apiKey = await apiKeyModuleService.createApiKeys({
          title: 'test harness',
          type: ApiKeyType.PUBLISHABLE,
          created_by: '',
        })
        publishableApiKey = apiKey.token
      })

      it('boots a Medusa app with the plugin source loaded', async () => {
        const response = await api.get('/store/plugin', {
          headers: { 'x-publishable-api-key': publishableApiKey },
        })

        expect(response.status).toEqual(200)
      })
    })
  },
})
