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

function mp4(): Buffer {
  const b = Buffer.alloc(16)
  b.write('ftyp', 4, 'ascii')
  b.write('isom', 8, 'ascii')
  return b
}

const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00])

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

  it('detects mp4', () => {
    expect(sniffMime(mp4())).toBe('video/mp4')
  })

  it('detects webm', () => {
    expect(sniffMime(webm)).toBe('video/webm')
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
