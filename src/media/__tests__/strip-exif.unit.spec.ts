import sharp from 'sharp'
import { stripExif } from '../strip-exif'

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

describe('stripExif', () => {
  it('removes EXIF metadata, including GPS coordinates, from a jpeg', async () => {
    const withExif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
    })
      .withMetadata({
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
      .jpeg()
      .toBuffer()

    const beforeMeta = await sharp(withExif).metadata()
    expect(beforeMeta.exif).toBeDefined()
    expect(hasGpsTags(beforeMeta.exif)).toBe(true)

    const cleaned = await stripExif(withExif, 'image/jpeg')
    const afterMeta = await sharp(cleaned).metadata()

    expect(afterMeta.exif).toBeUndefined()
    expect(hasGpsTags(afterMeta.exif)).toBe(false)
  })

  it('still produces a valid decodable image', async () => {
    const original = await sharp({
      create: { width: 12, height: 10, channels: 3, background: '#00ff00' },
    })
      .png()
      .toBuffer()

    const cleaned = await stripExif(original, 'image/png')
    const meta = await sharp(cleaned).metadata()

    expect(meta.width).toBe(12)
    expect(meta.height).toBe(10)
  })

  it('passes video through untouched', async () => {
    const fake = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])

    expect(await stripExif(fake, 'video/webm')).toBe(fake)
  })
})
