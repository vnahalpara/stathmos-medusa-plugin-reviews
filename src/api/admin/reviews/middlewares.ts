import {
  MiddlewareRoute,
  validateAndTransformBody,
  validateAndTransformQuery,
} from '@medusajs/framework'
import { z } from '@medusajs/framework/zod'

export const UpdateReviewSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    require_approval: z.boolean().optional(),
    allow_guest: z.boolean().optional(),
    verified_only: z.boolean().optional(),
    allow_media: z.boolean().optional(),
    allow_video: z.boolean().optional(),
    max_media_per_review: z.number().int().min(0).max(20).optional(),
    max_image_size_mb: z.number().int().min(1).max(50).optional(),
    // Ceiling matches the multer `fileSize` limit on the store upload route
    // (src/api/store/reviews/middlewares.ts) - it must not exceed that
    // transport-layer bound, or a merchant could configure a cap multer
    // would silently never let a file reach.
    max_video_size_mb: z.number().int().min(1).max(100).optional(),
    allow_edit: z.boolean().optional(),
    one_review_per_customer: z.boolean().optional(),
    min_content_length: z.number().int().min(0).max(1000).optional(),
    max_content_length: z.number().int().min(1).max(20000).optional(),
    gallery_enabled: z.boolean().optional(),
  })
  .strict()

export type UpdateReviewSettingsSchema = z.infer<typeof UpdateReviewSettingsSchema>

export const RejectReviewSchema = z
  .object({ rejection_reason: z.string().max(500).optional() })
  .strict()

export type RejectReviewSchema = z.infer<typeof RejectReviewSchema>

export const BatchStatusSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(100),
    status: z.enum(['approved', 'rejected', 'pending']),
    rejection_reason: z.string().max(500).optional(),
  })
  .strict()

export type BatchStatusSchema = z.infer<typeof BatchStatusSchema>

const toInt = (val: unknown) => (typeof val === 'string' ? parseInt(val, 10) : val)

export const ListAdminReviewsSchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    product_id: z.string().optional(),
    rating: z.preprocess(toInt, z.number().int().min(1).max(5).optional()),
    limit: z.preprocess(toInt, z.number().int().min(1).max(100).optional()),
    offset: z.preprocess(toInt, z.number().int().min(0).optional()),
  })
  .strict()

export type ListAdminReviewsSchema = z.infer<typeof ListAdminReviewsSchema>

export const adminReviewMiddlewares: MiddlewareRoute[] = [
  {
    matcher: '/admin/reviews/settings',
    method: 'POST',
    middlewares: [validateAndTransformBody(UpdateReviewSettingsSchema)],
  },
  {
    matcher: '/admin/reviews',
    method: 'GET',
    middlewares: [validateAndTransformQuery(ListAdminReviewsSchema, {})],
  },
  {
    matcher: '/admin/reviews/:id/reject',
    method: 'POST',
    middlewares: [validateAndTransformBody(RejectReviewSchema)],
  },
  {
    matcher: '/admin/reviews/batch/status',
    method: 'POST',
    middlewares: [validateAndTransformBody(BatchStatusSchema)],
  },
]
