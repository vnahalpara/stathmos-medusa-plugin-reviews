import { defineLink } from '@medusajs/framework/utils'
import ProductModule from '@medusajs/medusa/product'
import ReviewModule from '../modules/review'

// Order matters: review first, then product. createRemoteLinkStep must use
// the same order or linking fails at runtime.
export default defineLink(
  { linkable: ReviewModule.linkable.review, isList: true },
  ProductModule.linkable.product
)
