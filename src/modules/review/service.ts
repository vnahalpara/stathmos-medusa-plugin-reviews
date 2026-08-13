import { MedusaService } from '@medusajs/framework/utils'
import { Review } from './models/review'
import { ReviewSettings } from './models/review-settings'
import { ReviewStats } from './models/review-stats'

class ReviewModuleService extends MedusaService({
  Review,
  ReviewSettings,
  ReviewStats,
}) {}

export default ReviewModuleService
