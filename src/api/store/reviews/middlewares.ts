import {
  authenticate,
  MiddlewareRoute,
  validateAndTransformBody,
  validateAndTransformQuery,
} from '@medusajs/framework'
import { MedusaNextFunction, MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { MedusaError } from '@medusajs/framework/utils'
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
// for the same reason. Both values are also reused below in the client-
// facing error message so the two can never drift apart.
const MAX_UPLOAD_FILE_SIZE_MB = 100
const MAX_UPLOAD_FILES = 20

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024, files: MAX_UPLOAD_FILES },
})

// A tripped multer `limits` ceiling raises a bare `multer.MulterError`,
// which has neither an http-errors statusCode nor a MedusaError `.type` -
// left alone it falls through the framework's error-handler switch to an
// opaque 500 "unknown error occurred". That reads as "the site is broken"
// for the single most likely failure on this endpoint (a shopper's photo
// is too big), and pollutes error monitoring with false server-fault
// alerts. This converts it into an actionable 4xx that names the limit
// and its value, matching the voice of the format-rejection message in
// upload-review-media-files.ts ("Unsupported file type for X. Accepted
// formats: Y").
//
// ONLY a genuine multer.MulterError may be converted here (enforced by
// the parameter type below - callers must narrow with `instanceof` first,
// see uploadReviewMediaFiles). Any other error is a real server fault and
// MUST keep propagating untouched as a 500. Do not widen this function or
// its call site to accept `unknown`/`Error` - that would risk laundering
// a genuine server fault into a false 400.
function toClientUploadError(err: multer.MulterError): MedusaError {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `A file exceeds the ${MAX_UPLOAD_FILE_SIZE_MB}MB size limit per file.`
      )
    case 'LIMIT_FILE_COUNT':
      return new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `At most ${MAX_UPLOAD_FILES} files may be uploaded in a single request.`
      )
    default:
      return new MedusaError(MedusaError.Types.INVALID_DATA, `Upload rejected: ${err.message}.`)
  }
}

function uploadReviewMediaFiles(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  upload.array('files')(req, res, (err: unknown) => {
    if (!err) {
      next()
      return
    }

    // The instanceof check is the enforcement point for toClientUploadError's
    // contract: only a MulterError is converted, everything else (a real
    // server fault) is forwarded exactly as thrown so it still surfaces as
    // a 500.
    next(err instanceof multer.MulterError ? toClientUploadError(err) : err)
  })
}

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
    middlewares: [uploadReviewMediaFiles],
  },
]
