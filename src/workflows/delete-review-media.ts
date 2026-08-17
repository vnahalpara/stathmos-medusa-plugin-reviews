import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk'
import { emitEventStep } from '@medusajs/medusa/core-flows'
import { deleteReviewMediaStep } from './steps/delete-review-media'

// Deliberately does not recompute review stats here: recomputing is a
// service call, and a composition function cannot run arbitrary async code,
// only wire steps together. Adding a whole step for this one caller is not
// worth it, so the route calls recomputeReviewStats(container, productId)
// directly after this workflow returns, using the `product_id` the step now
// resolves for the event below.
export const deleteReviewMediaWorkflow = createWorkflow(
  'delete-review-media',
  function (input: { id: string }) {
    const deleted = deleteReviewMediaStep(input)

    // Deletion is the more final half of the pair curation started: hiding
    // a photo is instantly revalidated, and it would be absurd for
    // DELETING one - the action a moderator takes when an image must never
    // be served again - to leave it in a CDN for another
    // stale-while-revalidate window (the gallery is served `s-maxage=60,
    // stale-while-revalidate=300`). Same payload shape as
    // `review.media.curated`, so one subscriber handles both.
    //
    // `review_id` is on the payload even though the row is already gone -
    // it is the only trace left of which review the media belonged to, and
    // a subscriber doing anything but revalidating (an audit log, say)
    // cannot look it up afterwards.
    //
    // `when`, for the same reason as curation: an unattached upload has
    // never been on any storefront page, so there is nothing to
    // invalidate. That is also the ordinary case for media the orphan
    // sweep would have collected - though the sweep itself deletes through
    // the service, not this workflow, so it never reaches here at all.
    when({ deleted }, (data) => Boolean(data.deleted.product_id)).then(() => {
      emitEventStep(
        transform({ deleted }, (data) => ({
          eventName: 'review.media.deleted',
          data: {
            id: data.deleted.id,
            review_id: data.deleted.review_id,
            product_id: data.deleted.product_id,
          },
        }))
      )
    })

    return new WorkflowResponse(deleted)
  }
)
