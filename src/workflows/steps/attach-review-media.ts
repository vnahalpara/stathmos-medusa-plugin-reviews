import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk'
import { MedusaError } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../modules/review'
import { getReviewSettings } from '../../settings/get-review-settings'

type Input = { review_id: string; media_ids: string[] }

/**
 * Media is uploaded anonymously (Task 4) before the review that will own it
 * exists, so `media_ids` arriving here are bare, guessable-looking ids with
 * no proof of who uploaded them. Refusing an id that is already attached to
 * a review is what stops one shopper claiming another shopper's uploaded
 * photo by guessing or reusing its id - see the atomic claim below, which is
 * the load-bearing logic for this step.
 *
 * LANDMINE for whoever builds delete-review or media reassignment: the only
 * thing that ever sets a claimed row's review_id back to null today is this
 * step's own compensation, which only runs within the same createReviewWorkflow
 * run that claimed it. moderateReviewsWorkflow never touches review_media, so
 * a *rejected* review's media stays claimed forever - there is no orphan-sweep
 * or moderation path that frees it. That is fine today (nothing needs those
 * ids back), but a future feature that deletes or reassigns a review must
 * explicitly null out review_id on its media first, or those rows strand
 * permanently attached to a review that no longer exists / no longer wants them.
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
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Unknown media')
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
    const settings = await getReviewSettings(container)
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

      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Media is already attached to a review'
      )
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
