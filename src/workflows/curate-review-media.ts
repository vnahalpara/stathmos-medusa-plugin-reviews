import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { setMediaCurationStep } from './steps/set-media-curation'

export type CurateReviewMediaInput = {
  id: string
  pinned?: boolean
  hidden?: boolean
}

export const curateReviewMediaWorkflow = createWorkflow(
  'curate-review-media',
  function (input: CurateReviewMediaInput) {
    const media = setMediaCurationStep(input)

    return new WorkflowResponse(media)
  }
)
