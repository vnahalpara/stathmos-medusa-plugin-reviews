import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { checkVerifiedPurchaseStep } from './steps/check-verified-purchase'
import { validateReviewSubmissionStep } from './steps/validate-review-submission'
import { createReviewStep } from './steps/create-review'
import { recomputeReviewStatsStep } from './steps/recompute-review-stats'
import { attachReviewMediaStep } from './steps/attach-review-media'

export type CreateReviewInput = {
  product_id: string
  rating: number
  content: string
  title?: string | null
  display_name?: string | null
  email?: string | null
  customer_id?: string | null
  media_ids?: string[]
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

    attachReviewMediaStep(
      transform({ review, input }, (data) => ({
        review_id: data.review.id,
        media_ids: data.input.media_ids || [],
      }))
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
    ).config({ name: 'emit-review-created' })

    // A store with `require_approval: false` publishes a submission the
    // moment it is made: nobody moderates it, so moderateReviewsWorkflow -
    // the only other emitter of `review.approved` - never runs for it, and
    // until this existed the single event that says "a review became
    // publicly visible" simply never fired on those stores. A host
    // revalidating its PDP cache on `review.approved` would have worked on
    // an approval-gated store and silently done nothing on an auto-
    // approving one.
    //
    // Deliberately the SAME event name rather than a new one, and emitted
    // IN ADDITION TO `review.created` rather than instead of it: a host
    // subscribes to `review.approved` once and covers both routes to
    // publication, and anything already counting submissions on
    // `review.created` keeps seeing every submission.
    //
    // The condition reads the persisted review's own status, not
    // `validation.status`: the row is what the storefront will serve.
    when({ review }, (data) => data.review.status === 'approved').then(() => {
      emitEventStep(
        transform({ review }, (data) => ({
          eventName: 'review.approved',
          data: { id: data.review.id, product_id: data.review.product_id },
        }))
      ).config({ name: 'emit-review-approved' })
    })

    return new WorkflowResponse(review)
  }
)
