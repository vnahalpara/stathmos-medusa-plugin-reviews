import { hasVerifiedPurchase } from '../check-verified-purchase'

describe('hasVerifiedPurchase', () => {
  it('is true when a completed order contains the product', () => {
    const orders = [{ status: 'completed', items: [{ product_id: 'prod_1' }] }]

    expect(hasVerifiedPurchase(orders as never, 'prod_1')).toBe(true)
  })

  it('is false when the order is not completed', () => {
    const orders = [{ status: 'pending', items: [{ product_id: 'prod_1' }] }]

    expect(hasVerifiedPurchase(orders as never, 'prod_1')).toBe(false)
  })

  it('is false when no order contains the product', () => {
    const orders = [{ status: 'completed', items: [{ product_id: 'prod_2' }] }]

    expect(hasVerifiedPurchase(orders as never, 'prod_1')).toBe(false)
  })

  it('is false with no orders at all', () => {
    expect(hasVerifiedPurchase([], 'prod_1')).toBe(false)
  })
})
