import { Module } from '@medusajs/framework/utils'
import ReviewModuleService from './service'

export const REVIEW_MODULE = 'review'

export default Module(REVIEW_MODULE, {
  service: ReviewModuleService,
})

// Registers ReviewModuleService against the container's cradle type so that
// `container.resolve(REVIEW_MODULE)` is typed everywhere without per-call-site
// annotations. Mirrors the pattern Medusa uses for its own built-in modules
// (see @medusajs/framework's container.d.ts augmentation of the same interface).
declare module '@medusajs/types' {
  interface ModuleImplementations {
    [REVIEW_MODULE]: ReviewModuleService
  }
}
