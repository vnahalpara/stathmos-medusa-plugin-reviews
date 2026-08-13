import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import {
  createStep,
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaStep } from '../../src/workflows/steps/upload-review-media'
import { UploadReviewMediaInput } from '../../src/workflows/upload-review-media'

async function pngBase64(): Promise<string> {
  const buf = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#00ff00' },
  })
    .png()
    .toBuffer()

  return buf.toString('base64')
}

/**
 * uploadReviewMediaWorkflow is a single step today, so there is no
 * downstream step in production whose failure would exercise
 * uploadReviewMediaStep's compensation. This test forces that shape
 * anyway - a later step failing after the upload step has committed - the
 * same way update-review-settings-compensation.spec.ts and
 * moderate-reviews-compensation.spec.ts do, so the compensation branch is
 * proven correct now rather than the first time a future task (e.g.
 * attaching media to a review) composes a real step after this one.
 *
 * R1: the compensation must delete both the review_media row AND the
 * uploaded file. Deleting only the row leaks bytes in object storage that
 * the Task 9 orphan sweep can never find, because that sweep only looks at
 * unattached *rows* - a row-less file is invisible to it.
 *
 * The injected failing step is given a data dependency on the upload
 * step's result (via `transform`), which both guarantees sequential
 * ordering deterministically (the engine cannot compute the transform
 * before uploadReviewMediaStep resolves) and lets the file id that must be
 * proven deleted travel out through the thrown error's message - the only
 * way to observe it, since the workflow promise rejects and `result` is
 * never returned to the caller.
 */
const alwaysFailAfterUpload = createStep(
  'always-fail-after-review-media-upload',
  async (input: { fileId: string }) => {
    throw new Error(`forced failure after upload: ${input.fileId}`)
  }
)

const workflowUnderTest = createWorkflow(
  'upload-review-media-compensation-test',
  function (input: UploadReviewMediaInput) {
    const result = uploadReviewMediaStep(input)

    alwaysFailAfterUpload(
      transform({ result }, (data) => ({ fileId: data.result.media[0].file_id }))
    )

    return new WorkflowResponse(result)
  }
)

async function runAndCaptureFailure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const message = (error as Error).message
    const match = message.match(/forced failure after upload: (\S+)/)
    expect(match).not.toBeNull()
    return (match as RegExpMatchArray)[1]
  }

  throw new Error('expected the workflow to reject, but it resolved')
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('uploadReviewMediaStep compensation', () => {
      it('deletes both the review_media row and the uploaded file when a later step fails', async () => {
        const container = getContainer()

        const fileId = await runAndCaptureFailure(
          workflowUnderTest(container).run({
            input: {
              files: [
                { filename: 'photo.png', content: await pngBase64(), size_bytes: 100 },
              ],
            },
          })
        )

        const service = container.resolve(REVIEW_MODULE)
        expect(await service.listReviewMedias({ file_id: fileId })).toHaveLength(0)

        // The load-bearing assertion for R1: not just an absent DB row, but
        // the bytes themselves gone from storage. Left behind, they would be
        // permanently unreachable - no row exists to point the orphan sweep
        // at them.
        const fileService = container.resolve(Modules.FILE)
        await expect(fileService.getAsBuffer(fileId)).rejects.toThrow()
      })
    })
  },
})
