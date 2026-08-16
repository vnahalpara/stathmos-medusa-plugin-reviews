/**
 * Options this plugin's `review` module receives at registration time.
 *
 * `voteSalt` is deliberately not part of `ReviewSettingsValues`
 * (settings-defaults.ts) even though both are "configuration": the values
 * in that type are merchant-editable at runtime through the admin settings
 * page and a DB row, while the salt is an operator/infra-level secret, the
 * same category as `JWT_SECRET`/`COOKIE_SECRET` in medusa-config.ts.
 * Changing it after votes exist would silently break dedup for every guest
 * voter who has not since logged in, so it belongs in deploy-time
 * configuration a merchant cannot reach through the UI, not a database row
 * a support ticket could talk someone into editing.
 */
export type ReviewModuleOptions = {
  voteSalt?: string
}

/**
 * Resolves the salt `voterHash()` needs to turn a guest's IP+UA into a
 * per-store pseudonymous dedup key (see `src/settings/voter-hash.ts`) -
 * checked in exactly one place so the one caller that needs it (the vote
 * route, via the review module service) gets a single, well-defined
 * precedence instead of re-deriving it inline.
 *
 * Plugin options win over the environment variable. A value set in
 * `options` - `modules: [{ resolve: './src/modules/review', options: {
 * voteSalt } }]` in this repo's own medusa-config.ts, or, for a real
 * install, a host's `plugins: [{ resolve:
 * '@stathmos/medusa-plugin-reviews', options: { voteSalt } }]` (which
 * @medusajs/utils's getResolvedPlugins() cascades onto every module the
 * plugin declares, unchanged) - is a decision visible in a diff.
 * `REVIEW_VOTE_SALT` is the fallback for an operator who would rather
 * manage it purely as a secret, the same way medusa-config.ts already
 * reads `JWT_SECRET`/`COOKIE_SECRET` straight from the environment.
 *
 * Returns `undefined` - never a hardcoded default string - when neither is
 * configured, and an empty-string option is treated as unset (falls
 * through to the env var) rather than as a deliberate empty salt: nothing
 * here should ever hand `voterHash()` a value that looks configured but
 * isn't. Silently defaulting to a constant would make every guest voter on
 * every store that never configured a salt hash identically, turning a
 * per-store pseudonym into a cross-site identifier - see voterHash()'s own
 * docstring. This function does not throw for a missing salt; the "fail
 * loudly" guarantee lives in voterHash() itself, which raises a
 * MedusaError the moment an empty/undefined salt actually reaches it. That
 * split matters: a store that only ever expects signed-in voters (whose
 * votes never call voterHash() at all) must not be broken by a salt nobody
 * configured, so failure is deferred to the one code path that actually
 * needs the value.
 */
export function resolveVoteSalt(
  options: ReviewModuleOptions | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return options?.voteSalt || env.REVIEW_VOTE_SALT || undefined
}
