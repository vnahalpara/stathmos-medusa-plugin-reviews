/**
 * Content type is determined from the file's own bytes, never from the
 * client-supplied Content-Type header. A spoofed header is how an upload
 * endpoint turns into arbitrary file hosting.
 */
export const ALLOWED_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const

export const ALLOWED_VIDEO_MIMES = ['video/mp4', 'video/webm'] as const

const startsWith = (buf: Buffer, bytes: number[], offset = 0): boolean => {
  if (buf.length < offset + bytes.length) {
    return false
  }

  return bytes.every((byte, i) => buf[offset + i] === byte)
}

const asciiAt = (buf: Buffer, offset: number, length: number): string =>
  buf.length < offset + length
    ? ''
    : buf.subarray(offset, offset + length).toString('ascii')

export function sniffMime(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 8) {
    return null
  }

  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg'
  }

  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }

  // RIFF containers: bytes 0-3 "RIFF", bytes 8-11 identify the payload.
  if (asciiAt(buffer, 0, 4) === 'RIFF' && asciiAt(buffer, 8, 4) === 'WEBP') {
    return 'image/webp'
  }

  // ISO base media: bytes 4-7 "ftyp", brand follows at 8.
  if (asciiAt(buffer, 4, 4) === 'ftyp') {
    const brand = asciiAt(buffer, 8, 4)

    if (brand === 'avif' || brand === 'avis') {
      return 'image/avif'
    }

    return 'video/mp4'
  }

  // Matroska/WebM EBML header.
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
    return 'video/webm'
  }

  return null
}

export function mediaTypeFor(mime: string): 'image' | 'video' | null {
  if ((ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)) {
    return 'image'
  }

  if ((ALLOWED_VIDEO_MIMES as readonly string[]).includes(mime)) {
    return 'video'
  }

  return null
}
