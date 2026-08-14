import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { InformationCircle, Trash } from '@medusajs/icons'
import { Button, Prompt, Text, Textarea, toast } from '@medusajs/ui'
import { sdk } from '../../../lib/sdk'
import { AdminReviewStatus } from './review-table'

// Mirrors ReplyToReviewSchema in src/api/admin/reviews/middlewares.ts
// (`.strict()`, min 1, max 5000). Kept in sync by hand - the admin bundle
// and the API route are built and shipped separately, same convention as
// MAX_REJECTION_REASON_LENGTH in review-table.tsx.
const MAX_REPLY_LENGTH = 5000

// Matches the allow-listed shape both GET and POST
// src/api/admin/reviews/[id]/reply/route.ts return - deliberately no
// `replied_by` field to even type against (spec decision #3; see that
// route's own comment).
type ReplyRecord = {
  id: string
  review_id: string
  content: string
  created_at: string
  updated_at: string
}

type ReplyGetResponse = { reply: ReplyRecord | null }
type ReplyPostResponse = { reply: ReplyRecord }

type ReplyComposerProps = {
  // Display-only. Sourced from `liveReview.status` in review-drawer.tsx,
  // same as every other field this drawer displays - a one-render lag
  // behind `review` (see that file's own comment) is harmless for text
  // that only changes what a banner says, unlike `activeReviewId` below.
  status: AdminReviewStatus
  // The id both the query and both mutations below use, AND the reset
  // effect's dependency - deliberately ReviewDrawer's RAW `review` prop
  // (`review?.id`), not `liveReview.id`. Two reasons, not one:
  //
  // 1. Task 9's own review (Important 2, task-9-review.md) flagged
  //    exactly this pattern - a mutation reading `liveReview.id` (state,
  //    updated by an effect that runs one render after `review` itself
  //    changes) instead of the prop that is synchronously current - as a
  //    fragility no reachable exploit was found for, but that the
  //    reviewer fixed anyway rather than rely on "nobody can click that
  //    fast." Reading `review?.id` directly here, at the moment
  //    `.mutate()` is actually called, closes the same class of gap
  //    before it needs a review round to catch it.
  // 2. ReviewDrawer's own reset effect is keyed on `review?.id`
  //    specifically because it passes through `undefined` on every close
  //    (see that file's comment: "closing... id -> undefined... and any
  //    subsequent open... are both dependency changes"). `liveReview.id`
  //    never becomes undefined on close, so keying this component's own
  //    reset effect and query on this same value - not `liveReview.id` -
  //    is what makes a reopen of the SAME review reset the draft AND
  //    re-fetch its reply, exactly like every other piece of
  //    drawer-local state already resets on the same transition.
  //
  // Undefined while the drawer is closed - the query is gated on it and
  // both mutation handlers guard against it explicitly rather than
  // assuming a click can't land then.
  activeReviewId: string | undefined
  // The table-invalidating function ReviewDrawer already exports for this
  // purpose (see its own `invalidateTable` for the exact query key it
  // matches) - reused here rather than re-implementing the same
  // `invalidateQueries` call a second time.
  invalidateTable: () => void
}

