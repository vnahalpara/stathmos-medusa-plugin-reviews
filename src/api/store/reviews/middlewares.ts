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
import {
  aggregateLimitedMemoryStorage,
  MAX_UPLOAD_FILE_SIZE_MB,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_REQUEST_SIZE_BYTES,
  reviewMediaUploadLimits,
} from '../../../media/upload-limits'
import { GALLERY_MAX_LIMIT } from '../../../modules/review/service'

// Files are held in memory only long enough to sniff and re-encode them;
// the File Module owns persistence. Every ceiling, and the reasoning for
// each number, lives in src/media/upload-limits.ts - including the
// aggregate per-request bound, which multer has no option for and which
// the storage engine below enforces across a request's files.
const upload = multer({
  storage: aggregateLimitedMemoryStorage(MAX_UPLOAD_REQUEST_SIZE_BYTES),
  limits: reviewMediaUploadLimits,
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
    // This endpoint accepts files and nothing else, so `fields` is 0: any
    // text field at all trips this. Say so, rather than reporting a count
    // limit the caller cannot satisfy by sending fewer.
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
      return new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'This endpoint accepts file parts only; remove the non-file form fields.'
      )
    case 'LIMIT_PART_COUNT':
      return new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `At most ${MAX_UPLOAD_FILES} files may be uploaded in a single request, and no other form parts.`
      )
    default:
      return new MedusaError(MedusaError.Types.INVALID_DATA, `Upload rejected: ${err.message}.`)
  }
}

// busboy raises this - a bare Error, not a MulterError - when a part's
// headers cannot be parsed, which a NUL byte in the filename is enough to
// cause (node_modules/busboy/lib/types/multipart.js). Being neither a
// MulterError nor a MediaDecodeError, it fell through both narrow
// conversions to an opaque 500 "unknown error occurred", for a request the
// client malformed.
//
// Matched on the exact message, and ONLY that message, because the
// alternative - treating any non-multer parse failure as a client error -
// is precisely what the test below this file's other conversion exists to
// prevent: Busboy's constructor also throws a bare Error ("Boundary not
// found"), and that one is deliberately left as a 500 so a genuine server
// fault can never be laundered into a false 400. If busboy renames this
// string the effect is that the 500 comes back, which is the safe way for
// this to break.
const BUSBOY_MALFORMED_PART_HEADER = 'Malformed part header'

function isMalformedPartHeader(err: unknown): err is Error {
  return err instanceof Error && err.message === BUSBOY_MALFORMED_PART_HEADER
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
    if (err instanceof multer.MulterError) {
      next(toClientUploadError(err))
      return
    }

    if (isMalformedPartHeader(err)) {
      next(
        new MedusaError(
          MedusaError.Types.INVALID_DATA,
          'The multipart request body is malformed and could not be parsed.'
        )
      )
      return
    }

    next(err)
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
    media_ids: z.array(z.string().min(1)).max(20).optional(),
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

export const GalleryQuerySchema = z
  .object({
    product_id: z.string().min(1).optional(),
    type: z.enum(['image', 'video', 'all']).optional(),
    // Same "an uncapped limit is a free denial of service" reasoning as
    // ListProductReviewsSchema above, but higher stakes here: this is the
    // one store route with no product/review scope required at all, so a
    // caller can already ask for the whole store's gallery in one request
    // - GALLERY_MAX_LIMIT (service.ts) is the single number both this
    // schema and listGalleryMedia()'s own defensive clamp are pinned to.
    limit: z.preprocess(toInt, z.number().int().min(1).max(GALLERY_MAX_LIMIT).optional()),
    offset: z.preprocess(toInt, z.number().int().min(0).optional()),
  })
  .strict()

export type GalleryQuerySchema = z.infer<typeof GalleryQuerySchema>

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
  {
    matcher: '/store/reviews/gallery',
    method: 'GET',
    middlewares: [validateAndTransformQuery(GalleryQuerySchema, {})],
  },
  {
    matcher: '/store/reviews/:id/vote',
    method: 'POST',
    // Same allowUnauthenticated reasoning as POST /store/reviews above: a
    // guest must reach the route handler too (voting is not
    // customer-only), but a customer session/bearer token IS present when
    // sent, which is what lets the route dedup by customer_id instead of
    // computing a voter_hash for someone Task 1's review proved must never
    // get one. No body, so no Zod schema/validateAndTransformBody.
    middlewares: [authenticate('customer', ['session', 'bearer'], { allowUnauthenticated: true })],
  },
  {
    matcher: '/store/reviews/:id/vote',
    method: 'DELETE',
    middlewares: [authenticate('customer', ['session', 'bearer'], { allowUnauthenticated: true })],
  },
]
