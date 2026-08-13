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

// ISO base media file format brand -> MP4 variants this plugin actually
// serves. The "ftyp" marker is shared by many unrelated containers —
// QuickTime .mov ("qt  "), 3GPP ("3gp4"/"3g2a"), HEIF/HEIC images
// ("heic"/"mif1"), M4A audio ("M4A ") — all of which are real, easily
// crafted files that must NOT be accepted as video/mp4. AVIF is handled
// separately below and is not part of this list.
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'mp4v',
  'avc1',
  'M4V ',
  'dash',
])

// How far into an EBML header to scan for the DocType element (ID 0x42 0x82).
// Not a full EBML parser: just far enough to find that one element. DocType
// is matched exactly (not a substring search), so it's safe to scan a wide
// window without risking a match on unrelated text (e.g. a MuxingApp string)
// elsewhere in the header.
const EBML_HEADER_SCAN_LENGTH = 256

/**
 * Reads the value of the EBML DocType element (ID 0x42 0x82) from the first
 * `scanLength` bytes of `buf`, or `null` if it isn't found or can't be
 * parsed. This is not a general EBML/VINT decoder: DocType's size is always
 * small in practice, so only the single-byte size form (high bit set, low 7
 * bits = length) is supported. A size byte without the high bit set is
 * treated as unparseable rather than guessed at.
 */
const ebmlDocType = (buf: Buffer, scanLength: number): string | null => {
  const limit = Math.min(buf.length, scanLength)

  for (let i = 0; i < limit - 1; i++) {
    if (buf[i] !== 0x42 || buf[i + 1] !== 0x82) {
      continue
    }

    const sizeByteIndex = i + 2

    if (sizeByteIndex >= buf.length) {
      return null
    }

    const sizeByte = buf[sizeByteIndex]

    if ((sizeByte & 0x80) === 0) {
      return null
    }

    const length = sizeByte & 0x7f
    const valueStart = sizeByteIndex + 1
    const valueEnd = valueStart + length

    if (valueEnd > buf.length) {
      return null
    }

    return buf.subarray(valueStart, valueEnd).toString('ascii')
  }

  return null
}

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

  // ISO base media: bytes 4-7 "ftyp", brand follows at 8-11. The brand
  // must be length-checked (not just read via the length-safe asciiAt)
  // because a truncated buffer that only contains the "ftyp" marker must
  // not be classified from a brand it doesn't actually have.
  if (asciiAt(buffer, 4, 4) === 'ftyp') {
    if (buffer.length < 12) {
      return null
    }

    const brand = asciiAt(buffer, 8, 4)

    if (brand === 'avif' || brand === 'avis') {
      return 'image/avif'
    }

    return MP4_BRANDS.has(brand) ? 'video/mp4' : null
  }

  // Matroska/WebM EBML header. The 0x1A45DFA3 magic is shared by both
  // formats — Matroska (.mkv) is not a valid upload here, so the DocType
  // element must be read (element ID 0x42 0x82) and compared exactly, not
  // just searched for as a substring: a Matroska file's MuxingApp/WritingApp
  // strings can legitimately contain arbitrary text, including "webm".
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ebmlDocType(buffer, EBML_HEADER_SCAN_LENGTH) === 'webm'
      ? 'video/webm'
      : null
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
