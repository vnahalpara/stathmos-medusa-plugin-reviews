import { useState } from 'react'
import { defineRouteConfig } from '@medusajs/admin-sdk'
import { ChatBubbleLeftRight } from '@medusajs/icons'
import ReviewTable from './components/review-table'

const ReviewsPage = () => {
  // Task 9 wires this into a detail drawer; for now the table owns the
  // full page layout and this just tracks which row was clicked.
  const [, setSelectedReviewId] = useState<string | null>(null)

  return <ReviewTable onSelect={setSelectedReviewId} />
}

export const config = defineRouteConfig({
  label: 'Reviews',
  icon: ChatBubbleLeftRight,
})

export default ReviewsPage
