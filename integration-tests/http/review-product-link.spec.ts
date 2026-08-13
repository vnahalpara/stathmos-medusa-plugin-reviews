import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { createProductsWorkflow } from '@medusajs/medusa/core-flows'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    it('joins reviews onto their product', async () => {
      const container = getContainer()

      await updateReviewSettingsWorkflow(container).run({ input: { allow_guest: true } })

      const { result: products } = await createProductsWorkflow(container).run({
        input: {
          products: [
            {
              title: 'Linked Product',
              status: 'published',
              // Medusa 2.18's create-products workflow validates that every
              // product has at least one option, regardless of variants -
              // the brief's snippet omits this and fails at runtime with
              // "Product options are not provided for: [...]".
              options: [{ title: 'Default', values: ['Default'] }],
            },
          ],
        },
      })

      await createReviewWorkflow(container).run({
        input: {
          product_id: products[0].id,
          rating: 5,
          content: 'x'.repeat(10),
          display_name: 'Ada',
        },
      })

      const query = container.resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({
        entity: 'product',
        fields: ['id', 'title', 'reviews.*'],
        filters: { id: products[0].id },
      })

      expect(data[0].reviews).toHaveLength(1)
    })
  },
})
