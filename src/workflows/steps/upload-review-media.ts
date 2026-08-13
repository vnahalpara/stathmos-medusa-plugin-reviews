import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { deleteFilesWorkflow, uploadFilesWorkflow } from '@medusajs/medusa/core-flows'
import { REVIEW_MODULE } from '../../modules/review'
import { getReviewSettings } from '../../settings/get-review-settings'
import { mediaTypeFor, sniffMime } from '../../media/sniff-mime'
import { stripExif } from '../../media/strip-exif'

type InputFile = { filename: string; content: string; size_bytes: number }

type Input = { files: InputFile[] }

// Named so a shopper uploading a live-Photo/.heic photo or a .mov clip
// straight off an iPhone - both of which this plugin rejects - gets told
// what to send instead, rather than a dead-end "unsupported file type".
const ACCEPTED_FORMATS = 'JPEG, PNG, WebP, AVIF, MP4, WebM'

export const uploadReviewMediaStep = createStep(
  'upload-review-media',
  async (input: Input, { container }) => {
    const settings = await getReviewSettings(container)

    if (!settings.enabled || !settings.allow_media) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Media uploads are disabled'
      )
    }

    if (input.files.length > settings.max_media_per_review) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `At most ${settings.max_media_per_review} files may be uploaded`
      )
    }

    const prepared = await Promise.all(
      input.files.map(async (file) => {
        const raw = Buffer.from(file.content, 'base64')

        // Sniffed from the bytes — the filename and any client-declared
        // content type are untrusted.
        const mime = sniffMime(raw)
        const type = mime ? mediaTypeFor(mime) : null

        if (!mime || !type) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `Unsupported file type for ${file.filename}. Accepted formats: ${ACCEPTED_FORMATS}`
          )
        }

        if (type === 'video' && !settings.allow_video) {
          throw new MedusaError(
            MedusaError.Types.NOT_ALLOWED,
            'Video uploads are disabled'
          )
        }

        const limitMb =
          type === 'image' ? settings.max_image_size_mb : settings.max_video_size_mb

        if (file.size_bytes > limitMb * 1024 * 1024) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `${file.filename} exceeds the ${limitMb}MB limit`
          )
        }

        const content = await stripExif(raw, mime)

        return { filename: file.filename, mime, type, content, size_bytes: content.length }
      })
    )

    const { result: files } = await uploadFilesWorkflow(container).run({
      input: {
        files: prepared.map((f) => ({
          filename: f.filename,
          mimeType: f.mime,
          content: f.content.toString('base64'),
          access: 'public' as const,
        })),
      },
    })

    const service = container.resolve(REVIEW_MODULE)

    const media = await service.createReviewMedias(
      files.map((file, i) => ({
        review_id: null,
        type: prepared[i].type,
        file_id: file.id,
        url: file.url,
        mime_type: prepared[i].mime,
        size_bytes: prepared[i].size_bytes,
        sort_order: i,
      }))
    )

    const rows = Array.isArray(media) ? media : [media]

    return new StepResponse(
      { media: rows },
      { mediaIds: rows.map((m) => m.id), fileIds: files.map((f) => f.id) }
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.deleteReviewMedias(compensation.mediaIds)

    // The rows are gone, but without this the uploaded bytes stay in object
    // storage with nothing pointing at them: the Task 9 orphan sweep only
    // ever looks at unattached *rows*, so a row-less file can never be
    // reclaimed and leaks forever. Deleting through deleteFilesWorkflow (not
    // a raw file-service call) keeps this consistent with how every other
    // file deletion in the app happens.
    await deleteFilesWorkflow(container).run({
      input: { ids: compensation.fileIds },
    })
  }
)
