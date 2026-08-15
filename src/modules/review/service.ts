import type { Knex } from 'knex'
import { Context, InferEntityType } from '@medusajs/framework/types'
import {
  generateEntityId,
  InjectManager,
  MedusaContext,
  MedusaError,
  MedusaService,
} from '@medusajs/framework/utils'
import { Review } from './models/review'
import { ReviewSettings } from './models/review-settings'
import { ReviewStats } from './models/review-stats'
import { ReviewMedia } from './models/review-media'
import { ReviewReply } from './models/review-reply'
import { ReviewVote } from './models/review-vote'

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
  ReviewVote,
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
   * Creates the review's reply if it has none, or edits the existing one in
   * place - one statement, not a read-then-branch. That shape is exactly
   * the race `claimMediaForReview`'s docstring warns about at length: two
   * concurrent first replies to the same review would both read "no
   * existing reply" and both attempt `createReviewReplies`, and the loser
   * would hit Task 1's partial unique index as a raw constraint violation -
   * surfaced by Medusa's generated repository as a confusing 400
   * "already exists" instead of the upsert-to-edit this endpoint
   * advertises. A single `INSERT ... ON CONFLICT (review_id) WHERE
   * deleted_at IS NULL DO UPDATE`, issued through this module's own
   * EntityManager/connection (never a connection resolved from the app
   * container - same reasoning as `claimMediaForReview`), lets Postgres
   * resolve the race atomically: the conflict target matches Task 1's
   * partial unique index exactly, so a losing concurrent insert becomes an
   * update within the same statement instead of a second, failing write.
   *
   * `(xmax = 0) AS inserted` is how the caller learns which branch fired,
   * which it needs both for compensation (hard-delete a fresh reply vs.
   * restore text on a rolled-back edit) and for the emitted event
   * (`review.reply.created` vs `.updated`). This is not SQL-standard, but
   * it is a long-relied-upon Postgres implementation detail: a freshly
   * inserted tuple's `xmax` is 0, while the tuple `ON CONFLICT DO UPDATE`
   * produces carries a non-zero `xmax` left over from the superseded insert
   * attempt. Verified empirically, not just trusted from folklore - see the
   * concurrent-first-reply test in `admin-reply.spec.ts` (asserts exactly
   * one row survives two simultaneous first replies) and the event-name
   * assertions in the same file (which would fail if `inserted` ever came
   * back wrong for either branch).
   */
  @InjectManager()
  async upsertReviewReply(
    input: { review_id: string; content: string; replied_by: string | null },
    @MedusaContext() context: Context<ReviewMediaManager> = {}
  ): Promise<{
    id: string
    review_id: string
    content: string
    replied_by: string | null
    created_at: Date
    updated_at: Date
    created: boolean
  }> {
    const manager = context.manager

    if (!manager) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'upsertReviewReply requires a manager from the review module context.'
      )
    }

    const knex = manager.getTransactionContext() ?? manager.getKnex()
    const now = new Date()

    const { rows } = await knex.raw(
      `insert into "review_reply" ("id", "review_id", "content", "replied_by", "created_at", "updated_at")
       values (?, ?, ?, ?, ?, ?)
       on conflict ("review_id") where "deleted_at" is null
       do update set
         "content" = excluded."content",
         "replied_by" = excluded."replied_by",
         "updated_at" = excluded."updated_at"
       returning
         "id", "review_id", "content", "replied_by", "created_at", "updated_at",
         (xmax = 0) as "inserted"`,
      [
        generateEntityId(undefined, 'rrep'),
        input.review_id,
        input.content,
        input.replied_by,
        now,
        now,
      ]
    )

    const row = rows[0] as {
      id: string
      review_id: string
      content: string
      replied_by: string | null
      created_at: Date
      updated_at: Date
      inserted: boolean
    }

    return {
      id: row.id,
      review_id: row.review_id,
      content: row.content,
      replied_by: row.replied_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created: row.inserted,
    }
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
   * Per-review media counts for a moderation list - `{ [review_id]: count }`
   * - via a single grouped `COUNT(*) ... GROUP BY review_id` over the given
   * ids, not a query per review. Built for GET /admin/reviews: fetching a
   * page of reviews and then counting each one's media individually would
   * be N+1, and a naive per-row call is exactly the "0 photos on every
   * row" bug this method exists to fix.
   *
   * Deliberately counts ALL non-deleted media attached to each review,
   * INCLUDING rows with `hidden_at` set - this is NOT the same rule as
   * listVisibleReviewMedias()/countVisibleReviewMedias() above, which
   * enforce the store-facing "approved review + not hidden" visibility
   * rule. A moderator reviewing a queue needs to see what is actually
   * attached to a review, hidden or not - reusing the store-facing method
   * here would silently undercount media a moderator has already hidden.
   * Do not swap this for countVisibleReviewMedias(): the two counts
   * intentionally answer different questions for different audiences and
   * are not meant to agree.
   *
   * Issued through this module's own EntityManager/connection, same
   * reasoning as claimMediaForReview()/deleteUnattachedMedia() above - no
   * connection resolved from the app container.
   */
  @InjectManager()
  async countMediaByReview(
    reviewIds: string[],
    @MedusaContext() context: Context<ReviewMediaManager> = {}
  ): Promise<Record<string, number>> {
    if (!reviewIds.length) {
      return {}
    }

    const manager = context.manager

    if (!manager) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'countMediaByReview requires a manager from the review module context.'
      )
    }

    const knex = manager.getTransactionContext() ?? manager.getKnex()

    const rows: { review_id: string; count: string }[] = await knex('review_media')
      .select('review_id')
      .count({ count: '*' })
      .whereIn('review_id', reviewIds)
      .whereNull('deleted_at')
      .groupBy('review_id')

    const counts: Record<string, number> = {}

    for (const row of rows) {
      counts[row.review_id] = Number(row.count)
    }

    return counts
  }

  /**
   * THE enforcement point for "which replies may a store endpoint show".
   *
   * A reply must never appear on a store route unless its parent review is
   * `approved`. Approval is re-derived from the reviews table rather than
   * trusted from the caller's id list, so a route that hands over
   * unfiltered ids still cannot leak a reply attached to a pending or
   * rejected review. Mirrors listVisibleReviewMedias() deliberately - the
   * two rules are the same rule and should read the same way.
   *
   * `replied_by` is part of the row this returns (it is not a store-facing
   * shape) - callers building a store response must allow-list fields
   * rather than spread it. See ReviewReply's model comment and the
   * store products/[id]/reviews route for the enforcement of that half of
   * the rule.
   */
  @InjectManager()
  async listVisibleReviewReplies(
    reviewIds: string | string[],
    @MedusaContext() context: Context = {}
  ): Promise<InferEntityType<typeof ReviewReply>[]> {
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

    return this.listReviewReplies(
      { review_id: approved.map((r) => r.id) },
      undefined,
      context
    )
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
