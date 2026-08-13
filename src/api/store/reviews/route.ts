import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { createReviewWorkflow } from '../../../workflows/create-review'
import { CreateReviewSchema } from './middlewares'

export async function POST(
  req: AuthenticatedMedusaRequest<CreateReviewSchema>,
  res: MedusaResponse
) {
  const customerId = req.auth_context?.actor_id ?? null

  const { result } = await createReviewWorkflow(req.scope).run({
    input: { ...req.validatedBody, customer_id: customerId },
  })

  // Field-by-field response, not the model: a guest's email must never
  // reach a store response, and an explicit allow-list cannot leak a
  // column added in a later phase.
  res.status(201).json({
    review: {
      id: result.id,
      product_id: result.product_id,
      rating: result.rating,
      title: result.title,
      content: result.content,
      display_name: result.display_name,
      status: result.status,
      is_verified_purchase: result.is_verified_purchase,
      helpful_count: result.helpful_count,
      created_at: result.created_at,
    },
  })
}
