import { MedusaService } from '@medusajs/framework/utils'
import { Review } from './models/review'
import { ReviewSettings } from './models/review-settings'

class ReviewModuleService extends MedusaService({ Review, ReviewSettings }) {}

export default ReviewModuleService
