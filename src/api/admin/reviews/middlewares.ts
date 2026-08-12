import { MiddlewareRoute, validateAndTransformBody } from '@medusajs/framework'
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
    max_video_size_mb: z.number().int().min(1).max(500).optional(),
    allow_edit: z.boolean().optional(),
    one_review_per_customer: z.boolean().optional(),
    min_content_length: z.number().int().min(0).max(1000).optional(),
    max_content_length: z.number().int().min(1).max(20000).optional(),
    gallery_enabled: z.boolean().optional(),
  })
  .strict()

export type UpdateReviewSettingsSchema = z.infer<typeof UpdateReviewSettingsSchema>

export const adminReviewMiddlewares: MiddlewareRoute[] = [
  {
    matcher: '/admin/reviews/settings',
    method: 'POST',
    middlewares: [validateAndTransformBody(UpdateReviewSettingsSchema)],
  },
]
