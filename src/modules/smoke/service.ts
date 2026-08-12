import { MedusaService } from '@medusajs/framework/utils'
import { Smoke } from './models/smoke'

/** THROWAWAY — packaging smoke test only. Delete before v0.1. */
class SmokeModuleService extends MedusaService({ Smoke }) {}

export default SmokeModuleService
