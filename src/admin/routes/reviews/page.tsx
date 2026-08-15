import { useState } from 'react'
import { defineRouteConfig } from '@medusajs/admin-sdk'
import { ChatBubbleLeftRight } from '@medusajs/icons'
import ReviewTable, { AdminReview } from './components/review-table'
import ReviewDrawer from './components/review-drawer'

const ReviewsPage = () => {
  // The full row the table already fetched, not just an id - see
  // review-table.tsx's ReviewTableProps comment and review-drawer.tsx's
  // own doc comment for why: there is no GET /admin/reviews/:id to
  // re-fetch this from.
  const [selectedReview, setSelectedReview] = useState<AdminReview | null>(null)

  return (
    <>
      <ReviewTable onSelect={setSelectedReview} />
      <ReviewDrawer review={selectedReview} onClose={() => setSelectedReview(null)} />
    </>
  )
}

export const config = defineRouteConfig({
  label: 'Reviews',
  icon: ChatBubbleLeftRight,
})

export default ReviewsPage
