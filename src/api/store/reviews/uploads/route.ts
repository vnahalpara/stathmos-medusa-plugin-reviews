import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { MedusaError } from '@medusajs/framework/utils'
import { uploadReviewMediaWorkflow } from '../../../../workflows/upload-review-media'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const files = (req as MedusaRequest & { files?: Express.Multer.File[] }).files

  if (!files?.length) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'No files were uploaded')
  }

  const { result } = await uploadReviewMediaWorkflow(req.scope).run({
    input: {
      files: files.map((file) => ({
        filename: file.originalname,
        content: file.buffer.toString('base64'),
        size_bytes: file.size,
      })),
    },
  })

  // Explicit allow-list: file_id and size_bytes are internal, and an
  // allow-list cannot leak a column added in a later phase.
  res.status(201).json({
    media: result.media.map((m) => ({
      id: m.id,
      type: m.type,
      url: m.url,
      thumbnail_url: m.thumbnail_url,
      mime_type: m.mime_type,
    })),
  })
}
