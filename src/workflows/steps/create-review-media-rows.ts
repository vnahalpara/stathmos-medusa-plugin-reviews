import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { REVIEW_MODULE } from '../../modules/review'
import { PreparedFile } from './upload-review-media-files'

type UploadedFile = { id: string; url: string }

type Input = { files: UploadedFile[]; prepared: PreparedFile[] }

/**
 * Split from uploadReviewMediaFilesStep so the saga engine compensates
 * correctly on a partial failure: this step only ever deletes the rows it
 * itself created. If it fails, it never returned a StepResponse, so the
 * engine still runs the upload step's own compensation (deleting the
 * files) - see upload-review-media-files.ts for why that split matters.
 */
export const createReviewMediaRowsStep = createStep(
  'create-review-media-rows',
  async (input: Input, { container }) => {
    const service = container.resolve(REVIEW_MODULE)

    const media = await service.createReviewMedias(
      input.files.map((file, i) => ({
        review_id: null,
        type: input.prepared[i].type,
        file_id: file.id,
        url: file.url,
        mime_type: input.prepared[i].mime,
        size_bytes: input.prepared[i].size_bytes,
        sort_order: i,
      }))
    )

    const rows = Array.isArray(media) ? media : [media]

    return new StepResponse({ media: rows }, rows.map((m) => m.id))
  },
  async (mediaIds, { container }) => {
    if (!mediaIds) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.deleteReviewMedias(mediaIds)
  }
)
