import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { FetchError } from '@medusajs/js-sdk'
import { InformationCircle, Trash } from '@medusajs/icons'
import { Button, Prompt, Text, Textarea, toast } from '@medusajs/ui'
import { sdk } from '../../../lib/sdk'
import { AdminReviewStatus } from './review-table'

// Mirrors ReplyToReviewSchema in src/api/admin/reviews/middlewares.ts
// (`.strict()`, min 1, max 5000). Kept in sync by hand - the admin bundle
// and the API route are built and shipped separately, same convention as
// MAX_REJECTION_REASON_LENGTH in review-table.tsx.
const MAX_REPLY_LENGTH = 5000

type ReplyRecord = {
  content: string
  updated_at: string
}

type ReplyResponse = {
  reply: {
    id: string
    review_id: string
    content: string
    created_at: string
    updated_at: string
  }
}

type ReplyComposerProps = {
  // Display-only. Sourced from `liveReview.status` in review-drawer.tsx,
  // same as every other field this drawer displays - a one-render lag
  // behind `review` (see that file's own comment) is harmless for text
  // that only changes what a banner says, unlike `activeReviewId` below.
  status: AdminReviewStatus
  // The id both mutations below send AND the reset effect's dependency -
  // deliberately ReviewDrawer's RAW `review` prop (`review?.id`), not
  // `liveReview.id`. Two reasons, not one:
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
  //    never becomes undefined on close, so keying the reset effect
  //    below on this same value - not `liveReview.id` - is what makes a
  //    reopen of the SAME review reset this composer's draft exactly like
  //    every other piece of drawer-local state already does, instead of
  //    leaving stale text sitting in the textarea because "the id didn't
  //    change."
  //
  // Undefined while the drawer is closed - both mutation handlers guard
  // against that explicitly rather than assuming a click can't land then.
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
 * ## How this learns whether a reply already exists (the brief's open
 * question, answered honestly rather than invented)
 * There is no admin endpoint that reads a review's reply.
 * `GET /admin/reviews` never returns reply data (checked
 * `src/api/admin/reviews/route.ts` directly), and the only place a reply
 * is ever serialised is the STORE route
 * (`src/api/store/products/[id]/reviews/route.ts`), gated to approved
 * reviews only and architecturally the wrong place for an admin screen to
 * read from even when a review happens to be approved.
 *
 * This is the exact shape of gap Task 9 hit for media (see that task's
 * report and this file's own drawer comment for "Media: a genuine,
 * separate query") - and the brief for THIS task says explicitly: "if
 * that genuinely requires a backend addition, tell me rather than
 * inventing one." It does, so this component does not invent a GET
 * route. It does the next best thing: every mutation this component
 * performs (save, delete) updates `savedReply` from that mutation's own
 * response body, exactly like `liveReview` does for the review's core
 * fields - so within one open-drawer session, the composer's own writes
 * are always the source of truth for "unchanged" and for what's
 * currently live. What it CANNOT do is show a merchant a reply that was
 * written in an earlier session before this drawer was opened - the
 * composer starts empty every time, and says so plainly (see the notice
 * rendered above the textarea) rather than silently pretending "empty"
 * means "no reply exists." A merchant who saves over an actual existing
 * reply gets exactly the upsert behaviour the backend already documents
 * (`upsertReviewReply`'s own doc comment), just without a preview of what
 * they're overwriting - see task-10-report.md for the recommended fix
 * (a `GET /admin/reviews/:id/reply` route, trivial given
 * `service.listReviewReplies({ review_id })` already exists).
 *
 * ## Author line (spec decision #3)
 * The backend already enforces that the public author is the store's
 * name, never the replying admin's (`replied_by` never leaves
 * `src/api/store/products/[id]/reviews/route.ts`). This component shows
 * the SAME name the storefront will, fetched via
 * `sdk.admin.store.list()` - Medusa core's own admin API, not a custom
 * route, so this needs no backend addition either. No admin user
 * identity is read or displayed anywhere in this file.
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
  const [content, setContent] = useState('')
  const [savedReply, setSavedReply] = useState<ReplyRecord | null>(null)
  const [deletePromptOpen, setDeletePromptOpen] = useState(false)

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
    setSavedReply(null)
    setDeletePromptOpen(false)
  }, [activeReviewId])

  // Real, network-backed, but deliberately NOT re-fetched per review - the
  // store's name doesn't vary by which review is open, so there is
  // nothing here for the reset effect above to touch. This is the "local
  // query" this component introduces; it needs no invalidation from the
  // reply mutations below because neither of them can change a store's
  // name.
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
      sdk.client.fetch<ReplyResponse>(`/admin/reviews/${id}/reply`, {
        method: 'POST',
        body: { content: body },
      }),
    onSuccess: (response) => {
      // This mutation's own response is this component's only source of
      // truth for "what is currently saved" - see this file's top
      // comment for why there is no query to invalidate instead.
      setSavedReply({ content: response.reply.content, updated_at: response.reply.updated_at })
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
      setSavedReply(null)
      setContent('')
      setDeletePromptOpen(false)
      invalidateTable()
      toast.success('Reply deleted')
    },
    onError: (error) => {
      setDeletePromptOpen(false)
      // DELETE 404s when this review has no reply at all - a real
      // possibility given this component can never confirm one exists
      // before offering the button (see this file's top comment). Worth
      // a distinct message: "failed" reads as a server problem, while
      // this is just "there was nothing to delete."
      const description =
        error instanceof FetchError && error.status === 404
          ? 'This review has no reply to delete.'
          : error instanceof Error
            ? error.message
            : undefined
      toast.error('Failed to delete reply', { description })
    },
  })

  const trimmed = content.trim()
  const baseline = (savedReply?.content ?? '').trim()
  const saveDisabled = trimmed.length === 0 || trimmed === baseline || replyMutation.isPending

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

      <div className="flex items-start gap-x-1.5">
        <InformationCircle className="text-ui-fg-subtle mt-0.5 shrink-0" />
        <Text size="xsmall" leading="compact" className="text-ui-fg-subtle">
          This admin can't yet show a reply written in an earlier session - only what's saved or
          deleted right here, right now. If this review already has a reply, saving will replace
          it.
        </Text>
      </div>

      {status !== 'approved' && (
        <Text size="xsmall" leading="compact" className="text-ui-fg-subtle">
          {status === 'pending'
            ? "This review is pending. Your reply is saved but won't be visible to shoppers unless and until the review is approved."
            : "This review was rejected, so it is never shown to shoppers. Your reply is saved but stays hidden unless the review is later approved."}
        </Text>
      )}

      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Write a public reply to this review..."
        maxLength={MAX_REPLY_LENGTH}
        rows={4}
        disabled={replyMutation.isPending || deleteMutation.isPending}
      />

      <div className="flex items-center justify-end gap-x-2">
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
        <Button
          size="small"
          variant="secondary"
          disabled={!activeReviewId || saveDisabled || deleteMutation.isPending}
          isLoading={replyMutation.isPending}
          onClick={handleSave}
        >
          Save reply
        </Button>
      </div>

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
