import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { defineWidgetConfig } from '@medusajs/admin-sdk'
import { DetailWidgetProps, HttpTypes } from '@medusajs/framework/types'
import { Spinner } from '@medusajs/icons'
import { Badge, Button, Container, Text } from '@medusajs/ui'
import { sdk } from '../lib/sdk'
import { formatStars, excerpt } from '../lib/format'
import { AdminReview, STATUS_BADGE_COLOR } from '../routes/reviews/components/review-table'

type ReviewStatsBreakdown = Record<1 | 2 | 3 | 4 | 5, number>

type AdminReviewStats = {
  count: number
  average: number
  media_count: number
  breakdown: ReviewStatsBreakdown
}

// A local, minimal shape for this widget's own fetch - review-table.tsx's
// equivalent (`AdminReviewsResponse`) isn't exported, and duplicating four
// fields here is cheaper than widening that file's public surface for a
// type only this widget uses.
type AdminRecentReviewsResponse = {
  reviews: AdminReview[]
  count: number
}

const RECENT_LIMIT = 5
// Largest rating first, matching how a shopper (and a merchant) reads a
// star breakdown.
const BREAKDOWN_ROWS: (1 | 2 | 3 | 4 | 5)[] = [5, 4, 3, 2, 1]

const ProductReviewsWidget = ({ data: product }: DetailWidgetProps<HttpTypes.AdminProduct>) => {
  // Both queries load on mount with no `enabled` gate tied to UI state - a
  // widget whose data only appears after some interaction shows empty on
  // every page refresh, which is the most common Medusa admin UI bug.
  const statsQuery = useQuery({
    queryFn: () => sdk.client.fetch<AdminReviewStats>(`/admin/reviews/stats/${product.id}`),
    queryKey: ['admin-review-stats', product.id],
  })

  const recentQuery = useQuery({
    queryFn: () =>
      sdk.client.fetch<AdminRecentReviewsResponse>('/admin/reviews', {
        query: { product_id: product.id, limit: RECENT_LIMIT },
      }),
    queryKey: ['admin-reviews-recent', product.id],
  })

  const isLoading = statsQuery.isLoading || recentQuery.isLoading
  // A genuine fetch failure, not "no reviews" - keeping these visually
  // distinct matters for the same reason review-drawer.tsx's media error
  // state and reply-composer.tsx's reply error state do: a blank widget
  // could otherwise mean either "nobody has reviewed this yet" or "failed
  // to load," and a merchant shouldn't have to guess which.
  const isError = statsQuery.isError || recentQuery.isError
  const stats = statsQuery.data
  const reviews = recentQuery.data?.reviews ?? []
  const approvedCount = stats?.count ?? 0
  const average = stats?.average ?? 0

  // "Genuinely no reviews" means neither source found anything - the stats
  // summary only ever counts approved reviews (mirrors the storefront), so
  // a product can have zero approved reviews and still have pending or
  // rejected ones sitting in the recent list. Requiring both counts to be
  // zero avoids rendering the "0.0 stars from 0 reviews" fabricated-empty
  // pattern in that case: the summary below is only shown once there is at
  // least one real number behind it, even if that number is itself zero
  // approved reviews.
  const hasNoReviews = (recentQuery.data?.count ?? 0) === 0 && approvedCount === 0

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Text size="small" leading="compact" weight="plus">
          Reviews
        </Text>
        <Button asChild size="small" variant="secondary">
          <Link to={`/reviews?product_id=${encodeURIComponent(product.id)}`}>View all</Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center px-6 py-8">
          <Spinner className="text-ui-fg-subtle animate-spin" />
        </div>
      ) : isError ? (
        <div className="px-6 py-8">
          <Text size="small" leading="compact" className="text-ui-fg-error">
            Failed to load reviews.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => {
                statsQuery.refetch()
                recentQuery.refetch()
              }}
            >
              Retry
            </button>
          </Text>
        </div>
      ) : hasNoReviews ? (
        <div className="px-6 py-8">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            No reviews yet for this product.
          </Text>
        </div>
      ) : (
        <>
          {approvedCount > 0 ? (
            <div className="flex flex-col gap-y-3 px-6 py-4">
              <div className="flex items-center gap-x-2">
                <Text size="small" leading="compact" weight="plus">
                  {formatStars(average)}
                </Text>
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {average.toFixed(1)} average · {approvedCount} approved review
                  {approvedCount === 1 ? '' : 's'}
                </Text>
              </div>
              <div className="flex flex-col gap-y-1">
                {BREAKDOWN_ROWS.map((rating) => {
                  const count = stats?.breakdown[rating] ?? 0
                  const pct = Math.round((count / approvedCount) * 100)
                  return (
                    <div key={rating} className="flex items-center gap-x-2">
                      <Text
                        size="small"
                        leading="compact"
                        className="text-ui-fg-subtle w-3 text-right"
                      >
                        {rating}
                      </Text>
                      <div className="bg-ui-bg-subtle h-1.5 flex-1 overflow-hidden rounded-full">
                        <div
                          className="bg-ui-tag-orange-icon h-full rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <Text
                        size="small"
                        leading="compact"
                        className="text-ui-fg-subtle w-6 text-right"
                      >
                        {count}
                      </Text>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            // No fabricated "0.0 average" / all-empty breakdown bars here -
            // that reads as a broken widget, not an accurate one,
            // especially right above a list that may show several
            // pending/rejected reviews. Say plainly why there's no rating
            // summary instead.
            <div className="px-6 py-4">
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                No approved reviews yet - the rating summary only counts approved reviews.
                See recent activity below.
              </Text>
            </div>
          )}

          <div className="flex flex-col gap-y-4 px-6 py-4">
            <Text size="small" leading="compact" weight="plus">
              Latest reviews
            </Text>
            {reviews.length === 0 ? (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                No reviews to show here yet.
              </Text>
            ) : (
              <div className="flex flex-col gap-y-3">
                {reviews.map((review) => (
                  <div key={review.id} className="flex flex-col gap-y-1">
                    <div className="flex items-center justify-between gap-x-2">
                      <div className="flex items-center gap-x-2">
                        <Text size="small" leading="compact" weight="plus">
                          {formatStars(review.rating)}
                        </Text>
                        <Text size="small" leading="compact" className="text-ui-fg-subtle">
                          {review.display_name}
                        </Text>
                      </div>
                      <Badge color={STATUS_BADGE_COLOR[review.status]} size="2xsmall">
                        {review.status[0].toUpperCase() + review.status.slice(1)}
                      </Badge>
                    </div>
                    <Text size="small" leading="compact" className="text-ui-fg-subtle">
                      {excerpt(review.content, 120)}
                    </Text>
                    {review.media_count > 0 && (
                      <Text size="small" leading="compact" className="text-ui-fg-muted">
                        {review.media_count} media attachment{review.media_count === 1 ? '' : 's'}
                      </Text>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: 'product.details.after',
})

export default ProductReviewsWidget
