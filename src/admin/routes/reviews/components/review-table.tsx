import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import {
  Badge,
  Container,
  DataTable,
  DataTablePaginationState,
  DataTableRowSelectionState,
  Heading,
  Text,
  Button,
  Prompt,
  Textarea,
  toast,
  createDataTableColumnHelper,
  useDataTable,
} from '@medusajs/ui'
import { sdk } from '../../../lib/sdk'
import { formatStars, excerpt } from '../../../lib/format'

export type AdminReviewStatus = 'pending' | 'approved' | 'rejected'

export type AdminReview = {
  id: string
  product_id: string
  // Nullable: a guest reviewer has no customer_id, and a review can be
  // submitted without an order reference. Present on every row GET
  // /admin/reviews returns (it spreads the raw record, unlike the
  // allow-listed store routes) - typed here too so the detail drawer can
  // show them without re-fetching anything.
  customer_id: string | null
  order_id: string | null
  rating: number
  title: string | null
  content: string
  display_name: string
  email: string | null
  status: AdminReviewStatus
  rejection_reason: string | null
  is_verified_purchase: boolean
  helpful_count: number
  created_at: string
  updated_at: string
  edited_at: string | null
  // Counts ALL media attached to the review, including anything a
  // moderator has already hidden - not the store-facing "visible" count.
  // See countMediaByReview() in src/modules/review/service.ts.
  media_count: number
}

type AdminReviewsResponse = {
  reviews: AdminReview[]
  count: number
  limit: number
  offset: number
}

type ReviewStatusTab = AdminReviewStatus | 'all'

/**
 * Kept as an object (rather than several independent `useState` calls) so
 * that reading a `product_id` query param from the URL - the product
 * widget (Task 11) links here via `/app/reviews?product_id=<id>` - is a
 * small addition to this shape rather than a rewrite of the filter state.
 *
 * `product_id` is kept in sync with `searchParams` for the lifetime of
 * this mounted table, not just at mount - see the `useEffect` keyed on
 * `searchParams` below. A mount-only read is enough for a genuine
 * cross-route navigation (product page -> this route, which remounts the
 * component), but this page's own permanent sidebar nav entry
 * (`defineRouteConfig({ label: 'Reviews' })` in `page.tsx`) is a
 * same-route navigation when clicked from here: it only changes
 * `location.search`, which React Router does not remount for. Without the
 * effect, `filters.product_id` would stay pinned to whatever it was at
 * mount, and the URL (now unfiltered) would silently disagree with the
 * table (still filtered) - a merchant clicking their own "Reviews" nav
 * item expecting the full queue would keep seeing one product's reviews
 * without any error or obvious indication why, beyond the "Filtered to
 * product" banner they may not notice.
 *
 * Tab switches and searches both still preserve `product_id` unchanged
 * (see `handleTabChange` and `handleSearchChange`, neither of which
 * touches it), and `handleClearProductFilter` is the one place that also
 * writes the URL (removing the param) rather than just this state - the
 * sync effect below then reads that same removal back and settles on
 * `undefined` without looping, since the effect never itself calls
 * `setSearchParams`.
 */
type ReviewTableFilters = {
  status: ReviewStatusTab
  product_id?: string
}

const STATUS_TABS: { label: string; value: ReviewStatusTab }[] = [
  { label: 'Pending', value: 'pending' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'All', value: 'all' },
]

export const STATUS_BADGE_COLOR: Record<AdminReviewStatus, 'orange' | 'green' | 'red'> = {
  pending: 'orange',
  approved: 'green',
  rejected: 'red',
}

const PAGE_SIZE = 20

// Mirrors BatchStatusSchema in src/api/admin/reviews/middlewares.ts. Kept in
// sync by hand - the admin bundle and the API route are built and shipped
// separately, so there's no runtime import to share here. Enforced
// client-side too so a merchant gets an explained, disabled button instead
// of a 400 they can't interpret.
const MAX_BATCH_SIZE = 100
// Exported so the detail drawer's single-review reject prompt (Task 9) can
// mirror the same server-enforced cap instead of restating the number.
export const MAX_REJECTION_REASON_LENGTH = 500

const columnHelper = createDataTableColumnHelper<AdminReview>()

