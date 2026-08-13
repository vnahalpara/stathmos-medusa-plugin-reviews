import { randomUUID } from 'node:crypto'
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { deleteFilesWorkflow, uploadFilesWorkflow } from '@medusajs/medusa/core-flows'
import { getReviewSettings } from '../../settings/get-review-settings'
import { mediaTypeFor, sniffMime } from '../../media/sniff-mime'
import { MediaDecodeError, stripExif } from '../../media/strip-exif'

type InputFile = { filename: string; content: string; size_bytes: number }

type Input = { files: InputFile[] }

export type PreparedFile = {
  // The SERVER-generated name the file is stored under. Deliberately not
  // named `filename`: the client-supplied name is untrusted display text
  // and must never be confused with the storage key. See storageFilename().
  storage_filename: string
  mime: string
  type: 'image' | 'video'
  size_bytes: number
}

// Named so a shopper uploading a live-Photo/.heic photo or a .mov clip
// straight off an iPhone - both of which this plugin rejects - gets told
// what to send instead, rather than a dead-end "unsupported file type".
const ACCEPTED_FORMATS = 'JPEG, PNG, WebP, AVIF, MP4, WebM'

/**
 * The ONLY source of a stored file's extension. Keyed on the MIME this
 * plugin sniffed from the bytes itself, never on anything the client sent.
 *
 * This exists because the extension decides the Content-Type the file is
 * served back with. Medusa's default file provider (@medusajs/file-local)
 * builds its storage key from the filename it is handed, and core serves
 * that directory with a bare `express.static`, which derives Content-Type
 * from the EXTENSION and ignores the mimeType recorded alongside it. So a
 * client-chosen filename is a client-chosen Content-Type on the merchant's
 * own backend origin - the same origin as the admin dashboard - and video
 * is deliberately not re-encoded, so an HTML/JS payload hidden behind MP4
 * magic bytes would survive byte-for-byte. Stored XSS, from an endpoint
 * that needs only a publishable key.
 *
 * Every mime this map must cover is exactly ALLOWED_IMAGE_MIMES +
 * ALLOWED_VIDEO_MIMES from sniff-mime.ts; mediaTypeFor() has already
 * rejected anything outside that set before this map is consulted, so a
 * lookup here cannot miss. storageFilename() still fails loudly rather
 * than falling back to a default extension, so adding a format to the
 * sniffer without adding it here is a hard error, not a silent regression
 * back to attacker-chosen extensions.
 */
const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/**
 * Builds the name the file is actually stored under. Derived ENTIRELY from
 * the sniffed MIME plus a crypto-strength random token: not one byte of the
 * client's own filename reaches it - not sanitized, not escaped, not as a
 * suffix. That closes four things at once: the served-Content-Type control
 * above, any path component the client tried to smuggle in (the local
 * provider preserves `path.parse(filename).dir` and creates it), the
 * publication of a shopper's own filename in a public URL
 * (`mary-smith-home-address.jpg`), and the enumerability of keys that a
 * `${Date.now()}-${originalname}` scheme leaves behind.
 *
 * randomUUID() rather than a timestamp/counter deliberately: the key is
 * public and unauthenticated-readable, so it is the only thing standing
 * between a rejected review's media and anyone who wants to guess its URL.
 */
function storageFilename(mime: string): string {
  const ext = EXT_FOR_MIME[mime]

  if (!ext) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Unsupported file type. Accepted formats: ${ACCEPTED_FORMATS}`
    )
  }

  return `${randomUUID()}.${ext}`
}

/**
 * A sharp/libvips failure - an over-budget image, a corrupt-but-correctly-
 * magicked file, libheif's own internal limits - is a plain Error, which
 * has neither an http-errors statusCode nor a MedusaError `.type`, so left
 * alone it falls through the framework's error-handler switch to an opaque
 * 500 "unknown error occurred". A malformed image is one of the most
 * likely things a shopper does on this endpoint; reporting it as a server
 * fault reads as "the site is broken" and pollutes error monitoring with
 * false alerts.
 *
 * This is the same fix, with the same reasoning, as `toClientUploadError`
 * in src/api/store/reviews/middlewares.ts, and it is deliberately built the
 * same way: ONLY a MediaDecodeError may be converted (enforced by the
 * parameter type - the call site must narrow with `instanceof` first).
 * MediaDecodeError is raised by strip-exif.ts around the sharp calls and
 * nowhere else, so the conversion cannot reach any other failure. Do not
 * widen this function or its call site to accept `unknown`/`Error`: that
 * would launder a genuine server fault into a false 400.
 */
function toClientMediaError(filename: string, error: MediaDecodeError): MedusaError {
  return new MedusaError(
    MedusaError.Types.INVALID_DATA,
    `${filename} could not be processed as an image: ${error.message} Accepted formats: ${ACCEPTED_FORMATS}`
  )
}

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

    // Sequential, not Promise.all. Every file in the batch is an
    // independent decode, so running the whole batch concurrently lets one
    // unauthenticated request occupy up to max_media_per_review cores at
    // once - the measured case was five images costing 2.4s of wall-clock
    // server CPU from 4KB of request body. Serial keeps a single request to
    // a single core's worth of work; the pixel budget in stripExif bounds
    // how much work that is.
    const prepared: {
      storage_filename: string
      mime: string
      type: 'image' | 'video'
      content: Buffer
      size_bytes: number
    }[] = []

    for (const file of input.files) {
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

      let content: Buffer

      try {
        content = await stripExif(raw, mime)
      } catch (error) {
        // The instanceof check is the enforcement point for
        // toClientMediaError's contract: only a MediaDecodeError (raised
        // by strip-exif.ts around the sharp calls, and nowhere else) is
        // converted. Anything else is a real server fault and MUST keep
        // propagating untouched as a 500.
        throw error instanceof MediaDecodeError
          ? toClientMediaError(file.filename, error)
          : error
      }

      prepared.push({
        storage_filename: storageFilename(mime),
        mime,
        type,
        content,
        size_bytes: content.length,
      })
    }

    const { result: files } = await uploadFilesWorkflow(container).run({
      input: {
        files: prepared.map((f) => ({
          filename: f.storage_filename,
          mimeType: f.mime,
          content: f.content.toString('base64'),
          access: 'public' as const,
        })),
      },
    })

    const preparedMeta: PreparedFile[] = prepared.map((f) => ({
      storage_filename: f.storage_filename,
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
