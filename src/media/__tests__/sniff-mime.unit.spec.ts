import { sniffMime, mediaTypeFor } from '../sniff-mime'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00])

function riff(kind: string): Buffer {
  const b = Buffer.alloc(16)
  b.write('RIFF', 0, 'ascii')
  b.write(kind, 8, 'ascii')
  return b
}

function ftyp(brand: string): Buffer {
  const b = Buffer.alloc(16)
  b.write('ftyp', 4, 'ascii')
  b.write(brand, 8, 'ascii')
  return b
}

function truncatedFtyp(): Buffer {
  // 4 junk bytes + "ftyp", with no room left for a brand at offset 8-11.
  const b = Buffer.alloc(8)
  b.write('ftyp', 4, 'ascii')
  return b
}

function ebml(docType?: string): Buffer {
  const b = Buffer.alloc(64)
  b[0] = 0x1a
  b[1] = 0x45
  b[2] = 0xdf
  b[3] = 0xa3
  if (docType) {
    b.write(docType, 20, 'ascii')
  }
  return b
}

describe('sniffMime', () => {
  it('detects jpeg', () => {
    expect(sniffMime(jpeg)).toBe('image/jpeg')
  })

  it('detects png', () => {
    expect(sniffMime(png)).toBe('image/png')
  })

  it('detects webp', () => {
    expect(sniffMime(riff('WEBP'))).toBe('image/webp')
  })

  it('detects mp4 for the "isom" brand', () => {
    expect(sniffMime(ftyp('isom'))).toBe('video/mp4')
  })

  it('detects mp4 for the "mp42" brand', () => {
    expect(sniffMime(ftyp('mp42'))).toBe('video/mp4')
  })

  it('detects mp4 for the "avc1" brand', () => {
    expect(sniffMime(ftyp('avc1'))).toBe('video/mp4')
  })

  it('detects avif', () => {
    expect(sniffMime(ftyp('avif'))).toBe('image/avif')
  })

  it('rejects a QuickTime .mov (brand "qt  ")', () => {
    expect(sniffMime(ftyp('qt  '))).toBeNull()
  })

  it('rejects a HEIC image (brand "heic")', () => {
    expect(sniffMime(ftyp('heic'))).toBeNull()
  })

  it('rejects a HEIF image (brand "mif1")', () => {
    expect(sniffMime(ftyp('mif1'))).toBeNull()
  })

  it('rejects a truncated ftyp buffer with no room for a brand', () => {
    expect(sniffMime(truncatedFtyp())).toBeNull()
  })

  it('detects webm when the DocType is "webm"', () => {
    expect(sniffMime(ebml('webm'))).toBe('video/webm')
  })

  it('rejects a Matroska file (DocType "matroska") sharing the EBML magic', () => {
    expect(sniffMime(ebml('matroska'))).toBeNull()
  })

  it('rejects an EBML file with no recognizable DocType', () => {
    expect(sniffMime(ebml())).toBeNull()
  })

  it('returns null for a disallowed type even though it is a real image', () => {
    expect(sniffMime(gif)).toBeNull()
  })

  it('returns null for arbitrary bytes', () => {
    expect(sniffMime(Buffer.from('#!/bin/sh\nrm -rf /'))).toBeNull()
  })

  it('returns null for an empty or truncated buffer', () => {
    expect(sniffMime(Buffer.alloc(0))).toBeNull()
    expect(sniffMime(Buffer.from([0xff]))).toBeNull()
  })
})

describe('mediaTypeFor', () => {
  it('classifies images', () => {
    expect(mediaTypeFor('image/png')).toBe('image')
  })

  it('classifies videos', () => {
    expect(mediaTypeFor('video/mp4')).toBe('video')
  })

  it('rejects anything else', () => {
    expect(mediaTypeFor('application/pdf')).toBeNull()
  })
})
