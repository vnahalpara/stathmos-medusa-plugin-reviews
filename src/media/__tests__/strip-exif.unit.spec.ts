import sharp from 'sharp'
import {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MediaDecodeError,
  stripExif,
} from '../strip-exif'

/**
 * Minimal TIFF/EXIF walker used only by this test to prove GPS coordinates
 * specifically are gone, not just that "some exif buffer" disappeared.
 * Returns true if IFD0 contains a GPS IFD pointer (tag 0x8825) whose
 * sub-IFD contains a GPSLatitude tag (0x0002).
 */
function hasGpsTags(exif: Buffer | undefined): boolean {
  if (!exif) {
    return false
  }

  // sharp's metadata().exif buffer starts with the 6-byte "Exif\0\0" APP1
  // prefix, followed by the TIFF header.
  const prefixLen = exif.toString('ascii', 0, 4) === 'Exif' ? 6 : 0
  const tiff = exif.subarray(prefixLen)

  const order = tiff.toString('ascii', 0, 2)

  if (order !== 'II' && order !== 'MM') {
    return false
  }

  const le = order === 'II'
  const read16 = (off: number) => (le ? tiff.readUInt16LE(off) : tiff.readUInt16BE(off))
  const read32 = (off: number) => (le ? tiff.readUInt32LE(off) : tiff.readUInt32BE(off))

  const findTag = (ifdOffset: number, tagId: number): number | null => {
    const count = read16(ifdOffset)

    for (let i = 0; i < count; i++) {
      const entryOffset = ifdOffset + 2 + i * 12

      if (read16(entryOffset) === tagId) {
        return read32(entryOffset + 8)
      }
    }

    return null
  }

  const ifd0Offset = read32(4)
  const gpsIfdOffset = findTag(ifd0Offset, 0x8825)

  return gpsIfdOffset !== null && findTag(gpsIfdOffset, 0x0002) !== null
}

async function exifBearing(
  format: 'jpeg' | 'png' | 'webp' | 'avif',
  width = 8,
  height = 8
): Promise<Buffer> {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: '#ff0000' },
  }).withMetadata({
    exif: {
      IFD0: { Copyright: 'secret-location-data' },
      // sharp's own withExif docs key the GPS IFD as "IFD3" - this is
      // the EXIF spec's GPS IFD, pointed to from IFD0 by tag 0x8825.
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 3230/100',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 4366/100',
      },
    },
  })

  return await pipeline[format]().toBuffer()
}

/**
 * Every accepted image format, not just jpeg. The previous version of this
 * suite proved jpeg only: its png case asserted width/height, which a
 * pass-through buffer satisfies just as well as a stripped one. Narrowing
 * strip-exif.ts's guard to `mime !== 'image/jpeg'` left all of it green
 * while png, webp and avif uploads kept their EXIF - GPS coordinates
 * included - which is the exact harm this module exists to prevent, for
 * three of the four formats this plugin accepts.
 */
const IMAGE_FORMATS = [
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
] as const

describe('stripExif', () => {
  it.each(IMAGE_FORMATS)(
    'removes EXIF metadata, including GPS coordinates, from %s',
    async (mime, format) => {
      const withExif = await exifBearing(format)

      const beforeMeta = await sharp(withExif).metadata()
      expect(beforeMeta.exif).toBeDefined()
      expect(hasGpsTags(beforeMeta.exif)).toBe(true)

      const cleaned = await stripExif(withExif, mime)
      const afterMeta = await sharp(cleaned).metadata()

      expect(afterMeta.exif).toBeUndefined()
      expect(hasGpsTags(afterMeta.exif)).toBe(false)
    }
  )

  it.each(IMAGE_FORMATS)(
    'still produces a valid decodable image for %s',
    async (mime, format) => {
      const original = await exifBearing(format, 12, 10)

      const cleaned = await stripExif(original, mime)
      const meta = await sharp(cleaned).metadata()

      expect(meta.width).toBe(12)
      expect(meta.height).toBe(10)
    }
  )

  it('passes video through untouched', async () => {
    const fake = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])

    expect(await stripExif(fake, 'video/webm')).toBe(fake)
  })

  /**
   * The decompression-bomb case. 806 bytes of AVIF declaring 6000x6000 cost
   * ~500ms of CPU to decode; sharp's default limitInputPixels permits
   * 16383x16383, so nothing stopped it. The bound has to be applied from
   * the header, before the decode - rejecting it slowly is not rejecting
   * it.
   */
  it('rejects an image whose pixel count exceeds the decode budget', async () => {
    const bomb = await sharp({
      create: { width: 6000, height: 6000, channels: 3, background: '#123456' },
    })
      .avif({ quality: 1, effort: 0 })
      .toBuffer()

    expect(6000 * 6000).toBeGreaterThan(MAX_IMAGE_PIXELS)
    expect(bomb.length).toBeLessThan(10 * 1024)

    await expect(stripExif(bomb, 'image/avif')).rejects.toBeInstanceOf(MediaDecodeError)
  })

  it('rejects the bomb from its header, not after decoding it', async () => {
    const bomb = await sharp({
      create: { width: 6000, height: 6000, channels: 3, background: '#123456' },
    })
      .avif({ quality: 1, effort: 0 })
      .toBuffer()

    const started = Date.now()
    await stripExif(bomb, 'image/avif').catch(() => undefined)
    const rejectionMs = Date.now() - started

    // A full decode + re-encode of this same buffer measures ~900ms. A
    // header read measures ~1ms. This is deliberately a loose ceiling: it
    // only has to be able to tell those two apart.
    expect(rejectionMs).toBeLessThan(200)
  })

  it('rejects an image whose long edge exceeds the dimension ceiling', async () => {
    const wide = await sharp({
      create: {
        width: MAX_IMAGE_DIMENSION + 1,
        height: 4,
        channels: 3,
        background: '#123456',
      },
    })
      .png({ compressionLevel: 1 })
      .toBuffer()

    // Well inside the pixel budget, so only the dimension ceiling can
    // reject it.
    expect((MAX_IMAGE_DIMENSION + 1) * 4).toBeLessThan(MAX_IMAGE_PIXELS)

    await expect(stripExif(wide, 'image/png')).rejects.toBeInstanceOf(MediaDecodeError)
  })

  /**
   * A file with correct magic bytes and garbage behind them passes the
   * sniffer and fails in libvips. It must arrive at the caller as a
   * MediaDecodeError so the upload step can report it as a 400 rather than
   * letting a plain Error fall through to an opaque 500.
   */
  it('raises MediaDecodeError, not a bare Error, for a corrupt image', async () => {
    const corrupt = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('this is not actually a png'.repeat(8)),
    ])

    await expect(stripExif(corrupt, 'image/png')).rejects.toBeInstanceOf(MediaDecodeError)
  })
})
