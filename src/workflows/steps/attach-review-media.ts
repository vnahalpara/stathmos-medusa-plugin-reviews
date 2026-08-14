import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'
import { getReviewSettings } from '../../settings/get-review-settings'

type Input = { review_id: string; media_ids: string[] }

/**
 * ONE error for both "no such media id" and "that media id is already
 * attached to a review". They used to be distinguishable - a 404 "Unknown
 * media" versus a 400 "Media is already attached to a review" - which is a
 * clean existence oracle over the id space: anyone with a publishable key
 * could probe whether a given `rmed_` id exists by reading the status code.
 *
 * That is immaterial against 80-bit ULIDs, but it costs nothing to close
 * and the two cases are indistinguishable from the caller's side anyway:
 * both mean "this id is not available for you to attach". Any future gate
 * that refuses an id (an ownership check, an expiry) must reuse this, or it
 * reopens the oracle from a new angle.
 */
function unavailableMediaError(): MedusaError {
  return new MedusaError(
    MedusaError.Types.NOT_FOUND,
    'Unknown or unavailable media'
  )
}

/**
 * Media is uploaded anonymously (Task 4) before the review that will own it
 * exists, so `media_ids` arriving here are bare ids with no proof of who
 * uploaded them.
 *
 * Be precise about what that means, because an earlier version of this
 * docstring overstated it. Refusing an id that is ALREADY attached is what
 * stops a second shopper reusing media that a review already owns. It does
 * NOT stop one shopper claiming another shopper's photo during the window
 * between upload and attachment - that window is the orphan TTL, 24 hours
 * by default, and there is no ownership binding in it: no session, no
 * signed token, no HMAC. Anyone holding an unattached media id can attach
 * it to their own review with nothing but a publishable key.
 *
 * What actually keeps that from being exploitable is that the ids are not
 * discoverable: `rmed_` ids are ULIDs (80 bits of randomness), so the only
 * realistic path is a leaked id - a shared draft, browser history, a
 * referrer, a log line. Closing the window properly needs a signed
 * upload token, which changes the public upload response contract and
 * belongs with Phase 6's auth work, so it is deliberately not done here.
 *
 * The atomic claim below is still the load-bearing logic of this step; it
 * just guards a narrower thing than the old wording claimed.
 *
 * LANDMINE for whoever builds delete-review (deleting the whole review
 * record) or media reassignment between reviews: the only thing that ever
 * sets a claimed row's review_id back to null is this step's own
 * compensation, which only runs within the same createReviewWorkflow run
 * that claimed it. Rejection is no longer an instance of this landmine -
 * see below - but nothing else nulls review_id or otherwise frees these
 * rows. A future feature that deletes a whole review record, or reassigns
 * media between reviews, must still explicitly handle its media first (null
 * out review_id, or delete it outright), or those rows strand permanently
 * attached to a review that no longer exists / no longer wants them.
 *
 * Rejection itself is handled, and has been since the reject-deletes-media
 * change: deleteRejectedReviewMediaWorkflow (src/workflows/delete-rejected-
 * review-media.ts) deletes every row belonging to a review AND each row's
 * underlying file - file before row, same reasoning as
 * delete-review-media.ts - the moment that review is rejected, via
 * POST /admin/reviews/:id/reject or POST /admin/reviews/batch/status. It
 * runs as its own top-level workflow, started by those routes only after
 * moderateReviewsWorkflow's status-change run has already committed - see
 * that file's docstring for why it must never be composed into
 * moderateReviewsWorkflow's own saga. This is deliberately irreversible: a
 * reversible alternative (soft-delete, a private-access flip, a settings
 * toggle) was considered and declined in favour of actually destroying
 * rejected content, so a moderator who rejects a review for an offensive
 * photo now removes it from storage, not only from the storefront. See the
 * README's media section for the full detail.
 */