const useColumns = () => {
  return useMemo(
    () => [
      columnHelper.select(),
      columnHelper.accessor('product_id', {
        header: 'Product',
        // Deliberately the raw id, not a hydrated title: fetching product
        // titles here would mean a review<->product `defineLink`, which is
        // explicitly forbidden in this plan because that link leaked guest
        // emails in Phase 1. Task 11 hydrates a real product display.
        cell: ({ getValue }) => (
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {getValue()}
          </Text>
        ),
      }),
      columnHelper.accessor('rating', {
        header: 'Rating',
        cell: ({ getValue }) => (
          <Text size="small" leading="compact">
            {formatStars(getValue())}
          </Text>
        ),
      }),
      columnHelper.accessor('content', {
        header: 'Review',
        cell: ({ getValue }) => (
          <Text size="small" leading="compact">
            {excerpt(getValue(), 80)}
          </Text>
        ),
      }),
      columnHelper.accessor('media_count', {
        header: 'Media',
        cell: ({ getValue }) => (
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {getValue()}
          </Text>
        ),
      }),
      columnHelper.accessor('is_verified_purchase', {
        header: 'Verified',
        cell: ({ getValue }) =>
          getValue() ? (
            <Badge color="green" size="2xsmall">
              Verified
            </Badge>
          ) : (
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              —
            </Text>
          ),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: ({ getValue }) => {
          const status = getValue()
          return (
            <Badge color={STATUS_BADGE_COLOR[status]} size="2xsmall">
              {status[0].toUpperCase() + status.slice(1)}
            </Badge>
          )
        },
      }),
      columnHelper.accessor('created_at', {
        header: 'Date',
        cell: ({ getValue }) => (
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {new Date(getValue()).toLocaleDateString()}
          </Text>
        ),
      }),
    ],
    []
  )
}

type ReviewTableProps = {
  // Passes the full row rather than just an id: GET /admin/reviews has no
  // single-review-by-id endpoint (see review-drawer.tsx's own comment), so
  // the row this table already fetched IS the drawer's only data source -
  // re-deriving it from an id after the fact would mean either a second,
  // unsupported network call or a fragile re-lookup into this table's own
  // (paginated, filterable) query cache.
  onSelect: (review: AdminReview) => void
}

