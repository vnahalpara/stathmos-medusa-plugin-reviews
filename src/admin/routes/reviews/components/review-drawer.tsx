import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlaySolid, Trash } from '@medusajs/icons'
import { Badge, Button, Drawer, Heading, IconButton, Prompt, Text, Textarea, toast } from '@medusajs/ui'
import { sdk } from '../../../lib/sdk'
import { formatStars } from '../../../lib/format'
import { AdminReview, MAX_REJECTION_REASON_LENGTH, STATUS_BADGE_COLOR } from './review-table'
import MediaLightbox, { ReviewMediaItem } from './media-lightbox'

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
 * ## Why there is no `['admin-review', id]` network query to invalidate
 * Requirement: "invalidate both the drawer's own query and
 * ['admin-reviews']". There genuinely is no *network-backed* query the
 * drawer owns - see above, nothing exists to refetch it from. What plays
 * that role here is `liveReview`: local state seeded from the `review`
 * prop and overwritten with the exact response body of each mutation
 * (approve/reject/media-delete all return the field(s) that changed). That
 * is strictly fresher than an invalidate+refetch would be, since there is
 * no round trip and therefore nothing to race against. `['admin-reviews']`
 * IS a real query (review-table.tsx's own `useQuery`) and is invalidated
 * for real below, by the same key prefix that table uses.
 *
 * ## Media: media_count only, no media items
 * GET /admin/reviews returns `media_count` (Task 7) but never the media
 * rows themselves (id/url/type) - no admin route lists them. That means
 * this drawer cannot show real thumbnails or wire up per-item delete
 * against real data today; see task-9-report.md for the concrete gap and
 * the read route it would take to close it. `mediaItems` below is real
 * state (not a hardcoded `[]`) and MediaLightbox/the per-item delete
 * mutation are fully implemented against it, specifically so that closing
 * this gap later is "populate `mediaItems`", not a rewrite.
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
  const [mediaItems, setMediaItems] = useState<ReviewMediaItem[]>([])
  const [rejectPromptOpen, setRejectPromptOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [mediaPendingDelete, setMediaPendingDelete] = useState<ReviewMediaItem | null>(null)

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
    if (!review) {
      return
    }

    setLiveReview(review)
    setMediaItems([])
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
      setMediaItems((prev) => prev.filter((item) => item.id !== mediaId))
      setLiveReview((prev) => (prev ? { ...prev, media_count: Math.max(0, prev.media_count - 1) } : prev))
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

  const isMutating = approveMutation.isPending || rejectMutation.isPending

  const openRejectPrompt = () => {
    setRejectReason('')
    setRejectPromptOpen(true)
  }

  const handleConfirmReject = () => {
    if (!liveReview) {
      return
    }
    const reason = rejectReason.trim()
    rejectMutation.mutate({ id: liveReview.id, rejection_reason: reason.length > 0 ? reason : undefined })
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
                  <Text size="small" leading="compact" weight="plus">
                    Media ({liveReview.media_count})
                  </Text>
                  {liveReview.media_count === 0 ? (
                    <Text size="small" leading="compact" className="text-ui-fg-subtle">
                      No media attached.
                    </Text>
                  ) : mediaItems.length === 0 ? (
                    // The admin API can only report a count, not the files
                    // themselves - see this file's own doc comment above
                    // ("Media: media_count only, no media items") and
                    // task-9-report.md for the concrete backend gap.
                    <Text size="small" leading="compact" className="text-ui-fg-subtle">
                      {liveReview.media_count} file{liveReview.media_count === 1 ? '' : 's'} attached.
                      Preview and per-file deletion require a media list, which the admin API does
                      not currently expose for a single review.
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
                              <img src={item.url} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <div className="bg-ui-bg-subtle flex h-full w-full items-center justify-center">
                                <PlaySolid className="text-ui-fg-subtle" />
                              </div>
                            )}
                          </button>
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
                  Task 10 seam: the reply composer renders here, below the
                  review's own content and media and above the moderation
                  footer. It should follow the same pattern established
                  above - sdk.client.fetch through a useMutation, then
                  update `liveReview`-equivalent local state from the
                  response AND call invalidateTable() - rather than
                  inventing a second way to keep the table and the open
                  drawer in sync.
                */}
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
                  onClick={() => approveMutation.mutate(liveReview.id)}
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
      />
    </>
  )
}

export default ReviewDrawer
