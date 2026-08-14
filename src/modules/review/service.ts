import type { Knex } from 'knex'
import { Context } from '@medusajs/framework/types'
import { InjectManager, MedusaContext, MedusaError, MedusaService } from '@medusajs/framework/utils'
import { Review } from './models/review'
import { ReviewSettings } from './models/review-settings'
import { ReviewStats } from './models/review-stats'
import { ReviewMedia } from './models/review-media'
import { ReviewReply } from './models/review-reply'

// The only two EntityManager methods this module needs for a raw
// conditional UPDATE - narrowly typed locally rather than importing
// @mikro-orm/knex's SqlEntityManager, since @medusajs/framework/types
// exposes Context's manager as a generic TManager with no concrete export
// of its own for this shape.
type ReviewMediaManager = {
  getKnex(): Knex
  getTransactionContext(): Knex.Transaction | undefined
}

class ReviewModuleService extends MedusaService({
  Review,
  ReviewSettings,
  ReviewStats,
  ReviewMedia,
  ReviewReply,
}) {
  /**
   * Atomically claims not-yet-attached review_media rows for a review, via
   * a single conditional `UPDATE ... WHERE review_id IS NULL`, issued
   * through THIS module's own EntityManager/connection - never a
   * connection resolved from the app container. That is the point: this
   * module's manager targets whatever database this module is configured
   * with, by construction, so a consumer who enables module-level DB
   * isolation (a documented Medusa capability) can never silently diverge
   * from it - there is no separate connection to reach across to in the
   * first place. It also means the table/column names below are
   * self-referential to the module that owns this schema, not reaching
   * across a boundary.
   *
   * See src/workflows/steps/attach-review-media.ts for why this can't be
   * expressed through the generated updateReviewMedias(): MedusaService's
   * `{ selector, data }` update form still does its own SELECT-then-
   * update-by-primary-key under the hood and never re-applies the
   * selector's `review_id` condition to the actual UPDATE's WHERE clause -
   * the same race, one layer down, not removed.
   *
   * Returns the ids that were actually claimed - a subset of `mediaIds`
   * when one or more were already attached, whether from an earlier
   * request or a concurrent one that won the same race. The caller is
   * responsible for deciding what "fewer claimed than requested" means
   * (unknown vs. already-attached) and for releasing a partial claim.
   */
  @InjectManager()
  async claimMediaForReview(
    mediaIds: string[],
    reviewId: string,
    @MedusaContext() context: Context<ReviewMediaManager> = {}
  ): Promise<string[]> {
    const manager = context.manager

    if (!manager) {
      // @InjectManager() always populates this; this guard only exists so
      // a broken DI setup fails loudly instead of throwing a confusing
      // "getKnex is not a function" two lines down.
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'claimMediaForReview requires a manager from the review module context.'
      )
    }

    const knex = manager.getTransactionContext() ?? manager.getKnex()

    const claimed: { id: string }[] = await knex('review_media')
      .whereIn('id', mediaIds)
      .whereNull('review_id')
      .whereNull('deleted_at')
      .update({ review_id: reviewId, updated_at: new Date() })
      .returning('id')

    return claimed.map((row) => row.id)
  }

  /**
   * The mirror image of claimMediaForReview(), and atomic for exactly the
   * same reason. The orphan sweep used to SELECT its candidates and then
   * delete them by primary key, which is the same read-then-write-by-PK
   * race the claim above exists to avoid - only here the loser is a
   * customer whose photo is destroyed after their review was accepted:
   * `claimMediaForReview()` sets review_id in the window between the
   * sweep's read and its delete, the delete never re-checks review_id, and
   * both the row and the stored file go anyway with no error surfaced to
   * anyone.
   *
   * `whereNull('review_id')` in the DELETE's own WHERE clause is what
   * closes it: the database adjudicates, in one statement, and a row
   * claimed a microsecond earlier simply does not match. The generated
   * deleteReviewMedias() cannot express this - it deletes by id, and
   * MedusaService's `{ selector }` forms still resolve to primary keys
   * first (see claimMediaForReview above for the same limitation on the
   * update side).
   *
   * Returns the rows it actually removed, file_id included: the caller
   * deletes exactly those files and nothing else, so a row it did not win
   * can never have its bytes deleted from under a live review.
   */
  @InjectManager()
  async deleteUnattachedMedia(
    mediaIds: string[],
    @MedusaContext() context: Context<ReviewMediaManager> = {}
  ): Promise<{ id: string; file_id: string }[]> {
    if (!mediaIds.length) {
      return []
    }

    const manager = context.manager

    if (!manager) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'deleteUnattachedMedia requires a manager from the review module context.'
      )
    }

    const knex = manager.getTransactionContext() ?? manager.getKnex()

    const deleted: { id: string; file_id: string }[] = await knex('review_media')
      .whereIn('id', mediaIds)
      .whereNull('review_id')
      .whereNull('deleted_at')
      .del()
      .returning(['id', 'file_id'])

    return deleted
  }

  /**
   * THE enforcement point for "which media may a store endpoint show".
   *
   * Spec §6 requires that media of a non-approved review is never returned
   * by any store endpoint, "enforced in the service layer, not per-route".
   * The rule has two halves and both live here, so a route cannot express
   * one and forget the other:
   *
   *   1. the parent review must be `approved`, and
   *   2. the media itself must not be hidden (`hidden_at IS NULL`).
   *
   * Approval is re-derived from the reviews table rather than trusted from
   * the caller's id list, which is what makes this an enforcement point
   * instead of a shorthand. A caller that hands over unfiltered ids - the
   * Phase 4 gallery API is exactly the shape that will - still gets only
   * visible media back. There is deliberately no status column on
   * review_media to drift out of sync with the review it belongs to.
   *
   * The one deliberate exception is listOwnSubmissionMedia() below; it is a
   * separate, differently-named method precisely so that deviating from
   * this rule has to be a decision someone writes down.
   */
  @InjectManager()
  async listVisibleReviewMedias(
    reviewIds: string | string[],
    @MedusaContext() context: Context = {}
  ) {
    const ids = Array.isArray(reviewIds) ? reviewIds : [reviewIds]

    if (!ids.length) {
      return []
    }

    const approved = await this.listReviews(
      { id: ids, status: 'approved' },
      { select: ['id'], take: ids.length },
      context
    )

    if (!approved.length) {
      return []
    }

    // No `take`: identical to what the call sites passed before this
    // helper existed. The id set is already bounded by the caller (the
    // store list route caps `limit` at 100), so this is not the unbounded
    // scan the sweep and the stats recompute were.
    return await this.listReviewMedias(
      { review_id: approved.map((review) => review.id), hidden_at: null },
      undefined,
      context
    )
  }

  /**
   * The same rule as listVisibleReviewMedias(), counted rather than
   * materialised - an aggregate COUNT, so the denormalized stats summary
   * never loads media rows it only wants the size of.
   */
  @InjectManager()
  async countVisibleReviewMedias(
    reviewIds: string | string[],
    @MedusaContext() context: Context = {}
  ): Promise<number> {
    const ids = Array.isArray(reviewIds) ? reviewIds : [reviewIds]

    if (!ids.length) {
      return 0
    }

    const approved = await this.listReviews(
      { id: ids, status: 'approved' },
      { select: ['id'], take: ids.length },
      context
    )

    if (!approved.length) {
      return 0
    }

    const [, count] = await this.listAndCountReviewMedias(
      { review_id: approved.map((review) => review.id), hidden_at: null },
      { take: 1, select: ['id'] },
      context
    )

    return count
  }

  /**
   * The single, deliberate exception to the approved-only rule above: the
   * response to POST /store/reviews, echoing back the review the caller
   * just submitted. That review is normally still `pending`, but its media
   * is the submitter's own content and showing it back immediately is the
   * point of the response.
   *
   * It is a distinct method rather than a flag on listVisibleReviewMedias()
   * so the exception is impossible to take by accident: any new store
   * surface that reaches for "media for these reviews" finds the
   * approved-only method first, and using this one instead is a visible,
   * named choice. Never call this with a review id the caller did not just
   * create - it does not check approval, so it would expose an unmoderated
   * review's media to a third party.
   */
  @InjectManager()
  async listOwnSubmissionMedia(
    reviewId: string,
    @MedusaContext() context: Context = {}
  ) {
    return await this.listReviewMedias(
      { review_id: reviewId, hidden_at: null },
      undefined,
      context
    )
  }
}

export default ReviewModuleService
