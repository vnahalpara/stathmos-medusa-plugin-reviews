import { MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import {
  createCustomersWorkflow,
  createSalesChannelsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
} from '@medusajs/medusa/core-flows'
import jwt from 'jsonwebtoken'

// Every /store/* request is rejected with 400 before it reaches a route
// handler unless it carries a valid publishable API key
// (x-publishable-api-key). Mint one against the real api-key module so
// store HTTP tests exercise the same gate a real client would hit.
export async function getPublishableKeyHeaders(
  container: MedusaContainer
): Promise<{ 'x-publishable-api-key': string }> {
  const apiKeyModule = container.resolve(Modules.API_KEY)
  const [key] = await apiKeyModule.createApiKeys([
    { title: 'store-submit test', type: 'publishable', created_by: '' },
  ])

  return { 'x-publishable-api-key': key.token }
}

// Core `/store/products*` routes (unlike this plugin's own store routes)
// only return a product if the requesting publishable API key is scoped to
// a sales channel the product is assigned to - so exercising those core
// routes needs a key linked to a sales channel, not just any publishable
// key. Returns the sales channel id too, so the caller can assign a product
// to it via createProductsWorkflow's `sales_channels` input.
export async function getPublishableKeyHeadersForSalesChannel(
  container: MedusaContainer
): Promise<{ headers: { 'x-publishable-api-key': string }; salesChannelId: string }> {
  const apiKeyModule = container.resolve(Modules.API_KEY)
  const [key] = await apiKeyModule.createApiKeys([
    { title: 'store-product-listing test', type: 'publishable', created_by: '' },
  ])

  const { result: salesChannels } = await createSalesChannelsWorkflow(container).run({
    input: { salesChannelsData: [{ name: 'Test channel' }] },
  })
  const salesChannel = salesChannels[0]

  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: key.id, add: [salesChannel.id] },
  })

  return {
    headers: { 'x-publishable-api-key': key.token },
    salesChannelId: salesChannel.id,
  }
}

// Mirrors helpers/admin.ts's approach of signing a JWT directly against the
// test jwtSecret (medusa-config.ts falls back to 'test') rather than
// exercising the full customer login flow. authenticate()'s bearer path
// only verifies the token's signature and actor_type - it does not look the
// auth identity up in the DB - so a real customer record is created purely
// so the attributed customer_id corresponds to something real, not because
// authenticate() requires it.
export async function createCustomerAuthHeaders(
  container: MedusaContainer,
  email: string
): Promise<{ customer: { id: string }; headers: { authorization: string } }> {
  const { result } = await createCustomersWorkflow(container).run({
    input: { customersData: [{ email }] },
  })
  const customer = result[0]

  const token = jwt.sign(
    {
      actor_id: customer.id,
      actor_type: 'customer',
      auth_identity_id: 'test',
      app_metadata: {},
    },
    process.env.JWT_SECRET || 'test',
    { expiresIn: '1d' }
  )

  return { customer: { id: customer.id }, headers: { authorization: `Bearer ${token}` } }
}