const ReviewTable = ({ onSelect }: ReviewTableProps) => {
  const [searchParams, setSearchParams] = useSearchParams()
  // Seeds the very first render from the URL already present at mount, so
  // the initial fetch (which fires before any effect can run) is filtered
  // correctly from the start rather than flashing an unfiltered page first.
  // The `useEffect` below is what keeps this correct on every render after
  // that - see the `ReviewTableFilters` doc comment above.
  const [filters, setFilters] = useState<ReviewTableFilters>(() => ({
    status: 'pending',
    product_id: searchParams.get('product_id') ?? undefined,
  }))
  const [rowSelection, setRowSelection] = useState<DataTableRowSelectionState>({})
  const [search, setSearch] = useState('')
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  })
  const [rejectPromptOpen, setRejectPromptOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const urlProductId = searchParams.get('product_id') ?? undefined

  // Keeps `filters.product_id` synced to the URL for the table's whole
  // mounted lifetime, not just at mount - see the `ReviewTableFilters` doc
  // comment for why a mount-only read isn't enough (the sidebar's own
  // "Reviews" nav link is a same-route, search-only navigation that a
  // lazy `useState` initializer would never see).
  //
  // Keyed on the derived string `urlProductId`, not the `searchParams`
  // object itself, so this only fires when the value that matters
  // actually changes - including the no-op case right after
  // `handleClearProductFilter` writes the same `undefined` this effect
  // would also compute, which is why this can't loop against that
  // handler: this effect only ever reads `searchParams`, never writes it.
  useEffect(() => {
    setFilters((prev) =>
      prev.product_id === urlProductId ? prev : { ...prev, product_id: urlProductId }
    )
    // Same reasoning as `handleTabChange`/`handleSearchChange`: a page
    // index or selection scoped to the previous product filter is
    // meaningless once the filter changes (including to/from "no
    // filter"). `handleClearProductFilter` already does this reset
    // itself for its own trigger, but this effect is the thing that must
    // guarantee it for every OTHER way `product_id` can change - a
    // followed link, browser back/forward, or a manually edited URL.
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    setRowSelection({})
  }, [urlProductId])

  const queryClient = useQueryClient()

  const limit = pagination.pageSize
  const offset = pagination.pageIndex * limit

  // Loads on mount with no `enabled` tied to UI state - the table must
  // show real data immediately on page refresh, not only after some modal
  // or drawer interaction.
  const { data, isLoading } = useQuery({
    queryFn: () =>
      sdk.client.fetch<AdminReviewsResponse>('/admin/reviews', {
        query: {
          status: filters.status === 'all' ? undefined : filters.status,
          product_id: filters.product_id,
          q: search || undefined,
          limit,
          offset,
        },
      }),
    queryKey: ['admin-reviews', filters.status, filters.product_id, search, limit, offset],
    placeholderData: keepPreviousData,
  })

  const reviews = data?.reviews ?? []

  const selectedIds = useMemo(() => Object.keys(rowSelection), [rowSelection])
  const selectedCount = selectedIds.length
  const overSelectionLimit = selectedCount > MAX_BATCH_SIZE

  // Best-effort: only rows on the currently loaded page are visible here,
  // so a selection carried over from a page we've since navigated away
  // from won't be counted. That's fine for this check's purpose - it only
  // needs to catch the common case where an unfiltered, multi-product
  // batch is about to hit the "only the first product's summary is
  // refreshed" backend limitation (see the README's "Known limitation:
  // multi-product bulk moderation" section) so the success toast can say
  // so, rather than silently implying every product's rating summary was
  // brought up to date.
  const selectedProductIds = useMemo(() => {
    const ids = new Set<string>()
    for (const review of reviews) {
      if (rowSelection[review.id]) {
        ids.add(review.product_id)
      }
    }
    return ids
  }, [reviews, rowSelection])
  const spansMultipleProducts = selectedProductIds.size > 1

  const batchStatusMutation = useMutation({
    mutationFn: ({
      spansMultipleProducts: _spansMultipleProducts,
      ...body
    }: {
      ids: string[]
      status: AdminReviewStatus
      rejection_reason?: string
      // Snapshotted at the moment `mutate()` is called, not read live from
      // component state in `onSuccess` - the selection (and which page's
      // data is loaded) can change while the request is in flight, and the
      // toast must describe the batch that was actually sent, not whatever
      // is currently selected. Stripped out here rather than sent to the
      // server, which rejects unknown keys (`BatchStatusSchema` is
      // `.strict()`).
      spansMultipleProducts: boolean
    }) =>
      sdk.client.fetch('/admin/reviews/batch/status', {
        method: 'POST',
        body,
      }),
    onSuccess: (_response, variables) => {
      // Invalidate the table's own query, not just local selection state -
      // a merchant looking at the "Pending" tab after approving needs the
      // approved rows to actually disappear from it.
      queryClient.invalidateQueries({ queryKey: ['admin-reviews'] })
      setRowSelection({})
      const count = variables.ids.length
      const verb = variables.status === 'approved' ? 'approved' : 'rejected'
      toast.success(`${count} review${count === 1 ? '' : 's'} ${verb}`, {
        // Known limitation (see README): the backend only recomputes the
        // rating summary for the first product in a batch. Say so here
        // rather than letting the merchant assume every affected
        // product's summary is now correct.
        description: variables.spansMultipleProducts
          ? "This batch spanned more than one product, so only the first product's rating summary was refreshed - the rest will update on their next change."
          : undefined,
      })
    },
    onError: (error, variables) => {
      // A bulk action that fails silently is the worst outcome here - the
      // merchant must not be left assuming the batch went through.
      const verb = variables.status === 'approved' ? 'approve' : 'reject'
      toast.error(`Failed to ${verb} reviews`, {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  const isApproving =
    batchStatusMutation.isPending && batchStatusMutation.variables?.status === 'approved'
  const isRejecting =
    batchStatusMutation.isPending && batchStatusMutation.variables?.status === 'rejected'

  const handleApprove = () => {
    if (selectedCount === 0 || overSelectionLimit) {
      return
    }
    batchStatusMutation.mutate({
      ids: selectedIds,
      status: 'approved',
      spansMultipleProducts,
    })
  }

  const openRejectPrompt = () => {
    setRejectReason('')
    setRejectPromptOpen(true)
  }

  const handleConfirmReject = () => {
    if (selectedCount === 0 || overSelectionLimit) {
      return
    }
    const reason = rejectReason.trim()
    batchStatusMutation.mutate({
      ids: selectedIds,
      status: 'rejected',
      rejection_reason: reason.length > 0 ? reason : undefined,
      spansMultipleProducts,
    })
  }

  const columns = useColumns()

  const handleTabChange = (status: ReviewStatusTab) => {
    setFilters((prev) => ({ ...prev, status }))
    // Switching tabs must reset paging: forgetting this leaves the
    // merchant stranded on e.g. page 3 of a tab with a single page of
    // results, looking at an empty table.
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    // A selection is only meaningful against the view it was made in.
    // Without this, rows selected on one tab silently ride along into
    // another and get bulk-approved/rejected alongside rows the merchant
    // can no longer even see - a wrong *action* on customer-visible
    // content, not just a stale display.
    setRowSelection({})
  }

  const handleSearchChange = (value: string) => {
    setSearch(value)
    // Same reasoning as the tab reset above: a stale `pageIndex` from a
    // wider result set must not carry over into a narrower search result.
    // Belt-and-suspenders with useDataTable's own `autoResetPageIndex`
    // (default true, left enabled here) which already does this on a
    // *debounced* search change - verified by reading @medusajs/ui's
    // use-data-table.js rather than assumed, since this repo has no
    // component-rendering test harness to check it at runtime.
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    // Same reasoning as the tab-change handler above: a selection made
    // against one search's results must not silently carry into a
    // different result set and get bulk-moderated there.
    setRowSelection({})
  }

  const handleClearProductFilter = () => {
    setFilters((prev) => ({ ...prev, product_id: undefined }))
    // Same reasoning as the tab/search handlers above: a page index or
    // selection scoped to one product's results is meaningless once the
    // filter widens back out to every product.
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    setRowSelection({})
    // Also drop it from the URL (not just component state) so a page
    // refresh after clearing doesn't silently reapply the filter from a
    // stale query string.
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('product_id')
        return next
      },
      { replace: true }
    )
  }

  const table = useDataTable({
    data: reviews,
    columns,
    getRowId: (row) => row.id,
    rowCount: data?.count ?? 0,
    isLoading,
    rowSelection: {
      state: rowSelection,
      onRowSelectionChange: setRowSelection,
    },
    search: {
      state: search,
      onSearchChange: handleSearchChange,
    },
    pagination: {
      state: pagination,
      onPaginationChange: setPagination,
    },
    onRowClick: (_event, row) => onSelect(row),
  })

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Reviews</Heading>
        <div className="flex gap-2">
          {STATUS_TABS.map((tab) => (
            <Button
              key={tab.value}
              size="small"
              variant={filters.status === tab.value ? 'primary' : 'secondary'}
              onClick={() => handleTabChange(tab.value)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
      </div>
      {filters.product_id && (
        <div className="flex items-center justify-between px-6 py-3">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            Filtered to product{' '}
            <Text as="span" size="small" leading="compact" weight="plus">
              {filters.product_id}
            </Text>
          </Text>
          <Button size="small" variant="transparent" onClick={handleClearProductFilter}>
            Clear filter
          </Button>
        </div>
      )}
      {selectedCount > 0 && (
        <div className="flex items-center justify-between px-6 py-4">
          <Text size="small" leading="compact" weight="plus">
            {selectedCount} selected
          </Text>
          <div className="flex items-center gap-x-3">
            {overSelectionLimit && (
              <Text size="small" leading="compact" className="text-ui-fg-error">
                Select {MAX_BATCH_SIZE} or fewer reviews to bulk update.
              </Text>
            )}
            <Button
              size="small"
              variant="secondary"
              disabled={overSelectionLimit || batchStatusMutation.isPending}
              isLoading={isApproving}
              onClick={handleApprove}
            >
              Approve
            </Button>
            <Button
              size="small"
              variant="danger"
              disabled={overSelectionLimit || batchStatusMutation.isPending}
              isLoading={isRejecting}
              onClick={openRejectPrompt}
            >
              Reject
            </Button>
          </div>
        </div>
      )}
      <DataTable instance={table}>
        <DataTable.Toolbar className="px-6 py-4">
          <DataTable.Search placeholder="Search name, email, title or content..." />
        </DataTable.Toolbar>
        <DataTable.Table />
        <DataTable.Pagination />
      </DataTable>
      <Prompt open={rejectPromptOpen} onOpenChange={setRejectPromptOpen}>
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>
              Reject {selectedCount} review{selectedCount === 1 ? '' : 's'}
            </Prompt.Title>
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
            <Prompt.Cancel disabled={batchStatusMutation.isPending}>Cancel</Prompt.Cancel>
            <Prompt.Action
              disabled={batchStatusMutation.isPending}
              onClick={handleConfirmReject}
            >
              Reject
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </Container>
  )
}

export default ReviewTable
