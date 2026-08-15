const { MetadataStorage } = require('@medusajs/framework/mikro-orm/core')

MetadataStorage.clear()

// Task 2 (Phase 4): voterHash() (src/settings/voter-hash.ts) throws rather
// than silently defaulting when no salt is configured, and
// resolveVoteSalt() (src/settings/vote-salt.ts) never hands it a hardcoded
// one - that guard is deliberate, so a real deployment that forgets to
// configure a salt fails loudly instead of quietly sharing a hash across
// every store running this plugin.
//
// The integration suite still needs *some* salt for the guest-vote tests
// to exercise that real path rather than always hitting the guard, and it
// must come from tracked configuration, not the gitignored .env.test - a
// fresh clone or a CI job has no .env.test at all, and a value that only
// lives there makes every guest-vote test fail in exactly the environment
// this suite exists to protect, for a reason invisible in any diff. This
// file is already a tracked, always-loaded setupFiles hook, and it runs
// before medusa-config.ts is required (which is what reads this env var
// into the review module's options), so setting it here reaches the
// review module the same way a real operator's env var would.
//
// `||` so a local .env.test override (or a real CI secret) still wins if
// one is ever set - this is only a floor, and the value is deliberately
// not something that could pass for a production default.
process.env.REVIEW_VOTE_SALT =
  process.env.REVIEW_VOTE_SALT || 'integration-test-only-salt-do-not-use-in-production'
