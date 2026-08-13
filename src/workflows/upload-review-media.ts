import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { uploadReviewMediaStep } from './steps/upload-review-media'

export type UploadReviewMediaInput = {
  files: { filename: string; content: string; size_bytes: number }[]
}

export const uploadReviewMediaWorkflow = createWorkflow(
  'upload-review-media',
  function (input: UploadReviewMediaInput) {
    const result = uploadReviewMediaStep(input)

    return new WorkflowResponse(result)
  }
)
