import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { defineRouteConfig } from '@medusajs/admin-sdk'
import { CogSixTooth, Spinner } from '@medusajs/icons'
import { Button, Container, Heading, Input, Switch, Text, toast } from '@medusajs/ui'
import { sdk } from '../../../lib/sdk'

// Mirrors ReviewSettingsValues / REVIEW_SETTINGS_DEFAULTS in
// src/modules/review/settings-defaults.ts - that file, not the model, is
// the runtime source of truth per the brief. Kept in sync by hand, same
// convention as MAX_REPLY_LENGTH in reply-composer.tsx and MAX_BATCH_SIZE
// in review-table.tsx: the admin bundle and the module/API code are built
// and shipped separately, so there is no runtime import to share here.
type ReviewSettings = {
  enabled: boolean
  require_approval: boolean
  allow_guest: boolean
  verified_only: boolean
  allow_media: boolean
  allow_video: boolean
  max_media_per_review: number
  max_image_size_mb: number
  max_video_size_mb: number
  allow_edit: boolean
  one_review_per_customer: boolean
  min_content_length: number
  max_content_length: number
  gallery_enabled: boolean
}

type GetSettingsResponse = { settings: ReviewSettings }
type PostSettingsResponse = { settings: ReviewSettings }

type BooleanFieldKey =
  | 'enabled'
  | 'require_approval'
  | 'allow_guest'
  | 'verified_only'
  | 'allow_media'
  | 'allow_video'
  | 'allow_edit'
  | 'one_review_per_customer'
  | 'gallery_enabled'

type NumericFieldKey =
  | 'max_media_per_review'
  | 'max_image_size_mb'
  | 'max_video_size_mb'
  | 'min_content_length'
  | 'max_content_length'

// Exact bounds from UpdateReviewSettingsSchema in
// src/api/admin/reviews/middlewares.ts (`.strict()`, every field int with
// its own min/max) - read from that file, not guessed, so client-side
// validation rejects nothing the server would accept and accepts nothing
// the server would 400 on.
const NUMERIC_BOUNDS: Record<NumericFieldKey, { min: number; max: number }> = {
  max_media_per_review: { min: 0, max: 20 },
  max_image_size_mb: { min: 1, max: 50 },
  max_video_size_mb: { min: 1, max: 100 },
  min_content_length: { min: 0, max: 1000 },
  max_content_length: { min: 1, max: 20000 },
}

const NUMERIC_FIELD_KEYS = Object.keys(NUMERIC_BOUNDS) as NumericFieldKey[]

type Draft = {
  booleans: Record<BooleanFieldKey, boolean>
  numeric: Record<NumericFieldKey, string>
}

const SETTINGS_QUERY_KEY = ['admin-review-settings'] as const

const toDraft = (settings: ReviewSettings): Draft => ({
  booleans: {
    enabled: settings.enabled,
    require_approval: settings.require_approval,
    allow_guest: settings.allow_guest,
    verified_only: settings.verified_only,
    allow_media: settings.allow_media,
    allow_video: settings.allow_video,
    allow_edit: settings.allow_edit,
    one_review_per_customer: settings.one_review_per_customer,
    gallery_enabled: settings.gallery_enabled,
  },
  numeric: {
    max_media_per_review: String(settings.max_media_per_review),
    max_image_size_mb: String(settings.max_image_size_mb),
    max_video_size_mb: String(settings.max_video_size_mb),
    min_content_length: String(settings.min_content_length),
    max_content_length: String(settings.max_content_length),
  },
})

// Validates a single numeric field's raw text against the exact same
// bounds UpdateReviewSettingsSchema enforces server-side (int, inclusive
// min/max) - so a merchant gets an inline message here instead of a 400
// from Save.
const validateNumericField = (key: NumericFieldKey, raw: string): string | undefined => {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return 'Required'
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return 'Must be a whole number'
  }
  const value = Number(trimmed)
  const { min, max } = NUMERIC_BOUNDS[key]
  if (value < min || value > max) {
    return `Must be between ${min} and ${max}`
  }
  return undefined
}

type ToggleRowProps = {
  label: string
  help: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}

const ToggleRow = ({ label, help, checked, onCheckedChange, disabled }: ToggleRowProps) => (
  <div className="flex items-center justify-between gap-x-6 px-6 py-4">
    <div className="flex max-w-xl flex-col gap-y-1">
      <Text size="small" leading="compact" weight="plus">
        {label}
      </Text>
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {help}
      </Text>
    </div>
    <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
  </div>
)

