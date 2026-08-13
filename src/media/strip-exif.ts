import sharp from 'sharp'
import { mediaTypeFor } from './sniff-mime'

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

  // sharp drops all metadata unless withMetadata() is called, so a plain
  // re-encode is the strip.
  return await sharp(buffer).rotate().toBuffer()
}
