import { model } from '@medusajs/framework/utils'

/**
 * THROWAWAY — packaging smoke test only. Delete before v0.1.
 *
 * Exists to prove that a model defined in this plugin produces a migration
 * that actually runs inside a host application after `plugin:add`. Replaced
 * by the real review models in Phase 1.
 */
export const Smoke = model.define('smoke', {
  id: model.id({ prefix: 'smk' }).primaryKey(),
  note: model.text(),
})
