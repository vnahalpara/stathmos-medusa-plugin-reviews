import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'

async function pngBase64(): Promise<string> {
  const buf = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#00ff00' },
  })
    .png()
    .toBuffer()

  return buf.toString('base64')
}

/**
 * `expect(promise).rejects.toThrow()` on a workflow `.run()` promise is
 * unreliable in this test runner - documented in
 * update-review-settings-compensation.spec.ts and reconfirmed while
 * building upload-review-media.spec.ts. A try/catch is used for the
 * workflow promise instead; the file-service assertion below it is a plain
 * fs-based promise unrelated to the workflow orchestrator, so
 * `.rejects.toThrow()` is fine there.
 */
async function runAndExpectRejection(promise: Promise<unknown>, messageIncludes: string) {
  let threw = false
  try {
    await promise
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain(messageIncludes)
  }
  expect(threw).toBe(true)
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('uploadReviewMediaWorkflow compensation', () => {
      afterEach(() => {
        jest.restoreAllMocks()
      })

      /**
       * R1 exists to stop an upload leaking bytes in object storage with no
       * database row pointing at them - invisible to the Task 9 orphan
       * sweep, which only ever looks at unattached *rows*. The scenario
       * that actually produces that leak is row creation itself failing
       * after the file upload already committed: uploadReviewMediaWorkflow
       * is two steps precisely so this is possible to compensate at all -
       * a single combined step could not have a StepResponse to compensate
       * from if it never got past creating the rows.
       *
       * createReviewMedias is mocked to fail rather than using a synthetic
       * injected step standing in for it, because the earlier version of
       * this test did exactly that and it passed while the real
       * createReviewMediaRowsStep still had the bug the review caught: a
       * failure *inside* the real second step is the only thing that
       * actually proves the fix.
       */
      it('deletes the uploaded file when review-media row creation fails after a successful upload', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        let capturedFileId = ''
        jest.spyOn(service, 'createReviewMedias').mockImplementation(async (data: unknown) => {
          const rows = Array.isArray(data) ? data : [data]
          capturedFileId = (rows[0] as { file_id: string }).file_id
          throw new Error('forced row-creation failure')
        })

        await runAndExpectRejection(
          uploadReviewMediaWorkflow(container).run({
            input: {
              files: [
                { filename: 'photo.png', content: await pngBase64(), size_bytes: 100 },
              ],
            },
          }),
          'forced row-creation failure'
        )

        expect(capturedFileId).not.toBe('')

        // No row exists (createReviewMedias never actually succeeded), and
        // - the load-bearing assertion - no file exists either: the upload
        // step's own compensation must have deleted it.
        jest.restoreAllMocks()
        expect(await service.listReviewMedias({ file_id: capturedFileId })).toHaveLength(0)

        const fileService = container.resolve(Modules.FILE)
        await expect(fileService.getAsBuffer(capturedFileId)).rejects.toThrow()
      })
    })
  },
})
