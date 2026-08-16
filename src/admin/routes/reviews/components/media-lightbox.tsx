import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeftMini,
  ArrowRightMini,
  EyeMini,
  EyeSlashMini,
  PinTack,
  PinTackSolid,
  Trash,
  XMark,
} from '@medusajs/icons'
import { Badge, Button, IconButton, Text } from '@medusajs/ui'

export type ReviewMediaItem = {
  id: string
  type: 'image' | 'video'
  url: string
  // Always null in this plugin - there is no transcoding step and no
  // server-generated poster frame. Kept on the type (rather than omitted)
  // so a future caller cannot "helpfully" start rendering it without first
  // reading why every value here is null. See ReviewMedia's model comment.
  thumbnail_url: string | null
  // Set when a moderator has pinned this item to lead the public gallery
  // (Task 4's `pinned_at DESC NULLS LAST` ordering). Non-null means
  // pinned; badged here for the same reason hidden_at is - a moderator
  // opening the lightbox has no other way to tell curation state apart
  // from a plain, unpinned photo.
  pinned_at: string | null
  // Set when a moderator has hidden this item from shoppers (it still
  // exists and is still returned here - GET /admin/reviews/:id/media
  // deliberately includes hidden media, see that route's own comment).
  // Non-null means hidden; the drawer must mark this visibly, or a
  // moderator looking at the image has no way to tell it's already
  // hidden from the storefront.
  hidden_at: string | null
}

type MediaLightboxProps = {
  media: ReviewMediaItem[]
  // The open item's index into `media`, or null when closed. An index
  // rather than an id/item so prev/next navigation is a plain increment.
  index: number | null
  onOpenChange: (index: number | null) => void
  onDeleteRequest: (item: ReviewMediaItem) => void
  isDeleting: boolean
  // Pin/hide are immediate toggles (unlike delete, they are reversible and
  // need no confirmation prompt) - both handed the full item, same as
  // onDeleteRequest, so the caller (review-drawer.tsx) can read the
  // CURRENT pinned_at/hidden_at off it rather than re-deriving "which way
  // to toggle" from anything closed over here.
  onPinToggleRequest: (item: ReviewMediaItem) => void
  onHideToggleRequest: (item: ReviewMediaItem) => void
  // Covers both toggles, same simplification isDeleting already makes for
  // the one delete mutation - this lightbox never has two curation
  // mutations in flight at once (POST .../curation takes one request per
  // click), so one shared pending flag is enough to disable every
  // curation control while any of them is in flight.
  isCurating: boolean
}

/**
 * A larger view of one item from a review's media strip, with prev/next
 * navigation, a delete affordance, and Pin/Unpin + Hide/Unhide curation
 * toggles (Task 5's `POST /admin/reviews/media/:id/curation`). This
 * component never calls the API itself - `onDeleteRequest`/
 * `onPinToggleRequest`/`onHideToggleRequest` all hand the current item back
 * to the caller (review-drawer.tsx), which owns every mutation. Delete
 * additionally requires confirmation there (a Medusa UI `Prompt`, never
 * `window.confirm`) before it calls DELETE /admin/reviews/media/:id; pin
 * and hide are immediate, reversible toggles and need none.
 *
 * `thumbnail_url` is always null (see the type above) - images render
 * straight from `url` (the original file already IS the thumbnail-sized
 * concern's answer: there's nothing smaller to show), and videos NEVER
 * render as an `<img>` - only as a `<video controls>` element, and never
 * `autoPlay`, so opening the lightbox never starts sound or motion the
 * moderator didn't ask for.
 *
 * Rendered through `createPortal` into `document.body` rather than inline:
 * this component is mounted deep inside the dashboard's own React tree
 * (inside the Drawer that opens it), and a `position: fixed` overlay
 * mounted there can still end up visually trapped beneath the Drawer's own
 * Radix-portaled content if any ancestor between here and the app root
 * establishes a stacking context (a transform, an opacity animation, etc. -
 * common in dashboard shells). Portaling to `document.body`, exactly like
 * Drawer/Prompt already do internally, puts this overlay in the same
 * stacking arena so a z-index comparison against them is actually
 * meaningful.
 */
