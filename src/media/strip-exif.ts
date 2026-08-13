import sharp from 'sharp'
import { mediaTypeFor } from './sniff-mime'

/**
 * Decode budget for a single uploaded image.
 *
 * The size gate upstream is on COMPRESSED bytes, which bounds nothing about
 * the work a decode costs: 806 bytes of AVIF can declare 6000x6000 and cost
 * ~500ms of CPU to decode, roughly 600x amplification of bytes-on-the-wire
 * to milliseconds-of-CPU on an endpoint that needs only a publishable key.
 * sharp's own default `limitInputPixels` is 268,402,689 - it permits
 * 16383x16383 - so it is not a bound in any useful sense here.
 *
 * 25MP with a 10,000px long edge is above anything a shopper photographs a
 * product with, and in practice the compressed-size cap bites first for
 * real photographs (a genuine 25MP JPEG does not fit in the 5MB default
 * `max_image_size_mb`). What it rejects is the case where those two facts
 * diverge, which is exactly the decompression bomb.
 */
export const MAX_IMAGE_PIXELS = 25_000_000
export const MAX_IMAGE_DIMENSION = 10_000

/**
 * Raised for anything that goes wrong decoding or re-encoding an image, and
 * for nothing else. Its purpose is to be narrow: it is the type that lets
 * the upload step convert a failure here into an actionable 400 without
 * risking laundering an unrelated server fault into one. See
 * `toClientMediaError` in upload-review-media-files.ts, which mirrors
 * `toClientUploadError`'s contract for multer errors.
 */
export class MediaDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaDecodeError'
  }
}

/**
 * Re-encodes images to drop metadata. Phone photos carry GPS coordinates in
 * EXIF, so publishing them verbatim next to a review would expose where the
 * reviewer lives.
 *
 * Video passes through: stripping container metadata needs ffmpeg, which is
 * out of scope for Phase 2 (no transcoding).
 */
export async function stripExif(buffer: Buffer, mime: string): Promise<Buffer> {
  if (mediaTypeFor(mime) !== 'image') {
    return buffer
  }

  // Header read only - no pixels are decoded, which is the entire point:
  // measured on a 6000x6000 AVIF this costs ~1ms against ~900ms for the
  // decode it is deciding whether to allow. A bomb must be rejected
  // cheaply, not merely rejected. `limitInputPixels: false` is safe (and
  // necessary) here precisely because nothing is decoded: it lets the
  // explicit checks below produce an accurate, actionable message instead
  // of an opaque libvips failure.
  let width: number | undefined
  let height: number | undefined

  try {
    const metadata = await sharp(buffer, { limitInputPixels: false }).metadata()
    width = metadata.width
    height = metadata.height
  } catch (error) {
    throw new MediaDecodeError(
      `Image could not be read: ${(error as Error).message}`
    )
  }

  if (!width || !height) {
    throw new MediaDecodeError('Image dimensions could not be determined.')
  }

  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new MediaDecodeError(
      `Image is ${width}x${height}; neither side may exceed ${MAX_IMAGE_DIMENSION} pixels.`
    )
  }

  if (width * height > MAX_IMAGE_PIXELS) {
    throw new MediaDecodeError(
      `Image is ${width}x${height}; at most ${MAX_IMAGE_PIXELS / 1_000_000}MP is accepted.`
    )
  }

  try {
    // sharp drops all metadata unless withMetadata() is called, so a plain
    // re-encode is the strip. limitInputPixels is repeated here as the
    // backstop for a header that understates the real image.
    return await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS })
      .rotate()
      .toBuffer()
  } catch (error) {
    throw new MediaDecodeError(
      `Image could not be processed: ${(error as Error).message}`
    )
  }
}
