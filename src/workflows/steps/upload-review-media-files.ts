import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { deleteFilesWorkflow, uploadFilesWorkflow } from '@medusajs/medusa/core-flows'
import { getReviewSettings } from '../../settings/get-review-settings'
import { mediaTypeFor, sniffMime } from '../../media/sniff-mime'
import { stripExif } from '../../media/strip-exif'

type InputFile = { filename: string; content: string; size_bytes: number }

type Input = { files: InputFile[] }

export type PreparedFile = {
  filename: string
  mime: string
  type: 'image' | 'video'
  size_bytes: number
}

// Named so a shopper uploading a live-Photo/.heic photo or a .mov clip
// straight off an iPhone - both of which this plugin rejects - gets told
// what to send instead, rather than a dead-end "unsupported file type".
const ACCEPTED_FORMATS = 'JPEG, PNG, WebP, AVIF, MP4, WebM'

/**
 * Uploads and validates files only. Kept as its own step (rather than one
 * step that also creates the review_media rows) so the saga engine can
 * compensate correctly on a partial failure: if row creation fails after
 * this step has already committed the upload, the engine only invokes
 * compensation for steps that returned a StepResponse — a single combined
 * step would let a row-creation failure leave an uploaded file with zero
 * rows ever having existed to reference it, which even the Task 9 orphan
 * sweep cannot find (it only looks at unattached rows).
 */
export const uploadReviewMediaFilesStep = createStep(
  'upload-review-media-files',
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

        // Gated on the decoded buffer's own length, never on
        // file.size_bytes: that field comes straight from the request body
        // and is entirely client-controlled. A caller can declare
        // size_bytes: 1 while sending an arbitrarily large payload, so only
        // the actual byte count of the decoded content can be trusted for
        // this check. size_bytes stays on the input type because later
        // tasks' briefs reference this input shape, but it must never
        // again be used to make a decision.
        if (raw.length > limitMb * 1024 * 1024) {
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

    const preparedMeta: PreparedFile[] = prepared.map((f) => ({
      filename: f.filename,
      mime: f.mime,
      type: f.type,
      size_bytes: f.size_bytes,
    }))

    return new StepResponse(
      { files, prepared: preparedMeta },
      { fileIds: files.map((f) => f.id) }
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }

    await deleteFilesWorkflow(container).run({
      input: { ids: compensation.fileIds },
    })
  }
)
