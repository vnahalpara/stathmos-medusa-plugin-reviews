import type { Knex } from 'knex'
import { Context } from '@medusajs/framework/types'
import { InjectManager, MedusaContext, MedusaError, MedusaService } from '@medusajs/framework/utils'
import { Review } from './models/review'
import { ReviewSettings } from './models/review-settings'
import { ReviewStats } from './models/review-stats'
import { ReviewMedia } from './models/review-media'

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
}

export default ReviewModuleService
