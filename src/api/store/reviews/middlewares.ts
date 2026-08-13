import {
  authenticate,
  MiddlewareRoute,
  validateAndTransformBody,
  validateAndTransformQuery,
} from '@medusajs/framework'
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

const toInt = (val: unknown) =>
  typeof val === 'string' ? parseInt(val, 10) : val

export const ListProductReviewsSchema = z
  .object({
    // An uncapped limit on a public endpoint is a free denial of service.
    limit: z.preprocess(toInt, z.number().int().min(1).max(100).optional()),
    offset: z.preprocess(toInt, z.number().int().min(0).optional()),
    sort: z.enum(['newest', 'highest', 'lowest', 'most_helpful']).optional(),
    rating: z.preprocess(toInt, z.number().int().min(1).max(5).optional()),
    verified: z.preprocess((v) => v === 'true', z.boolean().optional()),
  })
  .strict()

export type ListProductReviewsSchema = z.infer<typeof ListProductReviewsSchema>

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
  {
    matcher: '/store/products/:id/reviews',
    method: 'GET',
    middlewares: [validateAndTransformQuery(ListProductReviewsSchema, {})],
  },
]
