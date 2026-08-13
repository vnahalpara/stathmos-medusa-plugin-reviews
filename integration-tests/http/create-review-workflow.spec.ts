import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import { MedusaContainer } from '@medusajs/framework/types'
import { REVIEW_MODULE } from '../../src/modules/review'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { invalidateReviewSettings } from '../../src/settings/get-review-settings'
import {
  REVIEW_SETTINGS_DEFAULTS,
  ReviewSettingsValues,
} from '../../src/modules/review/settings-defaults'

// `expect(promise).rejects.toThrow()` is documented elsewhere in this suite
// (see update-review-settings-compensation.spec.ts) as unreliable for some
// workflow rejection shapes in this test runner. Using the same try/catch
// approach here for consistency and reliability.
async function runAndExpectRejection(promise: Promise<unknown>, messageIncludes: string) {
  let threw = false
  try {
    await promise
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain(messageIncludes)
  }
  expect(threw).toBe(true)
}

// Every test that cares about settings starts from a known baseline: without
// this, a settings row created by an earlier test in this file (there is no
// DB reset between individual `it`s, only between spec files) would leak
// into later tests and make them order-dependent.
async function resetReviewSettings(
  container: MedusaContainer,
  overrides: Partial<ReviewSettingsValues> = {}
) {
  const service = container.resolve(REVIEW_MODULE)
  const [existing] = await service.listReviewSettings({}, { take: 1 })
  const values = { ...REVIEW_SETTINGS_DEFAULTS, ...overrides }

  if (existing) {
    await service.updateReviewSettings({ id: existing.id, ...values })
  } else {
    await service.createReviewSettings(values)
  }

  await invalidateReviewSettings(container)
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('createReviewWorkflow', () => {
      beforeEach(async () => {
        await resetReviewSettings(getContainer())
      })

      it('rejects a guest submission when guests are not allowed (default settings)', async () => {
        const container = getContainer()

        await runAndExpectRejection(
          createReviewWorkflow(container).run({
            input: {
              product_id: 'prod_guest_blocked',
              rating: 5,
              content: 'A perfectly fine review that is long enough.',
              display_name: 'Guest',
            },
          }),
          'You must be signed in to leave a review'
        )
      })

      it('creates a pending, unverified review for a signed-in customer with no matching orders', async () => {
        const container = getContainer()

        const { result } = await createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_pending',
            customer_id: 'cus_no_orders',
            rating: 4,
            content: 'Solid product, does what it says on the tin.',
            display_name: 'Jane',
          },
        })

        expect(result).toMatchObject({
          status: 'pending',
          is_verified_purchase: false,
          product_id: 'prod_pending',
        })

        const service = container.resolve(REVIEW_MODULE)
        const [stored] = await service.listReviews({ id: result.id })
        expect(stored.status).toBe('pending')
      })

      it('auto-approves and the product stats reflect it immediately when require_approval is disabled', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await resetReviewSettings(container, { require_approval: false })

        const { result } = await createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_auto_approve',
            customer_id: 'cus_auto',
            rating: 5,
            content: 'Immediately public, no moderation needed here.',
            display_name: 'Sam',
          },
        })

        expect(result.status).toBe('approved')

        const [stats] = await service.listReviewStats({ product_id: 'prod_auto_approve' })
        expect(stats).toMatchObject({ count: 1, average: 5 })
      })

      it('computes verified purchase from the customer\'s own completed order, never from a submitted email', async () => {
        const container = getContainer()
        const orderService = container.resolve(Modules.ORDER)

        await resetReviewSettings(container, { allow_guest: true })

        // Real purchase, on the real order module - not a stub.
        await orderService.createOrders({
          customer_id: 'cus_buyer',
          currency_code: 'usd',
          status: 'completed',
          items: [
            {
              title: 'Verified product',
              quantity: 1,
              unit_price: 1000,
              product_id: 'prod_verified',
            },
          ],
        } as never)

        const buyerReview = await createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_verified',
            customer_id: 'cus_buyer',
            rating: 5,
            content: 'Bought it myself and it is genuinely great.',
            display_name: 'Buyer',
          },
        })
        expect(buyerReview.result.is_verified_purchase).toBe(true)

        // A guest who types the buyer's email must NOT inherit the badge:
        // the predicate must come from an authenticated customer_id only.
        const guestReview = await createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_verified',
            rating: 1,
            content: 'I never bought this, just guessing the email.',
            display_name: 'Impersonator',
            email: 'buyer@example.com',
          },
        })
        expect(guestReview.result.is_verified_purchase).toBe(false)
      })

      it('rejects a guest even when guests are allowed once the store is verified-only', async () => {
        const container = getContainer()

        await resetReviewSettings(container, { allow_guest: true, verified_only: true })

        await runAndExpectRejection(
          createReviewWorkflow(container).run({
            input: {
              product_id: 'prod_verified_only',
              rating: 5,
              content: 'A guest trying to review a verified-only product.',
              display_name: 'Guest',
            },
          }),
          'Only customers who purchased this product can review it'
        )
      })

      it('enforces one review per customer per product', async () => {
        const container = getContainer()

        const input = {
          product_id: 'prod_one_review',
          customer_id: 'cus_repeat',
          rating: 3,
          content: 'My first review of this product, fair and honest.',
          display_name: 'Repeat',
        }

        await createReviewWorkflow(container).run({ input })

        await runAndExpectRejection(
          createReviewWorkflow(container).run({
            input: { ...input, content: 'Trying to review the same product twice.' },
          }),
          'You have already reviewed this product'
        )
      })

      it('rejects content shorter than the configured minimum', async () => {
        const container = getContainer()

        await runAndExpectRejection(
          createReviewWorkflow(container).run({
            input: {
              product_id: 'prod_too_short',
              customer_id: 'cus_short',
              rating: 5,
              content: 'short',
              display_name: 'Terse',
            },
          }),
          'Review must be at least'
        )
      })
    })
  },
})