export const attachReviewMediaStep = createStep(
  'attach-review-media',
  async (input: Input, { container }) => {
    if (!input.media_ids.length) {
      return new StepResponse({ attached: [] as string[] }, [] as string[])
    }

    // Dedup once, up front: every check and every query below (existence,
    // the atomic claim, sort_order assignment) operates on this list, so a
    // duplicate id submitted twice in one batch can never desync a count
    // check from a write.
    const uniqueIds = [...new Set(input.media_ids)]

    const service = container.resolve(REVIEW_MODULE)
    const rows = await service.listReviewMedias({ id: uniqueIds })

    // Set membership, not a length comparison against the raw input: a
    // batch containing the same id twice would under-count against
    // media_ids.length and wrongly report "unknown media" even though
    // every id is valid. uniqueIds is already deduped, so this comparison
    // is exact.
    if (rows.length !== uniqueIds.length) {
      throw unavailableMediaError()
    }

    // Both settings are re-checked here, not only in the upload step.
    // Uploads live for the orphan TTL (24h by default), so a merchant who
    // switches media off would otherwise keep receiving media on new
    // reviews for a full day from ids uploaded before the switch - a
    // merchant-facing toggle that does not actually toggle. This is the
    // same reasoning that made max_media_per_review a per-review cap
    // enforced here rather than a per-upload-call one.
    //
    // It runs before the atomic claim below, so a rejection here can never
    // leave any of uniqueIds claimed.
    const settings = await getReviewSettings(container)

    if (!settings.allow_media) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Media uploads are disabled'
      )
    }

    if (!settings.allow_video && rows.some((row) => row.type === 'video')) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Video uploads are disabled'
      )
    }

    // max_media_per_review is a per-review cap, not a per-upload-call cap -
    // the upload step's own count check (upload-review-media-files.ts) only
    // ever sees one request's file list and cannot know what a review
    // already has attached, so it is a cheap early reject, not the
    // enforcement point for the setting's actual name/contract. This is
    // that enforcement point: it accounts for whatever is already attached
    // to this review plus what this call is about to add, and it runs
    // before the atomic claim below so a rejection here can never leave
    // any of uniqueIds claimed - nothing has touched the database for this
    // batch yet at this point in the step, so there is nothing to release.
    const alreadyAttached = await service.listReviewMedias({ review_id: input.review_id })

    if (alreadyAttached.length + uniqueIds.length > settings.max_media_per_review) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `A review may have at most ${settings.max_media_per_review} media item(s)`
      )
    }

    // The read above cannot be trusted as the basis for the claim: it is a
    // separate DB round trip from the write, so two concurrent
    // createReviewWorkflow runs submitting the same not-yet-attached media
    // id could both see review_id === null here before either write
    // commits - last write wins, and both callers believe they succeeded.
    // service.updateReviewMedias() cannot close this window either, even
    // given a `{ selector, data }` filter: MedusaService's generated
    // update() always does its own SELECT-then-per-entity-UPDATE-by-
    // primary-key under the hood (see AbstractService.update in
    // @medusajs/utils), which never re-applies the selector's review_id
    // condition to the actual UPDATE's WHERE clause - it is the exact same
    // race shifted one layer down, not removed. A single conditional
    // UPDATE ... WHERE review_id IS NULL, issued directly, is the only
    // thing that lets the database itself decide who wins - done in
    // claimMediaForReview() on the review module's own service, through
    // its own EntityManager/connection, so an isolated module database
    // (a documented Medusa capability) is never silently bypassed the way
    // resolving a shared connection from the app container would risk.
    const claimedIds = await service.claimMediaForReview(uniqueIds, input.review_id)

    if (claimedIds.length !== uniqueIds.length) {
      // Partial success is possible: the claim above locks in whichever
      // ids were still unattached at the instant it ran, so some ids in
      // this batch may have committed while others - already attached at
      // read time, or claimed by a concurrent request in the window
      // between the read above and this write - did not. The orchestrator
      // only compensates steps that already returned a StepResponse, and
      // this invocation is about to throw without returning one, so
      // nothing will undo a partial claim automatically. Release whatever
      // this call did manage to claim itself, then refuse the whole batch.
      if (claimedIds.length) {
        await service.updateReviewMedias(claimedIds.map((id) => ({ id, review_id: null })))
      }

      // Deliberately the same error the existence check raises - see
      // unavailableMediaError().
      throw unavailableMediaError()
    }

    // Every id in this batch is now exclusively claimed by this review -
    // no concurrent request can be racing to touch these specific rows
    // (their review_id is no longer null, so nobody else's claim query can
    // match them), so a plain, non-atomic update for the cosmetic gallery
    // order is safe here.
    await service.updateReviewMedias(uniqueIds.map((id, i) => ({ id, sort_order: i })))

    return new StepResponse({ attached: uniqueIds }, uniqueIds)
  },
  async (mediaIds, { container }) => {
    if (!mediaIds?.length) {
      return
    }

    const service = container.resolve(REVIEW_MODULE)
    await service.updateReviewMedias(mediaIds.map((id) => ({ id, review_id: null })))
  }
)
