# Settings

All settings are read via `GET /admin/reviews/settings` and written
(partially — send only the fields you want to change) via
`POST /admin/reviews/settings`. Both are documented in full in
[api-reference.md](./api-reference.md#get-adminreviewssettings). Changes
take effect immediately, with no redeploy: the settings row is cached for
5 minutes (`REVIEW_SETTINGS_CACHE_KEY` in `src/settings/get-review-settings.ts`)
and that cache is invalidated on every successful write, so a merchant
never has to wait out the cache window after saving.

**There is no public (store-facing) settings read endpoint.** A
storefront cannot ask "is `allow_edit` on for this store?" in advance —
see [storefront-nextjs.md](./storefront-nextjs.md#review-ownership-for-the-edit-control-is-client-side)
for how the reference storefront works around this (it lets a mutating
request's own response be the settings check).

## The upgrade caveat: stored settings beat new defaults

**Read this before assuming a new default takes effect on an existing
store.** Settings are merged from a single stored row over
`REVIEW_SETTINGS_DEFAULTS` (`src/modules/review/settings-defaults.ts`):

```ts
export function mergeSettings(row) {
  if (!row) return { ...REVIEW_SETTINGS_DEFAULTS }
  const merged = { ...REVIEW_SETTINGS_DEFAULTS }
  for (const key of Object.keys(REVIEW_SETTINGS_DEFAULTS)) {
    const value = row[key]
    if (value !== undefined && value !== null) {
      merged[key] = value   // stored value wins, whatever the new default is
    }
  }
  return merged
}
```

A store that has **never** saved a settings row gets every current
default, including any that changed since it was installed. A store that
**has** saved settings at any point — even just once, on an earlier plugin
version — keeps every value it explicitly (or implicitly, via any past
save) stored, even after the plugin's own default for that field changes
in a later release. The only way to pick up a new default on an existing
store is for a merchant to explicitly set that field via
`POST /admin/reviews/settings` (or the bundled admin UI's settings page).

This is exactly what happened with `allow_edit` — see its own row below —
and it's worth internalizing as a general rule before you ship a settings
default change of your own: **existing stores do not silently inherit it.**

## All 14 settings

| Setting | Type | Default | Gates | Notes |
|---|---|---|---|---|
| `enabled` | boolean | `true` | Every `/store/*` review route | Master switch. `POST /store/reviews`, `GET /store/products/:id/reviews`, `GET /store/products/:id/reviews/stats`, `POST /store/reviews/uploads`, `POST /store/reviews/:id`, both vote routes, and `GET /store/reviews/gallery` all refuse (mostly 404, uploads and edit as 400/404 per their own rules) when this is off. |
| `require_approval` | boolean | `true` | New review status | New reviews start `pending` instead of `approved`. An auto-approving store (`false`) still emits `review.approved` on create — see [revalidation.md](./revalidation.md). |
| `allow_guest` | boolean | `false` | `POST /store/reviews` | Lets an unauthenticated shopper submit a review at all. Off ⇒ 401 for a guest. |
| `verified_only` | boolean | `false` | `POST /store/reviews` | **Read literally**: on, a guest submission is *rejected outright* (400), not merely accepted without a verified badge. Implies customers-only in practice, since a guest can never prove purchase. |
| `allow_media` | boolean | `true` | Media attach (upload + submit) | Off also blocks video, regardless of `allow_video`. Re-checked at *submission* time, not just upload time — turning this off stops media from reaching a review immediately, even for media uploaded (and still within its 24h orphan TTL) before the switch flipped. |
| `allow_video` | boolean | `true` | Media attach | Additional gate on top of `allow_media`; has no effect while `allow_media` is off. |
| `max_media_per_review` | integer | `5` | Media attach | 0–20. A **per-review** cap (already-attached count + incoming), enforced when media is *attached* — splitting an upload across several calls cannot exceed this. |
| `max_image_size_mb` | integer | `5` | Upload | 1–50. |
| `max_video_size_mb` | integer | `50` | Upload | 1–100. **Cannot be set above 100 — `POST /admin/reviews/settings` rejects it (400)**, matching the 100MB/file transport-layer ceiling: a value the schema allowed but the transport layer silently ignored would be a merchant-facing setting that lies about its own effect. |
| `allow_edit` | boolean | `true` | `POST /store/reviews/:id` | **See [below](#allow_edit) — the upgrade caveat applies directly to this field.** Guests can never edit, regardless of this setting. |
| `one_review_per_customer` | boolean | `true` | `POST /store/reviews` | A signed-in customer may submit only one review per product. |
| `min_content_length` | integer | `10` | Submit + edit | 0–1000. Enforced by the same function (`assertContentLengthWithinBounds`) on both create and edit, so the two can never independently drift on what "too short" means. |
| `max_content_length` | integer | `5000` | Submit + edit | 1–20000. |
| `gallery_enabled` | boolean | `true` | `GET /store/reviews/gallery` | Off ⇒ 404. Does **not** affect photos already shown on individual reviews (`allow_media`/`allow_video` govern those) — this only gates the dedicated gallery endpoint. Checked *after* the master `enabled` switch — reviews off takes the gallery down too, even with this still `true`. |

### `allow_edit`

The one setting with a genuinely tricky default history, worth its own
callout beyond the table above.

- **Default is `true`, but only for a fresh install that has never saved a
  settings row.** It shipped `false` in earlier phases of this plugin
  (before the edit feature existed at all — there was nothing to turn on),
  and the default only flipped to `true` once the edit workflow shipped.
- **A store that saved settings at any point before that change keeps its
  stored `false`.** Per the [upgrade caveat](#the-upgrade-caveat-stored-settings-beat-new-defaults)
  above, `mergeSettings()` copies the stored value over the new default
  unconditionally. That store's merchant must explicitly switch
  `allow_edit` on via `POST /admin/reviews/settings` or the settings page.
- **This is the safe outcome, not an oversight.** It's exactly what
  prevents the riskier `allow_edit: true` + `require_approval: false`
  pairing from ever appearing silently on an upgrade — a store only ends
  up with that combination by a merchant explicitly turning both settings
  on, never as a side effect of installing a new plugin version.
- A storefront cannot detect this state in advance (no public settings
  endpoint) — see [storefront-nextjs.md](./storefront-nextjs.md#review-ownership-for-the-edit-control-is-client-side)
  for how the reference storefront's edit control reacts to a `400` from
  the edit route instead of pre-checking the setting.

## Helpful-vote configuration is deliberately *not* here

`voteSalt` — the operator secret `sha256(ip + user-agent + salt)` uses for
guest vote dedup — is **not** one of the 14 settings above, and that's a
deliberate design choice, not a gap. It's configured via this plugin's own
`voteSalt` option in `medusa-config.ts`, or the `REVIEW_VOTE_SALT`
environment variable as a fallback (plugin option wins; an empty-string
option is treated as unset). It belongs in deploy-time configuration a
merchant cannot reach through the admin UI — the same category as
`JWT_SECRET`/`COOKIE_SECRET` — because:

1. It has no safe default. A hardcoded fallback would make every guest's
   `voter_hash` comparable across every installation of this plugin,
   turning a per-store pseudonym into a cross-site identifier.
2. Changing it after votes exist silently breaks dedup for every guest
   voter (a `voter_hash` computed under the old salt never matches one
   computed under a new salt) — the kind of one-way door a merchant
   should not be able to trigger from a settings form by accident.

See the [README's "Configuring the vote salt" section](../README.md#configuring-the-vote-salt)
for the full setup recipe, and
[storefront-nextjs.md](./storefront-nextjs.md#helpful-votes-must-be-cast-from-the-browser-never-from-a-server-action)
for why the salt alone doesn't make guest dedup safe to route through a
server action.

## Known limitation: multi-product bulk moderation and settings

Not a settings field, but adjacent enough to note here since it interacts
with `require_approval`: `POST /admin/reviews/batch/status` recomputes the
public rating summary for only the **first** product among the batch's
reviews (see [api-reference.md](./api-reference.md#post-adminreviewsbatchstatus)).
A batch scoped to one product — the normal admin-UI case — is unaffected;
a batch spanning multiple products leaves every product after the first
stale until its next write, independent of any setting. A host running
the [revalidation recipe](./revalidation.md) should read
[this interaction](./revalidation.md#known-interaction-batch-moderation-across-products-makes-this-recipe-re-cache-a-stale-summary)
specifically — revalidating doesn't just fail to fix the staleness here,
it re-caches it.