/**
 * The merchant's reply composer - write, edit, and delete the public
 * response to a review. Mounted in the Task 9 seam inside
 * review-drawer.tsx's `Drawer.Body`.
 *
 * ## How this learns whether a reply already exists
 * `GET /admin/reviews/:id/reply` (added for this task - see that route's
 * own comment) returns `{ reply: null }` with a 200 when the review has
 * none, or the allow-listed reply otherwise. `replyQuery` below is a
 * real, network-backed query keyed on `activeReviewId`, and its cache
 * entry - not a separate piece of local state - is this component's one
 * source of truth for both "what is the current baseline for the
 * unchanged-check" and "does a reply exist at all" (`hasReply` below).
 * Both mutations write their own result straight into that same cache
 * entry (`queryClient.setQueryData`) before also invalidating it for a
 * real refetch - the same two-step Task 9's `deleteMediaMutation` already
 * uses for `['admin-review-media', id]`: instant, no flash of stale data,
 * *and* a real network-backed invalidate, not just a local patch that
 * could drift from the server.
 *
 * ## Why the query has an `enabled` gate despite "load on mount with no
 * enabled tied to UI state"
 * That phrasing (review-table.tsx's own comment) describes a *top-level*
 * query that must show real data immediately when its page mounts - it
 * is not, and was never meant as, a ban on gating a query that is
 * structurally meaningless without an id to fetch. `activeReviewId` can
 * be `undefined` (drawer closed), and there is no `/admin/reviews/undefined/reply`
 * to call. `enabled: !!activeReviewId` here is the exact same "modal-only
 * data" gate `mediaQuery` already uses one level up in review-drawer.tsx
 * (`enabled: review !== null`) for the identical reason - it does not
 * defer loading behind any further UI interaction (a click, a focus, a
 * scroll); it fires the instant this component has an id to fetch for,
 * same as `mediaQuery` does.
 *
 * ## Seeding the draft without fighting the merchant's own typing
 * `content` is separate local state (it must be editable), seeded from
 * `replyQuery.data.reply.content` exactly once per review - tracked by
 * `seededForId` - rather than on every render `replyQuery.data` happens
 * to be defined. Without that guard, a background refetch (e.g. on
 * window refocus, React Query's default) firing while a merchant is
 * mid-edit would silently overwrite what they were typing with whatever
 * the server still has on file. The guard is reset alongside everything
 * else in the effect below, so a genuine review switch (or a same-review
 * reopen after a close) always re-seeds from fresh data.
 *
 * ## Author line (spec decision #3)
 * The backend already enforces that the public author is the store's
 * name, never the replying admin's (`replied_by` never leaves
 * `src/api/store/products/[id]/reviews/route.ts`, and is now also
 * confirmed absent from `GET /admin/reviews/:id/reply`'s own response -
 * see that route's comment and its dedicated test). This component shows
 * the SAME name the storefront will, fetched via
 * `sdk.admin.store.list()` - Medusa core's own admin API, not a custom
 * route. No admin user identity is read or displayed anywhere in this
 * file.
 *
 * ## Non-approved reviews (requirement 6)
 * Rejecting a review deletes its media but NOT its reply (confirmed by
 * reading `deleteMediaForRejectedReviews` and the reject workflow - reply
 * deletion is never in that step list). A reply therefore can exist, and
 * be freely edited, on a pending or rejected review - but the store route
 * only ever serves a reply whose PARENT review is `approved`
 * (`listVisibleReviewReplies`). Decision: allow writing/saving/deleting a
 * reply regardless of status (a merchant drafting a response before
 * approving the review is a reasonable workflow), but say plainly, above
 * the textarea, that the reply will not be visible to shoppers until the
 * review is approved - never leave that ambiguous.
 */
