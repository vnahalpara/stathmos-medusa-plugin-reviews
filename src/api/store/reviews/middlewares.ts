import { authenticate, MiddlewareRoute, validateAndTransformBody } from '@medusajs/framework'
import { z } from '@medusajs/framework/zod'

export const CreateReviewSchema = z
  .object({
    product_id: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    title: z.string().max(200).optional(),
    content: z.string().min(1).max(20000),
    display_name: z.string().min(1).max(100).optional(),
    email: z.string().email().optional(),
  })
  .strict()

export type CreateReviewSchema = z.infer<typeof CreateReviewSchema>

export const storeReviewMiddlewares: MiddlewareRoute[] = [
  {
    matcher: '/store/reviews',
    method: 'POST',
    middlewares: [
      // allowUnauthenticated lets guests through to the workflow, which
      // decides whether guest submissions are allowed at all. When a
      // customer session/bearer token IS present this still populates
      // req.auth_context, which is what lets the route attribute the
      // review to a customer_id and lets the workflow apply verified-
      // purchase and one-review-per-customer rules. Must run before body
      // validation so identity is known by the time the route executes.
      authenticate('customer', ['session', 'bearer'], { allowUnauthenticated: true }),
      validateAndTransformBody(CreateReviewSchema),
    ],
  },
]
