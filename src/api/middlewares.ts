import { defineMiddlewares } from '@medusajs/framework/http'
import { adminReviewMiddlewares } from './admin/reviews/middlewares'
import { storeReviewMiddlewares } from './store/reviews/middlewares'

export default defineMiddlewares({
  routes: [...adminReviewMiddlewares, ...storeReviewMiddlewares],
})
