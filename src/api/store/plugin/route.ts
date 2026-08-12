import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SMOKE_MODULE } from '../../../modules/smoke'
import SmokeModuleService from '../../../modules/smoke/service'
import { createSmokeWorkflow } from '../../../workflows/smoke'

/**
 * THROWAWAY — packaging smoke test only. Delete before v0.1.
 *
 * Writes through a workflow and reads back through the module service,
 * proving the whole chain works once packaged: the workflow is registered,
 * the module resolves from the host container, its migration has run in the
 * host database, and the route is mounted.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { result } = await createSmokeWorkflow(req.scope).run({
    input: { note: `packaged at ${new Date().toISOString()}` },
  })

  const smokeService: SmokeModuleService = req.scope.resolve(SMOKE_MODULE)
  const rows = await smokeService.listSmokes()

  res.json({
    ok: true,
    plugin: '@stathmos/medusa-plugin-reviews',
    created_id: result.id,
    rows: rows.length,
  })
}
