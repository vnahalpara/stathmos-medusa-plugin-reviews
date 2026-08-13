import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createAdminUser, adminHeaders } from '../helpers/admin'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await createAdminUser(getContainer())
    })

    describe('GET /admin/reviews/settings', () => {
      it('returns defaults before anything is saved', async () => {
        const response = await api.get('/admin/reviews/settings', adminHeaders)

        expect(response.status).toEqual(200)
        expect(response.data.settings.require_approval).toBe(true)
      })
    })

    describe('POST /admin/reviews/settings', () => {
      it('persists a change and serves it on the next read', async () => {
        await api.post('/admin/reviews/settings', { require_approval: false }, adminHeaders)

        const response = await api.get('/admin/reviews/settings', adminHeaders)

        expect(response.data.settings.require_approval).toBe(false)
      })

      it('rejects an unknown setting', async () => {
        const response = await api
          .post('/admin/reviews/settings', { nonsense: true }, adminHeaders)
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })
    })
  },
})
