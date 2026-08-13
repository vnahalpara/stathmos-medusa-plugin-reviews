import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { createRemoteLinkStep, emitEventStep } from '@medusajs/medusa/core-flows'
import { Modules } from '@medusajs/framework/utils'
import { checkVerifiedPurchaseStep } from './steps/check-verified-purchase'
import { validateReviewSubmissionStep } from './steps/validate-review-submission'
import { createReviewStep } from './steps/create-review'
import { recomputeReviewStatsStep } from './steps/recompute-review-stats'
import { REVIEW_MODULE } from '../modules/review'

export type CreateReviewInput = {
  product_id: string
  rating: number
  content: string
  title?: string | null
  display_name?: string | null
  email?: string | null
  customer_id?: string | null
}

export const createReviewWorkflow = createWorkflow(
  'create-review',
  function (input: CreateReviewInput) {
    const isVerified = checkVerifiedPurchaseStep({
      customer_id: input.customer_id,
      product_id: input.product_id,
    })

    const validation = validateReviewSubmissionStep(
      transform({ input, isVerified }, (data) => ({
        product_id: data.input.product_id,
        content: data.input.content,
        customer_id: data.input.customer_id,
        is_verified_purchase: data.isVerified,
      }))
    )

    const review = createReviewStep(
      transform({ input, isVerified, validation }, (data) => ({
        product_id: data.input.product_id,
        customer_id: data.input.customer_id,
        display_name: data.input.display_name || 'Anonymous',
        email: data.input.email,
        rating: data.input.rating,
        title: data.input.title,
        content: data.input.content,
        status: data.validation.status,
        is_verified_purchase: data.isVerified,
      }))
    )

    // Order matters: review first, then product, matching src/links/review-product.ts's
    // defineLink call. A mismatched order fails at runtime.
    createRemoteLinkStep(
      transform({ review, input }, (data) => [
        {
          [REVIEW_MODULE]: { review_id: data.review.id },
          [Modules.PRODUCT]: { product_id: data.input.product_id },
        },
      ])
    )

    // An auto-approved review is immediately public, so the summary must
    // already reflect it by the time this workflow returns.
    recomputeReviewStatsStep(
      transform({ input }, (data) => ({ product_id: data.input.product_id }))
    )

    emitEventStep(
      transform({ review }, (data) => ({
        eventName: 'review.created',
        data: { id: data.review.id },
      }))
    )

    return new WorkflowResponse(review)
  }
)
