import sharp from 'sharp'
import { stripExif } from '../strip-exif'

describe('stripExif', () => {
  it('removes EXIF metadata from a jpeg', async () => {
    const withExif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
    })
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-location-data' } } })
      .jpeg()
      .toBuffer()

    expect((await sharp(withExif).metadata()).exif).toBeDefined()

    const cleaned = await stripExif(withExif, 'image/jpeg')

    expect((await sharp(cleaned).metadata()).exif).toBeUndefined()
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
