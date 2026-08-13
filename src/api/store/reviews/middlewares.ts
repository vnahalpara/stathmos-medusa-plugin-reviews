import {
  authenticate,
  MiddlewareRoute,
  validateAndTransformBody,
  validateAndTransformQuery,
} from '@medusajs/framework'
import { z } from '@medusajs/framework/zod'
import multer from 'multer'

// Files are held in memory only long enough to sniff and re-encode them;
// the File Module owns persistence.
//
// `limits` is a hard transport-layer ceiling, deliberately separate from
// the merchant-configurable settings the workflow enforces: multer refuses
// oversized/over-count uploads before a single byte is buffered in memory,
// the settings then refine further within that ceiling. Rate limiting
// (Phase 6) bounds request frequency; this bounds a single request's body
// size, which is a different attack surface and not covered by that
// deferral. fileSize (100MB) sits comfortably above the 50MB default
// max_video_size_mb and matches UpdateReviewSettingsSchema's own max for
// that field (see src/api/admin/reviews/middlewares.ts) - the two must
// agree or a merchant could configure a cap multer would silently never
// let a file reach. files (20) matches max_media_per_review's schema max
// for the same reason.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 20 },
})

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
  {
    matcher: '/store/reviews/uploads',
    method: 'POST',
    middlewares: [upload.array('files')],
  },
]
