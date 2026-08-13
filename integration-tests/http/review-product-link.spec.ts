import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createProductsWorkflow } from '@medusajs/medusa/core-flows'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { getPublishableKeyHeadersForSalesChannel } from '../helpers/store'

// There is no `review`<->`product` module link in this plugin (see
// src/links/README.md - none is defined here). It was removed after a
// security review found that Medusa's core store product routes forward
// the `fields` query parameter straight into `query.graph` with no
// knowledge of this plugin's field allow-list or its `status: 'approved'`
// filter, so *any* module link from `review` to `product` makes every
// linked review row - including a guest's raw email, a pending/rejected
// review's content, and its moderation status - traversable with nothing
// but a publishable API key:
//
//   GET /store/products?fields=*reviews
//   GET /store/products/:id?fields=+reviews.*
//
// This spec is a regression test for that HTTP-level leak, not an
// in-process query.graph check (the previous version of this file called
// query.graph directly, which is exactly why it never caught the leak - it
// never went through Express/the store middleware the way a real HTTP
// client does). The review here is created through createReviewWorkflow -
// the one and only code path that ever wrote review<->product link rows
// (via createRemoteLinkStep) - so if a link is reintroduced and wired back
// into that workflow, this review becomes a real linked row and these
// assertions will fail. Only a publishable API key is used, matching the
// original finding.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    let storeHeaders: Record<string, string>
    let productId: string

    beforeAll(async () => {
      const container = getContainer()

      await updateReviewSettingsWorkflow(container).run({ input: { allow_guest: true } })

      const { headers, salesChannelId } = await getPublishableKeyHeadersForSalesChannel(
        container
      )
      storeHeaders = headers

      const { result: products } = await createProductsWorkflow(container).run({
        input: {
          products: [
            {
              title: 'Product With A Leaky Review',
              status: 'published',
              // Medusa 2.18's create-products workflow validates that every
              // product has at least one option, regardless of variants.
              options: [{ title: 'Default', values: ['Default'] }],
              sales_channels: [{ id: salesChannelId }],
            },
          ],
        },
      })
      productId = products[0].id

      // A guest submission defaults to status: 'pending' (require_approval
      // is on by default) and carries a raw email - exactly the payload the
      // finding says was reachable. Going through the real workflow (not a
      // direct service write) is what makes this a genuine regression test
      // for the link: this is the only path that ever created link rows.
      await createReviewWorkflow(container).run({
        input: {
          product_id: productId,
          rating: 1,
          content: 'Unmoderated content that must never reach the storefront.',
          display_name: 'Leaky Larry',
          email: 'leaky-larry@example.com',
        },
      })
    })

    function assertNoReviewLeak(reviews: unknown) {
      // The core route may omit the relation entirely, or return `null`/an
      // empty list for it - all of those are fine. What must never happen
      // is a populated array containing review fields.
      if (reviews == null) {
        return
      }

      expect(Array.isArray(reviews)).toBe(true)
      const list = reviews as Array<Record<string, unknown>>
      for (const review of list) {
        expect(review.email).toBeUndefined()
        expect(review.customer_id).toBeUndefined()
        expect(review.content).toBeUndefined()
        expect(review.rejection_reason).toBeUndefined()
        expect(review.status).toBeUndefined()
      }
    }

    it('GET /store/products?fields=*reviews does not expose review data', async () => {
      const response = await api.get('/store/products?fields=*reviews', {
        headers: storeHeaders,
      })

      expect(response.status).toEqual(200)
      const product = response.data.products.find(
        (p: { id: string }) => p.id === productId
      )
      expect(product).toBeDefined()
      assertNoReviewLeak(product.reviews)
    })

    it('GET /store/products/:id?fields=+reviews.* does not expose review data', async () => {
      const response = await api.get(`/store/products/${productId}?fields=+reviews.*`, {
        headers: storeHeaders,
      })

      expect(response.status).toEqual(200)
      assertNoReviewLeak(response.data.product.reviews)
    })
  },
})
