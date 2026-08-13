import { model } from '@medusajs/framework/utils'

export const ReviewSettings = model.define('review_settings', {
  id: model.id({ prefix: 'rset' }).primaryKey(),
  enabled: model.boolean().default(true),
  require_approval: model.boolean().default(true),
  allow_guest: model.boolean().default(false),
  verified_only: model.boolean().default(false),
  allow_media: model.boolean().default(true),
  allow_video: model.boolean().default(true),
  max_media_per_review: model.number().default(5),
  max_image_size_mb: model.number().default(5),
  max_video_size_mb: model.number().default(50),
  allow_edit: model.boolean().default(false),
  one_review_per_customer: model.boolean().default(true),
  min_content_length: model.number().default(10),
  max_content_length: model.number().default(5000),
  gallery_enabled: model.boolean().default(true),
})