const MediaLightbox = ({
  media,
  index,
  onOpenChange,
  onDeleteRequest,
  isDeleting,
  onPinToggleRequest,
  onHideToggleRequest,
  isCurating,
}: MediaLightboxProps) => {
  const open = index !== null
  const current = index !== null ? media[index] : null

  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // The Drawer this lightbox opens inside is a Radix Dialog, and
        // Radix's own Escape handling (`@radix-ui/react-use-escape-keydown`,
        // confirmed by reading its source) listens on `document` with
        // `{ capture: true }`. Registering here on `window` with the same
        // `{ capture: true }` runs first - window is "outside" document in
        // the capture path - so stopPropagation() reliably stops the event
        // before Radix's own handler ever sees it. Without this, one
        // Escape press while the lightbox is open would close both the
        // lightbox AND the underlying Drawer, since nothing tells Radix
        // this hand-rolled overlay is "on top" of it (it isn't a Radix
        // dialog and isn't in Radix's own layer stack).
        event.stopPropagation()
        onOpenChange(null)
      } else if (event.key === 'ArrowLeft' && index !== null && index > 0) {
        onOpenChange(index - 1)
      } else if (event.key === 'ArrowRight' && index !== null && index < media.length - 1) {
        onOpenChange(index + 1)
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [open, index, media.length, onOpenChange])

  if (!open || !current || index === null) {
    return null
  }

  return createPortal(
    <div
      className="bg-ui-bg-overlay fixed inset-0 z-[100] flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
      onClick={() => onOpenChange(null)}
    >
      <div
        className="bg-ui-bg-base border-ui-border-base relative flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border shadow-elevation-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-ui-border-base flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-x-2">
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {index + 1} / {media.length}
            </Text>
            {current.pinned_at && (
              <Badge color="purple" size="2xsmall" className="flex items-center gap-x-1">
                <PinTackSolid /> Pinned to gallery
              </Badge>
            )}
            {current.hidden_at && (
              <Badge color="grey" size="2xsmall" className="flex items-center gap-x-1">
                <EyeSlashMini /> Hidden from shoppers
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-x-1">
            <Button
              size="small"
              variant="secondary"
              disabled={isCurating}
              onClick={() => onPinToggleRequest(current)}
              aria-label={current.pinned_at ? 'Unpin from gallery' : 'Pin to gallery'}
            >
              {current.pinned_at ? <PinTackSolid /> : <PinTack />}
              {current.pinned_at ? 'Unpin' : 'Pin'}
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={isCurating}
              onClick={() => onHideToggleRequest(current)}
              aria-label={current.hidden_at ? 'Unhide from shoppers' : 'Hide from shoppers'}
            >
              {current.hidden_at ? <EyeMini /> : <EyeSlashMini />}
              {current.hidden_at ? 'Unhide' : 'Hide'}
            </Button>
            <IconButton
              size="small"
              variant="transparent"
              disabled={isDeleting}
              onClick={() => onDeleteRequest(current)}
              aria-label="Delete this media file"
            >
              <Trash />
            </IconButton>
            <IconButton
              size="small"
              variant="transparent"
              onClick={() => onOpenChange(null)}
              aria-label="Close"
            >
              <XMark />
            </IconButton>
          </div>
        </div>
        <div className="bg-ui-bg-subtle flex flex-1 items-center justify-center p-4">
          {current.type === 'video' ? (
            // No `autoPlay` - opening the lightbox must not start playback
            // on its own. `controls` is required by the brief.
            <video controls className="max-h-[70vh] max-w-full" src={current.url}>
              Your browser does not support the video tag.
            </video>
          ) : (
            <img src={current.url} alt="" className="max-h-[70vh] max-w-full object-contain" />
          )}
        </div>
        {media.length > 1 && (
          <div className="border-ui-border-base flex items-center justify-between border-t px-4 py-2">
            <IconButton
              size="small"
              variant="transparent"
              disabled={index === 0}
              onClick={() => onOpenChange(index - 1)}
              aria-label="Previous media file"
            >
              <ArrowLeftMini />
            </IconButton>
            <IconButton
              size="small"
              variant="transparent"
              disabled={index === media.length - 1}
              onClick={() => onOpenChange(index + 1)}
              aria-label="Next media file"
            >
              <ArrowRightMini />
            </IconButton>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

export default MediaLightbox
