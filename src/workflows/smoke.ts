import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { SMOKE_MODULE } from '../modules/smoke'
import SmokeModuleService from '../modules/smoke/service'

/**
 * THROWAWAY — packaging smoke test only. Delete before v0.1.
 *
 * Proves the full packaged chain: a workflow shipped by the plugin resolves
 * the plugin's own module from the host container and writes to a table that
 * only exists if the plugin's migration ran in the host.
 */
type CreateSmokeInput = { note: string }

const createSmokeStep = createStep(
  'create-smoke',
  async (input: CreateSmokeInput, { container }) => {
    const service: SmokeModuleService = container.resolve(SMOKE_MODULE)
    const created = await service.createSmokes(input)

    return new StepResponse(created, created.id)
  },
  async (id: string | undefined, { container }) => {
    if (!id) {
      return
    }

    const service: SmokeModuleService = container.resolve(SMOKE_MODULE)
    await service.deleteSmokes(id)
  }
)

export const createSmokeWorkflow = createWorkflow(
  'create-smoke',
  (input: CreateSmokeInput) => {
    const created = createSmokeStep(input)

    return new WorkflowResponse(created)
  }
)
