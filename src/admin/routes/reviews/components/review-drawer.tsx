import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeSlashMini, PinTackSolid, PlaySolid, Trash } from '@medusajs/icons'
import { Badge, Button, Drawer, Heading, IconButton, Prompt, Text, Textarea, toast } from '@medusajs/ui'
import { sdk } from '../../../lib/sdk'
import { formatStars } from '../../../lib/format'
import { AdminReview, MAX_REJECTION_REASON_LENGTH, STATUS_BADGE_COLOR } from './review-table'
import MediaLightbox, { ReviewMediaItem } from './media-lightbox'
import ReplyComposer from './reply-composer'

type ReviewDrawerProps = {
  // The row the table already fetched, or null when the drawer is closed.
  // See review-table.tsx's ReviewTableProps comment for why this is a full
  // row and not just an id: GET /admin/reviews has no single-review-by-id
  // endpoint, so there is nothing else to fetch this from.
  review: AdminReview | null
  onClose: () => void
}

const DetailField = ({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) => (
  <div className="flex flex-col gap-y-1">
    <Text size="small" leading="compact" weight="plus">
      {label}
    </Text>
    <Text size="small" leading="compact" className={mono ? 'text-ui-fg-subtle font-mono' : 'text-ui-fg-subtle'}>
      {value}
    </Text>
  </div>
)

/**
 * Detail drawer for a single review - full content, moderation actions, and
 * a media strip/lightbox. Opened from ReviewTable's `onSelect(row)`.
 *
 * ## How this is populated (no GET /admin/reviews/:id exists)
 * The brief flagged this directly: there is no single-review GET endpoint,
 * and adding one was explicitly out of scope for this task ("do not invent
 * an endpoint - tell me"). This drawer is fed the row the table already
 * fetched via `onSelect`, which - because GET /admin/reviews returns full
 * review records with no allow-list (see that route's own comment) -
 * already carries every field this drawer shows except the media itself.
 *
 * ## Why there is still no `['admin-review', id]` query for the review's OWN fields
 * Requirement: "invalidate both the drawer's own query and
 * ['admin-reviews']". This applies to the media query below (a real,
 * network-backed query - see "Media" below). It does NOT apply to the
 * review's own content/status/etc: there is still no GET-by-id for a
 * single review's core fields (only its media gained an endpoint this
 * round), so nothing exists to refetch those from. What plays that role
 * is `liveReview`: local state seeded from the `review` prop and
 * overwritten with the exact response body of each mutation (approve/
 * reject both return the field(s) that changed). That is strictly fresher
 * than an invalidate+refetch would be, since there is no round trip and
 * therefore nothing to race against. `['admin-reviews']` IS a real query
 * (review-table.tsx's own `useQuery`) and is invalidated for real below,
 * by the same key prefix that table uses.
 *
 * ## Media: a genuine, separate query
 * GET /admin/reviews returns `media_count` (Task 7) only, never the media
 * rows themselves - closed by adding GET /admin/reviews/:id/media (see
 * that route's own comment for why it deliberately includes media a
 * moderator has already hidden). `mediaQuery` below is a real
 * network-backed query, gated `enabled: review !== null` - the documented
 * "modal-only data" exception to "queries load on mount unconditionally",
 * since this data is meaningless with no review selected. Its own key
 * (`['admin-review-media', id]`) is invalidated after a delete, same as
 * `['admin-reviews']` is for the table.
 *
 * The lightbox and the media strip both mark hidden items visibly (a
 * small "Hidden from shoppers" badge) rather than showing a hidden photo
 * indistinguishably from a visible one - a moderator needs to know which
 * is which before deciding whether to also un-hide or delete it. Task 6
 * adds the same treatment for `pinned_at` and adds `curateMediaMutation`
 * (Pin/Unpin, Hide/Unhide from the lightbox) alongside it - see that
 * mutation's own top comment for why its cache key is built from
 * `variables`, not from `review`/`liveReview` the way this file's other
 * mutations read `review` at click time but never inside `onSuccess`.
 *
 * ## No cross-review state leaks (the Task 8 bug, one layer up)
 * Task 8 shipped a bug where `rowSelection` outlived a tab/search change
 * and caused a bulk action on rows the merchant could no longer see. The
 * equivalent risk here is a pending rejection reason, an open lightbox, or
 * a pending media-delete confirmation surviving a switch from review A to
 * review B. The effect below resets every piece of this drawer's local
 * state whenever the SELECTED REVIEW'S OWN ID changes (not on every
 * re-render, and not when merely closing) - see its comment for exactly
 * why that dependency is what makes the guarantee hold.
 */
const ReviewDrawer = ({ review, onClose }: ReviewDrawerProps) => {
  const queryClient = useQueryClient()

  const [liveReview, setLiveReview] = useState<AdminReview | null>(review)
  const [rejectPromptOpen, setRejectPromptOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [mediaPendingDelete, setMediaPendingDelete] = useState<ReviewMediaItem | null>(null)

  // Modal-only data - the documented exception to "queries load on mount
  // unconditionally": this data is meaningless with no review selected,
  // and gating it here (rather than always querying with a possibly-null
  // id) avoids a request that can never succeed. Query-cache keying on
  // `review?.id` already means switching reviews can never show A's media
  // under B's id - each id gets its own cache entry - so this query needs
  // no help from the reset effect below to avoid a cross-review leak.
  const mediaQuery = useQuery({
    queryKey: ['admin-review-media', review?.id],
    queryFn: () => sdk.client.fetch<{ media: ReviewMediaItem[] }>(`/admin/reviews/${review!.id}/media`),
    enabled: review !== null,
  })
  const mediaItems = mediaQuery.data?.media ?? []

  useEffect(() => {
    // Only resets when the review's id actually changes - not on a bare
    // parent re-render (which would otherwise wipe an in-progress
    // rejection reason on every keystroke elsewhere in the app) and not on
    // close (`review` going to null): closing leaves `liveReview` showing
    // its last content while the Drawer's own exit animation plays, which
    // is a closing panel, not a leak into a different review. The
    // guarantee that matters - a *reopen* is always clean, whether on a
    // different review or the same one again - holds because closing
    // (id -> undefined) and any subsequent open (undefined -> id, or
    // id -> a different id) are both dependency changes, so this always
    // re-runs, and re-runs fully, before the drawer is visible again.
    //
    // mediaItems is NOT reset here - it isn't local state, it's derived
    // from mediaQuery, which is already scoped per-review by its own
    // query key (see the query above). lightboxIndex/mediaPendingDelete
    // ARE reset: they're indices/references into whatever media array is
    // currently rendered, and must not be reinterpreted against a
    // different review's array after a switch.
    if (!review) {
      return
    }

    setLiveReview(review)
    setRejectPromptOpen(false)
    setRejectReason('')
    setLightboxIndex(null)
    setMediaPendingDelete(null)
    // Deliberately keyed on review?.id only, not the whole `review` object -
    // see the comment above this effect for why re-running on every parent
    // re-render would be wrong.
  }, [review?.id])

  const invalidateTable = () => {
    // Matches review-table.tsx's own query key
    // (`['admin-reviews', filters.status, filters.product_id, search,
    // limit, offset]`) by prefix - invalidateQueries defaults to a prefix
    // match, so this refreshes the table no matter which tab/search/page
    // it currently shows. A near-miss key here (e.g. a typo, or
    // `['admin-review']` singular) would silently fail to refresh it.
    queryClient.invalidateQueries({ queryKey: ['admin-reviews'] })
  }

  const approveMutation = useMutation({
    mutationFn: (id: string) =>
      sdk.client.fetch<{ review: AdminReview }>(`/admin/reviews/${id}/approve`, {
        method: 'POST',
      }),
    onSuccess: (response) => {
      setLiveReview((prev) => (prev ? { ...prev, ...response.review } : prev))
      invalidateTable()
      toast.success('Review approved')
    },
    onError: (error) => {
      toast.error('Failed to approve review', {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  const rejectMutation = useMutation({
    mutationFn: ({ id, rejection_reason }: { id: string; rejection_reason?: string }) =>
      sdk.client.fetch<{ review: AdminReview }>(`/admin/reviews/${id}/reject`, {
        method: 'POST',
        body: { rejection_reason },
      }),
    onSuccess: (response) => {
      setLiveReview((prev) => (prev ? { ...prev, ...response.review } : prev))
      // Rejecting hard-deletes ALL of this review's media server-side
      // (deleteMediaForRejectedReviews, in the same request). No
      // liveReview.media_count bookkeeping needed here - nothing displays
      // that field anymore (see the comment above the "Media" heading
      // below) - but the media QUERY itself must be cleared, or it would
      // keep showing photos the server already destroyed until something
      // else happened to invalidate it. Clear the cache immediately (no
      // flash of stale photos) and invalidate for real, exactly like
      // deleteMediaMutation does below.
      queryClient.setQueryData<{ media: ReviewMediaItem[] }>(['admin-review-media', review?.id], {
        media: [],
      })
      queryClient.invalidateQueries({ queryKey: ['admin-review-media', review?.id] })
      invalidateTable()
      setRejectPromptOpen(false)
      toast.success('Review rejected')
    },
    onError: (error) => {
      toast.error('Failed to reject review', {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  const deleteMediaMutation = useMutation({
    mutationFn: (mediaId: string) =>
      sdk.client.fetch<{ id: string; deleted: boolean }>(`/admin/reviews/media/${mediaId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_response, mediaId) => {
      // Instant local update (no flash of the just-deleted item while a
      // refetch is in flight) AND a real invalidate, per the brief's "on
      // any mutation, invalidate... the drawer's own query" - this one has
      // an actual network-backed query to invalidate, unlike the review's
      // own core fields (see this file's top comment).
      queryClient.setQueryData<{ media: ReviewMediaItem[] }>(
        ['admin-review-media', review?.id],
        (prev) => (prev ? { media: prev.media.filter((item) => item.id !== mediaId) } : prev)
      )
      queryClient.invalidateQueries({ queryKey: ['admin-review-media', review?.id] })
      // No liveReview.media_count bookkeeping here - the displayed count is
      // now derived entirely from mediaQuery's own data (see the comment
      // above the "Media" heading below), so there's nothing left that
      // needs it kept in sync.
      setMediaPendingDelete(null)
      invalidateTable()
      toast.success('Media deleted')
    },
    onError: (error) => {
      toast.error('Failed to delete media', {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  // Task 6: Pin/Unpin and Hide/Unhide from the lightbox, through Task 5's
  // POST /admin/reviews/media/:id/curation.
  //
  // Variables carry `reviewId` explicitly (not just the media `id`) so
  // this mutation's callback can build its cache key from `variables`,
  // never from the closed-over `review`/`liveReview` state - the exact bug
  // class reply-composer.tsx's top comment documents at length ("Why
  // mutation callbacks read `variables`"): MediaLightbox has no `key` and
  // stays mounted across a review switch (it is rendered unconditionally
  // at the bottom of this component, same as ReplyComposer), so React
  // Query re-points a still-pending mutation's onSuccess at whatever
  // review is open at the LATEST render, not the one open when `.mutate()`
  // was called. Curate a photo on review A, switch to review B before the
  // request settles, and a closure-based key would write A's curation
  // result into B's cache entry - silently attributing a curation change
  // to the wrong review's media strip.
  const curateMediaMutation = useMutation({
    mutationFn: ({
      id,
      pinned,
      hidden,
    }: {
      id: string
      reviewId: string
      pinned?: boolean
      hidden?: boolean
    }) =>
      sdk.client.fetch<{
        media: { id: string; pinned_at: string | null; hidden_at: string | null }
      }>(`/admin/reviews/media/${id}/curation`, {
        method: 'POST',
        body: { pinned, hidden },
      }),
    onSuccess: (response, variables) => {
      // Built from `variables.reviewId`, per this mutation's own top
      // comment - always correct for the review the request was actually
      // made against, even if the merchant has since navigated away.
      const key = ['admin-review-media', variables.reviewId] as const
      queryClient.setQueryData<{ media: ReviewMediaItem[] }>(key, (prev) =>
        prev
          ? {
              media: prev.media.map((item) =>
                item.id === variables.id
                  ? {
                      ...item,
                      pinned_at: response.media.pinned_at,
                      hidden_at: response.media.hidden_at,
                    }
                  : item
              ),
            }
          : prev
      )
      queryClient.invalidateQueries({ queryKey: key })
      // media_count is unaffected by curation (pin/hide never changes how
      // many rows are attached), but the table's own columns don't depend
      // on curation state either - this matches deleteMediaMutation's
      // "always invalidate the table too" posture rather than trying to
      // reason about whether this particular change is visible there.
      invalidateTable()

      const label =
        variables.hidden !== undefined
          ? variables.hidden
            ? 'Media hidden from shoppers'
            : 'Media made visible again'
          : variables.pinned
            ? 'Media pinned to the gallery'
            : 'Media unpinned from the gallery'
      toast.success(label)
    },
    onError: (error) => {
      toast.error('Failed to update media curation', {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  const isMutating = approveMutation.isPending || rejectMutation.isPending

  const openRejectPrompt = () => {
    setRejectReason('')
    setRejectPromptOpen(true)
  }

  // Both mutate calls read `review` (the prop), not `liveReview`. `review`
  // is always current; `liveReview` lags it by one render, since the reset
  // effect above only fires after commit. No reachable exploit was found
  // (approve is a single click and rejection's own reset already made it
  // safe there), but reading the prop directly is free and removes the
  // whole class of timing question rather than resting on "nobody can
  // click that fast."
  const handleApprove = () => {
    if (!review) {
      return
    }
    approveMutation.mutate(review.id)
  }

  const handleConfirmReject = () => {
    if (!review) {
      return
    }
    const reason = rejectReason.trim()
    rejectMutation.mutate({ id: review.id, rejection_reason: reason.length > 0 ? reason : undefined })
  }

  // A lightbox delete request closes the lightbox first rather than
  // stacking a Prompt's overlay on top of it - simpler than reasoning
  // about z-index across two independently-portaled overlays, and the
  // confirmation itself doesn't need the image visible behind it.
  const handleDeleteRequest = (item: ReviewMediaItem) => {
    setLightboxIndex(null)
    setMediaPendingDelete(item)
  }

  const handleConfirmMediaDelete = () => {
    if (mediaPendingDelete) {
      deleteMediaMutation.mutate(mediaPendingDelete.id)
    }
  }

  // Both read `review` (the prop), not `liveReview` - same reasoning as
  // handleApprove above. Toggling off the item's OWN current pinned_at/
  // hidden_at (not tracking separate local state for "which way to
  // toggle") is safe because `item` always comes from mediaItems, which is
  // itself derived from mediaQuery's cache - the same cache
  // curateMediaMutation's onSuccess updates, so a second click always
  // reads the outcome of the first.
  const handlePinToggle = (item: ReviewMediaItem) => {
    if (!review) {
      return
    }
    curateMediaMutation.mutate({ id: item.id, reviewId: review.id, pinned: !item.pinned_at })
  }

  const handleHideToggle = (item: ReviewMediaItem) => {
    if (!review) {
      return
    }
    curateMediaMutation.mutate({ id: item.id, reviewId: review.id, hidden: !item.hidden_at })
  }

  return (
    <>
      <Drawer open={review !== null} onOpenChange={(next) => !next && onClose()}>
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title asChild>
              <Heading level="h2">Review details</Heading>
            </Drawer.Title>
          </Drawer.Header>
          {liveReview && (
            <>
              <Drawer.Body className="flex flex-col gap-y-6 overflow-y-auto">
                <div className="flex items-center justify-between">
                  <Badge color={STATUS_BADGE_COLOR[liveReview.status]} size="2xsmall">
                    {liveReview.status[0].toUpperCase() + liveReview.status.slice(1)}
                  </Badge>
                  <Text size="small" leading="compact">
                    {formatStars(liveReview.rating)}
                  </Text>
                </div>

                <div className="flex flex-col gap-y-1">
                  {liveReview.title && (
                    <Text size="small" leading="compact" weight="plus">
                      {liveReview.title}
                    </Text>
                  )}
                  <Text size="small" leading="normal">
                    {liveReview.content}
                  </Text>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <DetailField label="Author" value={liveReview.display_name} />
                  <DetailField label="Email" value={liveReview.email ?? '—'} />
                  <DetailField label="Product" value={liveReview.product_id} mono />
                  <DetailField
                    label="Verified purchase"
                    value={liveReview.is_verified_purchase ? 'Yes' : 'No'}
                  />
                  <DetailField label="Submitted" value={new Date(liveReview.created_at).toLocaleString()} />
                  <DetailField label="Last updated" value={new Date(liveReview.updated_at).toLocaleString()} />
                  {liveReview.order_id && <DetailField label="Order" value={liveReview.order_id} mono />}
                  {liveReview.customer_id && (
                    <DetailField label="Customer" value={liveReview.customer_id} mono />
                  )}
                  {liveReview.rejection_reason && (
                    <DetailField label="Rejection reason" value={liveReview.rejection_reason} />
                  )}
                </div>

                <div className="flex flex-col gap-y-2">
                  {/*
                    The count comes from mediaQuery's own data, never from
                    liveReview.media_count - that field can't be kept in sync
                    from a mutation response (media_count isn't a column on
                    Review, and reject doesn't return one), so trusting it
                    here risked showing a number that disagreed with the
                    strip/lightbox underneath it. No number is shown at all
                    until the query has actually resolved, rather than
                    showing a guess that might not match what renders below.
                  */}
                  <Text size="small" leading="compact" weight="plus">
                    Media{mediaQuery.data ? ` (${mediaItems.length})` : ''}
                  </Text>
                  {mediaQuery.isLoading ? (
                    <Text size="small" leading="compact" className="text-ui-fg-subtle">
                      Loading media…
                    </Text>
                  ) : mediaQuery.isError ? (
                    // A genuine error state, not "no media" - keeping these
                    // visually distinct matters: an empty-looking strip that
                    // might mean "nothing attached" or "failed to load" is
                    // exactly the ambiguity a moderator shouldn't have to
                    // guess at.
                    <Text size="small" leading="compact" className="text-ui-fg-error">
                      Failed to load media.{' '}
                      <button
                        type="button"
                        className="underline"
                        onClick={() => mediaQuery.refetch()}
                      >
                        Retry
                      </button>
                    </Text>
                  ) : mediaItems.length === 0 ? (
                    <Text size="small" leading="compact" className="text-ui-fg-subtle">
                      No media attached.
                    </Text>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {mediaItems.map((item, index) => (
                        <div key={item.id} className="group relative h-16 w-16">
                          <button
                            type="button"
                            className="border-ui-border-base h-full w-full overflow-hidden rounded-md border"
                            onClick={() => setLightboxIndex(index)}
                          >
                            {item.type === 'image' ? (
                              <img
                                src={item.url}
                                alt=""
                                className={`h-full w-full object-cover ${item.hidden_at ? 'opacity-40' : ''}`}
                              />
                            ) : (
                              <div
                                className={`bg-ui-bg-subtle flex h-full w-full items-center justify-center ${item.hidden_at ? 'opacity-40' : ''}`}
                              >
                                <PlaySolid className="text-ui-fg-subtle" />
                              </div>
                            )}
                          </button>
                          {item.hidden_at && (
                            <div
                              className="bg-ui-bg-base border-ui-border-base absolute bottom-0 left-0 flex items-center rounded-tr-md border-r border-t p-0.5"
                              title="Hidden from shoppers"
                            >
                              <EyeSlashMini className="text-ui-fg-subtle" />
                            </div>
                          )}
                          {item.pinned_at && (
                            <div
                              className="bg-ui-bg-base border-ui-border-base absolute bottom-0 right-0 flex items-center rounded-tl-md border-l border-t p-0.5"
                              title="Pinned to gallery"
                            >
                              <PinTackSolid className="text-ui-fg-subtle" />
                            </div>
                          )}
                          <IconButton
                            size="2xsmall"
                            variant="transparent"
                            className="bg-ui-bg-base absolute -right-1 -top-1 opacity-0 group-hover:opacity-100"
                            disabled={deleteMediaMutation.isPending}
                            onClick={() => handleDeleteRequest(item)}
                            aria-label="Delete this media file"
                          >
                            <Trash />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/*
                  Task 10: the reply composer. `activeReviewId` is the RAW
                  `review` prop (not `liveReview.id`) deliberately - see
                  reply-composer.tsx's own prop doc comment: it is both
                  the id its mutations send (matching the fix Task 9's own
                  review applied to this file's approve/reject calls) and
                  the reset effect's dependency (matching this file's own
                  reset effect, keyed on the same prop for the same
                  close-then-reopen reason documented above).
                */}
                <ReplyComposer
                  status={liveReview.status}
                  activeReviewId={review?.id}
                  invalidateTable={invalidateTable}
                />
              </Drawer.Body>
              <Drawer.Footer>
                <Button size="small" variant="secondary" onClick={onClose}>
                  Close
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={isMutating}
                  isLoading={approveMutation.isPending}
                  onClick={handleApprove}
                >
                  Approve
                </Button>
                <Button
                  size="small"
                  variant="danger"
                  disabled={isMutating}
                  isLoading={rejectMutation.isPending}
                  onClick={openRejectPrompt}
                >
                  Reject
                </Button>
              </Drawer.Footer>
            </>
          )}
        </Drawer.Content>
      </Drawer>

      <Prompt open={rejectPromptOpen} onOpenChange={setRejectPromptOpen}>
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>Reject this review</Prompt.Title>
            <Prompt.Description>
              Optional - shown to the reviewer and wherever else this rejection reason is
              displayed in the admin.
            </Prompt.Description>
          </Prompt.Header>
          <div className="px-6 pb-6">
            <Textarea
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="Reason for rejecting (optional)"
              maxLength={MAX_REJECTION_REASON_LENGTH}
              rows={4}
            />
          </div>
          <Prompt.Footer>
            <Prompt.Cancel disabled={rejectMutation.isPending}>Cancel</Prompt.Cancel>
            <Prompt.Action disabled={rejectMutation.isPending} onClick={handleConfirmReject}>
              Reject
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>

      <Prompt open={mediaPendingDelete !== null} onOpenChange={(next) => !next && setMediaPendingDelete(null)}>
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>Delete this media file</Prompt.Title>
            <Prompt.Description>
              This permanently removes the file from storage and cannot be undone. The review
              itself is not affected.
            </Prompt.Description>
          </Prompt.Header>
          <Prompt.Footer>
            <Prompt.Cancel disabled={deleteMediaMutation.isPending}>Cancel</Prompt.Cancel>
            <Prompt.Action disabled={deleteMediaMutation.isPending} onClick={handleConfirmMediaDelete}>
              Delete
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>

      <MediaLightbox
        media={mediaItems}
        index={lightboxIndex}
        onOpenChange={setLightboxIndex}
        onDeleteRequest={handleDeleteRequest}
        isDeleting={deleteMediaMutation.isPending}
        onPinToggleRequest={handlePinToggle}
        onHideToggleRequest={handleHideToggle}
        isCurating={curateMediaMutation.isPending}
      />
    </>
  )
}

export default ReviewDrawer
