import { defineRouteConfig } from '@medusajs/admin-sdk'
import { ChatBubbleLeftRight } from '@medusajs/icons'
import { Container, Heading } from '@medusajs/ui'

const ReviewsPage = () => {
  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Reviews</Heading>
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: 'Reviews',
  icon: ChatBubbleLeftRight,
})

export default ReviewsPage
