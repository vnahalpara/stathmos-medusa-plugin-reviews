import { Readable } from 'node:stream'
import { MedusaError } from '@medusajs/framework/utils'
import type multer from 'multer'

/**
 * Transport-layer ceilings for POST /store/reviews/uploads, deliberately
 * separate from the merchant-configurable settings the workflow enforces:
 * these refuse an oversized request before its bytes are buffered, the
 * settings then refine further within them. Rate limiting (Phase 6) bounds
 * request *frequency*; these bound a single request, which is a different
 * attack surface - one request was enough.
 *
 * How the numbers are chosen, and why they are not all simply "the schema
 * maximum":
 *
 * - PER FILE (100MB) is pinned to the largest value `max_video_size_mb` can
 *   be configured to (UpdateReviewSettingsSchema caps it at 100). It must
 *   not go below that or a merchant could set a cap multer would silently
 *   never let a file reach.
 * - FILE COUNT (20) is pinned to `max_media_per_review`'s schema max for
 *   exactly the same reason.
 * - PER REQUEST (250MB) is the one that is NOT a product of the two above.
 *   20 x 100MB is 2GB of attacker-chosen bytes buffered in memory per
 *   request - and the route then base64s it, the step base64-decodes,
 *   re-encodes and base64s it again, so roughly 4-5x that lives at once.
 *   No amount of per-file capping bounds a request; only an aggregate does.
 *   250MB is the largest request the DEFAULT settings can legitimately
 *   produce (max_media_per_review 5 x max_video_size_mb 50MB), which is the
 *   honest envelope to serve: it accepts every submission a default install
 *   can generate and cuts the worst case by 8x. A merchant who raises both
 *   settings toward their independent maxima can exceed it, and is told so
 *   in the README - that is a documented, deliberate trade, not an
 *   oversight.
 * - FIELDS (0) because this endpoint takes no text fields whatsoever.
 *   multer's defaults leave `fields` and `parts` at Infinity and cap only
 *   `fieldSize`, so 300 x 100KB of junk text fields was accepted in 72ms
 *   and landed in req.body. Nothing here reads req.body.
 * - PARTS sits a little above the file count on purpose, so a request with
 *   too many FILES trips LIMIT_FILE_COUNT (which names the real limit to
 *   the client) rather than the blunter LIMIT_PART_COUNT.
 */
export const MAX_UPLOAD_FILE_SIZE_MB = 100
export const MAX_UPLOAD_FILES = 20
export const MAX_UPLOAD_REQUEST_SIZE_MB = 250
export const MAX_UPLOAD_FIELDS = 0
export const MAX_UPLOAD_PARTS = MAX_UPLOAD_FILES + 5
export const MAX_UPLOAD_FIELD_SIZE_BYTES = 1024
export const MAX_UPLOAD_FIELD_NAME_SIZE_BYTES = 100

const MB = 1024 * 1024

/**
 * Per-request byte tally, hung off the request object under a symbol so it
 * cannot collide with anything else on it and is not enumerable in logs.
 */
const REQUEST_BYTES = Symbol('review-media-upload-bytes')

type ByteTallyCarrier = { [REQUEST_BYTES]?: { total: number } }

export function uploadTooLargeError(maxTotalBytes: number): MedusaError {
  return new MedusaError(
    MedusaError.Types.INVALID_DATA,
    `The upload exceeds the ${Math.round(maxTotalBytes / MB)}MB total limit for a single request.`
  )
}

/**
 * multer's own `limits.fileSize` is per file; multer has no aggregate
 * option at all, and no amount of tuning the per-file limits gives you one.
 * This is a memory storage engine that keeps a running total ACROSS the
 * files of a single request and fails the moment the request as a whole
 * crosses `maxTotalBytes`.
 *
 * It fails mid-stream rather than after the fact on purpose: the whole
 * point is that the bytes never accumulate. Returning the error through
 * multer's own storage callback routes it into multer's `abortWithError`,
 * which unpipes busboy and drains the rest of the request without
 * buffering it.
 *
 * The error handed back is a MedusaError, not a MulterError, so that it
 * passes through `uploadReviewMediaFiles`'s deliberately narrow
 * `instanceof multer.MulterError` conversion untouched and is mapped to a
 * 400 by the framework on its own `.type`. It is ours by construction -
 * nothing is being laundered.
 */
export function aggregateLimitedMemoryStorage(
  maxTotalBytes: number
): multer.StorageEngine {
  return {
    _handleFile(req, file, cb) {
      const carrier = req as unknown as ByteTallyCarrier
      const tally = (carrier[REQUEST_BYTES] ??= { total: 0 })
      const stream = file.stream as Readable

      let chunks: Buffer[] = []
      let settled = false

      stream.on('data', (chunk: Buffer) => {
        if (settled) {
          return
        }

        tally.total += chunk.length

        if (tally.total > maxTotalBytes) {
          settled = true
          // Drop what was collected immediately; holding it until the
          // request unwinds would concede exactly the memory this limit
          // exists to protect.
          chunks = []
          cb(uploadTooLargeError(maxTotalBytes))
          return
        }

        chunks.push(chunk)
      })

      stream.on('end', () => {
        if (settled) {
          return
        }

        settled = true
        const buffer = Buffer.concat(chunks)
        chunks = []
        cb(null, { buffer, size: buffer.length })
      })

      stream.on('error', (error: Error) => {
        if (settled) {
          return
        }

        settled = true
        chunks = []
        cb(error)
      })
    },

    _removeFile(_req, file, cb) {
      delete (file as { buffer?: Buffer }).buffer
      cb(null)
    },
  }
}

export const reviewMediaUploadLimits = {
  fileSize: MAX_UPLOAD_FILE_SIZE_MB * MB,
  files: MAX_UPLOAD_FILES,
  fields: MAX_UPLOAD_FIELDS,
  parts: MAX_UPLOAD_PARTS,
  fieldSize: MAX_UPLOAD_FIELD_SIZE_BYTES,
  fieldNameSize: MAX_UPLOAD_FIELD_NAME_SIZE_BYTES,
}

export const MAX_UPLOAD_REQUEST_SIZE_BYTES = MAX_UPLOAD_REQUEST_SIZE_MB * MB