type NumberRowProps = {
  label: string
  help: string
  value: string
  onChange: (value: string) => void
  error?: string
  bounds: { min: number; max: number }
  disabled?: boolean
}

const NumberRow = ({ label, help, value, onChange, error, bounds, disabled }: NumberRowProps) => (
  <div className="flex items-center justify-between gap-x-6 px-6 py-4">
    <div className="flex max-w-xl flex-col gap-y-1">
      <Text size="small" leading="compact" weight="plus">
        {label}
      </Text>
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {help}
      </Text>
      {error && (
        <Text size="xsmall" leading="compact" className="text-ui-fg-error">
          {error}
        </Text>
      )}
    </div>
    <Input
      type="number"
      className="w-24 shrink-0"
      min={bounds.min}
      max={bounds.max}
      step={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    />
  </div>
)

const SectionHeader = ({ title }: { title: string }) => (
  <div className="px-6 pt-4 pb-1">
    <Text size="small" leading="compact" weight="plus" className="text-ui-fg-subtle">
      {title}
    </Text>
  </div>
)

/**
 * The merchant's control panel for the whole plugin - every field
 * `review_settings` has, in one place, each with help text that says what
 * the setting actually does rather than just naming it.
 *
 * ## Loading (no `enabled` gate)
 * `settingsQuery` is a plain `useQuery` with no `enabled` condition tied to
 * any UI state - real settings (or a real error state) appear on first
 * paint and on every refresh, matching the "display query" rule the rest
 * of this admin surface already follows (review-table.tsx, the product
 * widget). A `Spinner` (from `@medusajs/icons` - `@medusajs/ui` has none)
 * covers the load.
 *
 * ## Seeding the draft without fighting a background refetch
 * `draft` (the editable booleans + numeric-field text) is local state,
 * seeded from `settingsQuery.data.settings` exactly once - tracked by
 * `seededRef` - not on every render `settingsQuery.data` happens to be
 * defined. This is the same seed-once-ref shape reply-composer.tsx uses
 * for `seededForId`/`content`: without it, a background refetch (e.g. on
 * window refocus, React Query's default) firing while a merchant is
 * mid-edit would silently overwrite fields they haven't saved yet. There
 * is no per-item id to key the guard on here (settings is a singleton row),
 * so the ref is a plain boolean rather than reply-composer's
 * "which id was I seeded for" - it only ever needs to fire once, ever, for
 * the lifetime of this mounted page.
 *
 * ## Save: reading the mutation's own result, not closed-over draft state
 * `saveMutation`'s `onSuccess` rebuilds the on-screen draft and the query
 * cache from `response.settings` - the server's own echo of what was just
 * saved - never from the `draft` state closed over at render time. This
 * matters for the same reason Task 10's reply mutation had to stop reading
 * `activeReviewId` from its closure (see reply-composer.tsx's own comment,
 * "Why mutation callbacks read `variables`..."): React Query re-points a
 * *pending* mutation's callbacks at whatever the latest render closed over,
 * so a callback that read `draft` here could, in principle, resync the
 * form to a stale mid-flight snapshot instead of what the server actually
 * has on file. Reading `response` sidesteps the whole class - it is the
 * mutation's own frozen result, not a render-time closure. Inputs are also
 * disabled while the save is in flight, so there is no window in which a
 * merchant could keep editing a field this callback is about to overwrite.
 *
 * ## Failure is never silent
 * `onError` toasts with the server's message when available. A settings
 * page that fails to save without telling the merchant is how "reviews are
 * live" and "reviews are disabled" quietly drift apart from what the admin
 * believes is configured.
 */
const ReviewSettingsPage = () => {
  const queryClient = useQueryClient()

  const settingsQuery = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => sdk.client.fetch<GetSettingsResponse>('/admin/reviews/settings'),
  })

  const [draft, setDraft] = useState<Draft | null>(null)
  const seededRef = useRef(false)

  useEffect(() => {
    if (seededRef.current || !settingsQuery.data) {
      return
    }
    setDraft(toDraft(settingsQuery.data.settings))
    seededRef.current = true
  }, [settingsQuery.data])

  const saveMutation = useMutation({
    mutationFn: (payload: ReviewSettings) =>
      sdk.client.fetch<PostSettingsResponse>('/admin/reviews/settings', {
        method: 'POST',
        body: payload,
      }),
    onSuccess: (response) => {
      // See this file's top comment ("Save: reading the mutation's own
      // result...") - `response` is the mutation's own frozen result, not
      // a closed-over render value.
      // The POST returns the settings the server just persisted, so this
      // write IS the fresh value - there is deliberately no
      // invalidateQueries() alongside it. An immediate background refetch
      // would add nothing on success and, if that one request happened to
      // fail, would swap the whole form for "Failed to load settings"
      // seconds after telling the merchant their save succeeded. Both
      // statements would be true and the pair reads as data loss.
      queryClient.setQueryData<GetSettingsResponse>(SETTINGS_QUERY_KEY, {
        settings: response.settings,
      })
      setDraft(toDraft(response.settings))
      toast.success('Settings saved')
    },
    onError: (error) => {
      // Silent failure here is exactly how a merchant ends up believing
      // reviews are configured one way when the server still has the old
      // values.
      toast.error('Failed to save settings', {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  const setBoolean = (key: BooleanFieldKey, value: boolean) => {
    setDraft((prev) => (prev ? { ...prev, booleans: { ...prev.booleans, [key]: value } } : prev))
  }

  const setNumeric = (key: NumericFieldKey, value: string) => {
    setDraft((prev) => (prev ? { ...prev, numeric: { ...prev.numeric, [key]: value } } : prev))
  }

  const numericErrors: Partial<Record<NumericFieldKey, string>> = {}
  if (draft) {
    for (const key of NUMERIC_FIELD_KEYS) {
      const error = validateNumericField(key, draft.numeric[key])
      if (error) {
        numericErrors[key] = error
      }
    }
  }
  const hasErrors = Object.keys(numericErrors).length > 0

  const handleSave = () => {
    if (!draft || hasErrors || saveMutation.isPending) {
      return
    }
    const payload: ReviewSettings = {
      ...draft.booleans,
      max_media_per_review: Number(draft.numeric.max_media_per_review),
      max_image_size_mb: Number(draft.numeric.max_image_size_mb),
      max_video_size_mb: Number(draft.numeric.max_video_size_mb),
      min_content_length: Number(draft.numeric.min_content_length),
      max_content_length: Number(draft.numeric.max_content_length),
    }
    saveMutation.mutate(payload)
  }

  const controlsDisabled = saveMutation.isPending
  const isLoading = settingsQuery.isLoading || (!draft && !settingsQuery.isError)

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Review settings</Heading>
        <Button
          size="small"
          onClick={handleSave}
          isLoading={saveMutation.isPending}
          disabled={!draft || hasErrors || saveMutation.isPending}
        >
          Save
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center px-6 py-16">
          <Spinner className="text-ui-fg-subtle animate-spin" />
        </div>
      ) : settingsQuery.isError || !draft ? (
        <div className="px-6 py-8">
          <Text size="small" leading="compact" className="text-ui-fg-error">
            Failed to load settings.{' '}
            <button type="button" className="underline" onClick={() => settingsQuery.refetch()}>
              Retry
            </button>
          </Text>
        </div>
      ) : (
        <>
          <div className="divide-y">
            <SectionHeader title="Availability" />
            <ToggleRow
              label="Enable reviews"
              help="Master switch for the whole feature. When off, shoppers cannot submit new reviews, and existing reviews stop showing on the storefront entirely - this hides already-approved reviews too, not just new submissions."
              checked={draft.booleans.enabled}
              onCheckedChange={(value) => setBoolean('enabled', value)}
              disabled={controlsDisabled}
            />
            <ToggleRow
              label="Require approval before publishing"
              help="New reviews are held as Pending until a moderator approves them. Turn off to publish new reviews immediately without moderation. Changing this does not retroactively affect reviews already submitted."
              checked={draft.booleans.require_approval}
              onCheckedChange={(value) => setBoolean('require_approval', value)}
              disabled={controlsDisabled}
            />
            <ToggleRow
              label="Allow guest reviews"
              help="Lets shoppers who are not signed in submit a review using a name and email. Turn off to require a customer account."
              checked={draft.booleans.allow_guest}
              onCheckedChange={(value) => setBoolean('allow_guest', value)}
              disabled={controlsDisabled}
            />
            <ToggleRow
              label="Verified purchasers only"
              help="Restricts reviews to signed-in customers whose purchase of the product can be confirmed - not just reviews without the verified badge. A guest-supplied email could belong to anyone, so a guest can never earn that verification; with this on, guest submissions are rejected outright rather than let through unbadged."
              checked={draft.booleans.verified_only}
              onCheckedChange={(value) => setBoolean('verified_only', value)}
              disabled={controlsDisabled}
            />
            <ToggleRow
              label="Limit to one review per customer"
              help="Prevents a signed-in customer from submitting more than one review for the same product. Does not apply to guest reviews, which are not tied to a customer account."
              checked={draft.booleans.one_review_per_customer}
              onCheckedChange={(value) => setBoolean('one_review_per_customer', value)}
              disabled={controlsDisabled}
            />
          </div>

          <div className="divide-y">
            <SectionHeader title="Content length" />
            <NumberRow
              label="Minimum review length (characters)"
              help="Shortest review text accepted."
              value={draft.numeric.min_content_length}
              onChange={(value) => setNumeric('min_content_length', value)}
              error={numericErrors.min_content_length}
              bounds={NUMERIC_BOUNDS.min_content_length}
              disabled={controlsDisabled}
            />
            <NumberRow
              label="Maximum review length (characters)"
              help="Longest review text accepted."
              value={draft.numeric.max_content_length}
              onChange={(value) => setNumeric('max_content_length', value)}
              error={numericErrors.max_content_length}
              bounds={NUMERIC_BOUNDS.max_content_length}
              disabled={controlsDisabled}
            />
          </div>

          <div className="divide-y">
            <SectionHeader title="Media" />
            <ToggleRow
              label="Allow photo attachments"
              help="Lets shoppers attach photos to their reviews, up to the limits below. Turning this off also blocks video, regardless of the video setting below."
              checked={draft.booleans.allow_media}
              onCheckedChange={(value) => setBoolean('allow_media', value)}
              disabled={controlsDisabled}
            />
            <ToggleRow
              label="Allow video attachments"
              help="Lets shoppers attach video in addition to photos. Has no effect while photo attachments (above) are off - that setting gates all media, video included."
              checked={draft.booleans.allow_video}
              onCheckedChange={(value) => setBoolean('allow_video', value)}
              disabled={controlsDisabled}
            />
            <NumberRow
              label="Max attachments per review"
              help="How many photo or video files can be attached to a single review."
              value={draft.numeric.max_media_per_review}
              onChange={(value) => setNumeric('max_media_per_review', value)}
              error={numericErrors.max_media_per_review}
              bounds={NUMERIC_BOUNDS.max_media_per_review}
              disabled={controlsDisabled}
            />
            <NumberRow
              label="Max photo file size (MB)"
              help="Largest photo file accepted per upload, in megabytes."
              value={draft.numeric.max_image_size_mb}
              onChange={(value) => setNumeric('max_image_size_mb', value)}
              error={numericErrors.max_image_size_mb}
              bounds={NUMERIC_BOUNDS.max_image_size_mb}
              disabled={controlsDisabled}
            />
            <NumberRow
              label="Max video file size (MB)"
              help="Largest video file accepted per upload, in megabytes. Values above 100 have no effect - uploads are capped at 100MB per file at the transport layer regardless of what's set here."
              value={draft.numeric.max_video_size_mb}
              onChange={(value) => setNumeric('max_video_size_mb', value)}
              error={numericErrors.max_video_size_mb}
              bounds={NUMERIC_BOUNDS.max_video_size_mb}
              disabled={controlsDisabled}
            />
            <ToggleRow
              label="Enable product photo gallery"
              help="Reserved for a store-wide customer photo gallery that has not shipped yet, so this setting has no visible effect on the storefront today - including the photos already shown on individual reviews, which are controlled by the photo and video settings above, not this one."
              checked={draft.booleans.gallery_enabled}
              onCheckedChange={(value) => setBoolean('gallery_enabled', value)}
              disabled={controlsDisabled}
            />
          </div>

          <div className="divide-y">
            <SectionHeader title="Editing" />
            <ToggleRow
              label="Allow customers to edit reviews"
              help="Not yet available - review editing has not shipped. This control is disabled so it can't be switched on and mistaken for a working feature; a customer cannot edit a submitted review regardless of this setting."
              checked={draft.booleans.allow_edit}
              onCheckedChange={(value) => setBoolean('allow_edit', value)}
              disabled
            />
          </div>
        </>
      )}
    </Container>
  )
}

export const config = defineRouteConfig({
  label: 'Review Settings',
  icon: CogSixTooth,
})

export default ReviewSettingsPage
