import { Module } from '@medusajs/framework/utils'
import SmokeModuleService from './service'

/** THROWAWAY — packaging smoke test only. Delete before v0.1. */
export const SMOKE_MODULE = 'smoke'

export default Module(SMOKE_MODULE, {
  service: SmokeModuleService,
})
