import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'

type OrderLike = { status: string; items?: { product_id: string }[] }

type Input = { customer_id?: string | null; product_id: string }

export function hasVerifiedPurchase(orders: OrderLike[], productId: string): boolean {
  return orders.some(
    (order) =>
      order.status === 'completed' &&
      (order.items ?? []).some((item) => item.product_id === productId)
  )
}

/**
 * Verified status requires an authenticated customer. Matching a guest on a
 * self-supplied email would let anyone who knows a buyer's address mint a
 * verified badge, which is the one claim on a review page that has to be
 * trustworthy.
 */
export const checkVerifiedPurchaseStep = createStep(
  'check-verified-purchase',
  async (input: Input, { container }) => {
    if (!input.customer_id) {
      return new StepResponse(false)
    }

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const { data: orders } = await query.graph({
      entity: 'order',
      fields: ['id', 'status', 'items.product_id'],
      filters: { customer_id: input.customer_id },
    })

    return new StepResponse(hasVerifiedPurchase(orders as OrderLike[], input.product_id))
  }
)
