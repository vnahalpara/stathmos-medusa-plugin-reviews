import { useMemo, useState } from 'react'
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

type AdminReviewStatus = 'pending' | 'approved' | 'rejected'

export type AdminReview = {
  id: string
  product_id: string
  rating: number
  title: string | null
  content: string
  display_name: string
  email: string | null
  status: AdminReviewStatus
  is_verified_purchase: boolean
  helpful_count: number
  created_at: string
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
 * that Task 11's requirement - reading a `product_id` query param from the
 * URL on mount, because its product widget links to
 * `/app/reviews?product_id=<id>` - is a small addition to this shape
 * (initialise `product_id` from `useSearchParams()` instead of leaving it
 * `undefined`) rather than a rewrite of the filter state.
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

const STATUS_BADGE_COLOR: Record<AdminReviewStatus, 'orange' | 'green' | 'red'> = {
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
const MAX_REJECTION_REASON_LENGTH = 500

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
  onSelect: (id: string) => void
}

const ReviewTable = ({ onSelect }: ReviewTableProps) => {
  const [filters, setFilters] = useState<ReviewTableFilters>({ status: 'pending' })
  const [rowSelection, setRowSelection] = useState<DataTableRowSelectionState>({})
  const [search, setSearch] = useState('')
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  })
  const [rejectPromptOpen, setRejectPromptOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

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
    mutationFn: (body: {
      ids: string[]
      status: AdminReviewStatus
      rejection_reason?: string
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
        description: spansMultipleProducts
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
    batchStatusMutation.mutate({ ids: selectedIds, status: 'approved' })
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
    })
  }

  const columns = useColumns()

  const handleTabChange = (status: ReviewStatusTab) => {
    setFilters((prev) => ({ ...prev, status }))
    // Switching tabs must reset paging: forgetting this leaves the
    // merchant stranded on e.g. page 3 of a tab with a single page of
    // results, looking at an empty table.
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
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
    onRowClick: (_event, row) => onSelect(row.id),
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
