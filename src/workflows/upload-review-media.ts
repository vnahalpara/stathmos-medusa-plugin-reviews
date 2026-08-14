import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { uploadReviewMediaFilesStep } from './steps/upload-review-media-files'
import { createReviewMediaRowsStep } from './steps/create-review-media-rows'

export type UploadReviewMediaInput = {
  files: { filename: string; content: string; size_bytes: number }[]
}

export const uploadReviewMediaWorkflow = createWorkflow(
  'upload-review-media',
  function (input: UploadReviewMediaInput) {
    const uploaded = uploadReviewMediaFilesStep(input)
    const result = createReviewMediaRowsStep(uploaded)

    return new WorkflowResponse(result)
  }
)
