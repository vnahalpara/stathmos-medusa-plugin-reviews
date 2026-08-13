import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { updateReviewSettingsStep } from './steps/update-review-settings'
import { ReviewSettingsValues } from '../modules/review/settings-defaults'

export const updateReviewSettingsWorkflow = createWorkflow(
  'update-review-settings',
  function (input: Partial<ReviewSettingsValues>) {
    const settings = updateReviewSettingsStep(input)

    emitEventStep({ eventName: 'review.settings.updated', data: {} })

    return new WorkflowResponse(settings)
  }
)
