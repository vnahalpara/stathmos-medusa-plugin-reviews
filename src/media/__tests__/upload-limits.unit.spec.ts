import { PassThrough } from 'node:stream'
import { MedusaError } from '@medusajs/framework/utils'
import {
  aggregateLimitedMemoryStorage,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILE_SIZE_MB,
  MAX_UPLOAD_PARTS,
  MAX_UPLOAD_REQUEST_SIZE_MB,
  reviewMediaUploadLimits,
} from '../upload-limits'

type StoredFile = { buffer?: Buffer; size?: number }

/**
 * Drives the storage engine the way multer does: one call per file, each
 * with its own stream, all sharing one request object - which is what
 * makes the tally aggregate rather than per-file.
 */
function handle(
  storage: ReturnType<typeof aggregateLimitedMemoryStorage>,
  req: object,
  chunks: Buffer[]
): Promise<{ error?: Error; info?: StoredFile }> {
  const stream = new PassThrough()

  const settled = new Promise<{ error?: Error; info?: StoredFile }>((resolve) => {
    storage._handleFile(
      req as never,
      { stream } as never,
      (error?: unknown, info?: StoredFile) => {
        resolve({ error: (error as Error) ?? undefined, info })
      }
    )
  })

  for (const chunk of chunks) {
    stream.write(chunk)
  }
  stream.end()

  return settled
}

describe('reviewMediaUploadLimits', () => {
  it('accepts no non-file form parts at all', () => {
    expect(reviewMediaUploadLimits.fields).toBe(0)
  })

  it('bounds the total number of parts, not only the number of files', () => {
    expect(typeof reviewMediaUploadLimits.parts).toBe('number')
    expect(reviewMediaUploadLimits.parts).toBe(MAX_UPLOAD_PARTS)
    // Above the file count so too-many-FILES reports LIMIT_FILE_COUNT,
    // which names the real limit, rather than the blunter part-count error.
    expect(reviewMediaUploadLimits.parts).toBeGreaterThan(MAX_UPLOAD_FILES)
  })

  it('bounds field size and field-name size', () => {
    expect(reviewMediaUploadLimits.fieldSize).toBeLessThanOrEqual(1024)
    expect(reviewMediaUploadLimits.fieldNameSize).toBeLessThanOrEqual(100)
  })

  /**
   * The point of the aggregate limit: 20 files x 100MB each is 2GB of
   * memory per request, and every per-file limit in multer is satisfied by
   * it. This must be strictly below that product, or it bounds nothing.
   */
  it('bounds a whole request far below the product of the per-file limits', () => {
    expect(MAX_UPLOAD_REQUEST_SIZE_MB).toBeLessThan(
      MAX_UPLOAD_FILES * MAX_UPLOAD_FILE_SIZE_MB
    )
    // Still at or above what the default settings can legitimately produce
    // (max_media_per_review 5 x max_video_size_mb 50MB), so no default
    // install can generate a submission this rejects.
    expect(MAX_UPLOAD_REQUEST_SIZE_MB).toBeGreaterThanOrEqual(5 * 50)
  })
})

describe('aggregateLimitedMemoryStorage', () => {
  it('stores a file that fits', async () => {
    const storage = aggregateLimitedMemoryStorage(100)
    const req = {}

    const { error, info } = await handle(storage, req, [Buffer.alloc(40, 1)])

    expect(error).toBeUndefined()
    expect(info?.size).toBe(40)
  })

  /**
   * The load-bearing case, and the one multer cannot express: neither file
   * exceeds any per-file limit, but together they exceed the request. A
   * per-file-only bound stores both.
   */
  it('rejects once the files of one request together exceed the budget', async () => {
    const storage = aggregateLimitedMemoryStorage(100)
    const req = {}

    const first = await handle(storage, req, [Buffer.alloc(60, 1)])
    expect(first.error).toBeUndefined()

    const second = await handle(storage, req, [Buffer.alloc(60, 1)])

    expect(second.error).toBeInstanceOf(MedusaError)
    expect((second.error as MedusaError).type).toBe(MedusaError.Types.INVALID_DATA)
    expect(second.error?.message).toContain('single request')
  })

  it('counts a separate request separately', async () => {
    const storage = aggregateLimitedMemoryStorage(100)

    const first = await handle(storage, {}, [Buffer.alloc(90, 1)])
    const second = await handle(storage, {}, [Buffer.alloc(90, 1)])

    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
  })

  /**
   * It must fail on the chunk that crosses the line, not after the stream
   * has finished: otherwise the bytes it exists to refuse are already all
   * in memory by the time it refuses them.
   */
  it('fails mid-stream and keeps nothing it has already buffered', async () => {
    const storage = aggregateLimitedMemoryStorage(100)
    const stream = new PassThrough()
    const req = {}

    const settled = new Promise<{ error?: Error }>((resolve) => {
      storage._handleFile(req as never, { stream } as never, (error?: unknown) => {
        resolve({ error: (error as Error) ?? undefined })
      })
    })

    stream.write(Buffer.alloc(80, 1))
    stream.write(Buffer.alloc(80, 1))

    const { error } = await settled

    expect(error).toBeInstanceOf(MedusaError)
    // Not ended: the rejection landed while the stream was still open.
    expect(stream.writableEnded).toBe(false)

    stream.end()
  })
})
