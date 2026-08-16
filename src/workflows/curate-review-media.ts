import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { setMediaCurationStep } from './steps/set-media-curation'

export type CurateReviewMediaInput = {
  id: string
  pinned?: boolean
  hidden?: boolean
}

export const curateReviewMediaWorkflow = createWorkflow(
  'curate-review-media',
  function (input: CurateReviewMediaInput) {
    const result = setMediaCurationStep(input)

    // The most time-critical event this plugin emits. Hiding is the control
    // a moderator reaches for when a photo must come down NOW - the gallery
    // route serves `s-maxage=60, stale-while-revalidate=300`, so without an
    // event a CDN can keep serving a hidden photo for roughly six more
    // minutes after the moderator hid it. `product_id` is what makes that
    // actionable: a subscriber needs to know which product page (and the
    // store-wide gallery) to invalidate.
    //
    // Pinning emits the same event as hiding, deliberately - both change
    // what a cached gallery should show, and a subscriber that revalidates
    // has no use for the distinction. The media id is on the payload for a
    // subscriber that wants to look the row up itself.
    //
    // `when`, because an unattached media row (review_id null, so no
    // product) has never appeared on any storefront page: there is nothing
    // to revalidate, and an event carrying `product_id: null` would just
    // make every subscriber write the same guard.
    when({ result }, (data) => Boolean(data.result.product_id)).then(() => {
      emitEventStep(
        transform({ result }, (data) => ({
          eventName: 'review.media.curated',
          data: {
            id: data.result.media.id,
            review_id: data.result.review_id,
            product_id: data.result.product_id,
          },
        }))
      )
    })

    return new WorkflowResponse(result.media)
  }
)