const ReplyComposer = ({ status, activeReviewId, invalidateTable }: ReplyComposerProps) => {
  const queryClient = useQueryClient()
  const [content, setContent] = useState('')
  const [deletePromptOpen, setDeletePromptOpen] = useState(false)
  // Which review's reply `content` currently reflects - not review state
  // itself, just a guard so the seeding effect below only overwrites the
  // draft once per review rather than on every background refetch. See
  // this file's top comment ("Seeding the draft...").
  const seededForId = useRef<string | undefined>(undefined)

  const replyQueryKey = ['admin-review-reply', activeReviewId]
  const replyQuery = useQuery({
    queryKey: replyQueryKey,
    queryFn: () => sdk.client.fetch<ReplyGetResponse>(`/admin/reviews/${activeReviewId}/reply`),
    // See this file's top comment for why this gate is not the thing
    // "no enabled tied to UI state" warns against.
    enabled: !!activeReviewId,
  })
  const savedReply = replyQuery.data?.reply ?? null
  const hasReply = savedReply !== null

  useEffect(() => {
    // Same guard as ReviewDrawer's own reset effect: skip on close (the
    // drawer's exit animation should keep showing whatever was last
    // rendered, not flash to empty), but reset fully on every transition
    // INTO a review - a different one, or the same one reopened after a
    // close - see `activeReviewId`'s own doc comment above for why that's
    // the dependency that guarantees this.
    if (!activeReviewId) {
      return
    }
    setContent('')
    setDeletePromptOpen(false)
    seededForId.current = undefined
  }, [activeReviewId])

  useEffect(() => {
    // Seeds the draft from the fetched reply exactly once per review -
    // see this file's top comment for why `seededForId` exists at all.
    if (!activeReviewId || replyQuery.data === undefined) {
      return
    }
    if (seededForId.current === activeReviewId) {
      return
    }
    setContent(replyQuery.data.reply?.content ?? '')
    seededForId.current = activeReviewId
  }, [activeReviewId, replyQuery.data])

  // Real, network-backed, but deliberately NOT re-fetched per review and
  // NOT invalidated by either mutation below - the store's name doesn't
  // vary by which review is open or by anything a reply mutation could
  // change.
  const storeQuery = useQuery({
    queryKey: ['admin-store-name'],
    queryFn: async () => {
      const { stores } = await sdk.admin.store.list({ limit: 1 })
      return stores[0]?.name ?? 'Store'
    },
  })
  const storeName = storeQuery.data ?? 'Store'

  const replyMutation = useMutation({
    mutationFn: ({ id, content: body }: { id: string; content: string }) =>
      sdk.client.fetch<ReplyPostResponse>(`/admin/reviews/${id}/reply`, {
        method: 'POST',
        body: { content: body },
      }),
    onSuccess: (response) => {
      // Instant local update (no flash of the pre-save state while a
      // refetch is in flight) AND a real invalidate - same two-step
      // `deleteMediaMutation` already uses for `['admin-review-media', id]`
      // in review-drawer.tsx.
      queryClient.setQueryData<ReplyGetResponse>(replyQueryKey, { reply: response.reply })
      queryClient.invalidateQueries({ queryKey: replyQueryKey })
      setContent(response.reply.content)
      invalidateTable()
      toast.success('Reply saved')
    },
    onError: (error) => {
      // A silent failure here is the one this brief calls out by name -
      // it would leave a merchant believing a public response was
      // published when it was not.
      toast.error('Failed to save reply', {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      sdk.client.fetch<{ id: string; object: string; deleted: boolean }>(
        `/admin/reviews/${id}/reply`,
        { method: 'DELETE' }
      ),
    onSuccess: () => {
      queryClient.setQueryData<ReplyGetResponse>(replyQueryKey, { reply: null })
      queryClient.invalidateQueries({ queryKey: replyQueryKey })
      setContent('')
      setDeletePromptOpen(false)
      invalidateTable()
      toast.success('Reply deleted')
    },
    onError: (error) => {
      setDeletePromptOpen(false)
      toast.error('Failed to delete reply', {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  const trimmed = content.trim()
  const baseline = (savedReply?.content ?? '').trim()
  const saveDisabled =
    !activeReviewId ||
    replyQuery.isLoading ||
    trimmed.length === 0 ||
    trimmed === baseline ||
    replyMutation.isPending

  const handleSave = () => {
    // `activeReviewId` read here, at the moment of the click, not
    // captured earlier - see this file's top prop doc comment for why
    // that specific timing is what matters.
    if (!activeReviewId || saveDisabled) {
      return
    }
    replyMutation.mutate({ id: activeReviewId, content: trimmed })
  }

  const handleConfirmDelete = () => {
    if (!activeReviewId) {
      return
    }
    deleteMutation.mutate(activeReviewId)
  }

  return (
    <div className="flex flex-col gap-y-2">
      <div className="flex items-center justify-between">
        <Text size="small" leading="compact" weight="plus">
          Merchant reply
        </Text>
        {/*
          Spec decision #3: the store's name, never the signed-in admin
          user's - see this file's top comment. No admin identity is read
          anywhere in this component.
        */}
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          Replying as {storeName}
        </Text>
      </div>

      {status !== 'approved' && (
        <div className="flex items-start gap-x-1.5">
          <InformationCircle className="text-ui-fg-subtle mt-0.5 shrink-0" />
          <Text size="xsmall" leading="compact" className="text-ui-fg-subtle">
            {status === 'pending'
              ? "This review is pending. Your reply is saved but won't be visible to shoppers unless and until the review is approved."
              : "This review was rejected, so it is never shown to shoppers. Your reply is saved but stays hidden unless the review is later approved."}
          </Text>
        </div>
      )}

      {replyQuery.isLoading ? (
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          Loading reply…
        </Text>
      ) : replyQuery.isError ? (
        // A genuine error state, not "no reply" - keeping these visually
        // distinct matters for the same reason review-drawer.tsx's own
        // media error state does: a blank composer could otherwise mean
        // either "nobody has replied" or "failed to load," and a
        // merchant shouldn't have to guess which before deciding whether
        // to write one.
        <Text size="small" leading="compact" className="text-ui-fg-error">
          Failed to load reply.{' '}
          <button type="button" className="underline" onClick={() => replyQuery.refetch()}>
            Retry
          </button>
        </Text>
      ) : (
        <>
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Write a public reply to this review..."
            maxLength={MAX_REPLY_LENGTH}
            rows={4}
            disabled={replyMutation.isPending || deleteMutation.isPending}
          />

          <div className="flex items-center justify-end gap-x-2">
            {/*
              Only offered once the fetched reply confirms one exists -
              GET /admin/reviews/:id/reply closed the gap that used to
              force this button to be offered unconditionally with a
              friendly 404 fallback.
            */}
            {hasReply && (
              <Button
                size="small"
                variant="danger"
                disabled={!activeReviewId || deleteMutation.isPending || replyMutation.isPending}
                isLoading={deleteMutation.isPending}
                onClick={() => setDeletePromptOpen(true)}
              >
                <Trash />
                Delete reply
              </Button>
            )}
            <Button
              size="small"
              variant="secondary"
              disabled={saveDisabled || deleteMutation.isPending}
              isLoading={replyMutation.isPending}
              onClick={handleSave}
            >
              Save reply
            </Button>
          </div>
        </>
      )}

      <Prompt open={deletePromptOpen} onOpenChange={setDeletePromptOpen}>
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>Delete this reply</Prompt.Title>
            <Prompt.Description>
              This removes your public response from the review. Shoppers will no longer see it.
              This cannot be undone.
            </Prompt.Description>
          </Prompt.Header>
          <Prompt.Footer>
            <Prompt.Cancel disabled={deleteMutation.isPending}>Cancel</Prompt.Cancel>
            <Prompt.Action disabled={deleteMutation.isPending} onClick={handleConfirmDelete}>
              Delete
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </div>
  )
}

export default ReplyComposer
