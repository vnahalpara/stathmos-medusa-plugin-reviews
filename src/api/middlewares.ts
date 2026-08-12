import { defineMiddlewares } from '@medusajs/framework/http'
import { adminReviewMiddlewares } from './admin/reviews/middlewares'

export default defineMiddlewares({
  routes: [...adminReviewMiddlewares],
})
