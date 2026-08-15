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
import { resolveVoteSalt, ReviewModuleOptions } from '../../settings/vote-salt'

// The only two EntityManager methods this module needs for a raw
// conditional UPDATE - narrowly typed locally rather than importing
// @mikro-orm/knex's SqlEntityManager, since @medusajs/framework/types
// exposes Context's manager as a generic TManager with no concrete export
// of its own for this shape.
type ReviewMediaManager = {
  getKnex(): Knex
  getTransactionContext(): Knex.Transaction | undefined
}

export type GalleryMediaType = 'image' | 'video'

export type GalleryFilters = {
  product_id?: string
  type?: GalleryMediaType
}

export type GalleryMediaRow = {
  id: string
  review_id: string
  type: GalleryMediaType
  url: string
  thumbnail_url: string | null
  pinned_at: Date | null
  created_at: Date
  rating: number
  display_name: string
  product_id: string
}

/**
 * The route-level cap GalleryQuerySchema enforces (store/reviews/
 * middlewares.ts) is the primary gate - a request over this never reaches
 * the service at all. This is the second, service-level half of the same
 * cap (defense in depth, the same posture listGalleryMedia() takes with
 * approval below): a future caller that reaches listGalleryMedia() through
 * some new route or a direct workflow call, without going through that
 * Zod schema, still cannot force an unbounded scan of the largest, least
 * restricted list this plugin serves.
 */
export const GALLERY_MAX_LIMIT = 100
export const GALLERY_DEFAULT_LIMIT = 20

class ReviewModuleService extends MedusaService({
  Review,
  ReviewSettings,
  ReviewStats,
  ReviewMedia,
  ReviewReply,
  ReviewVote,
}) {
  /**
   * The salt voterHash() needs to turn a guest's IP+UA into a per-store
   * pseudonymous dedup key - resolution precedence (plugin options over
   * `REVIEW_VOTE_SALT`) and the "why undefined, never a hardcoded default"
   * reasoning both live in resolveVoteSalt()'s docstring
   * (src/settings/vote-salt.ts).
   *
   * `options` is this constructor's second argument because a module's own
   * top-level service is instantiated as `new moduleService(container,
   * resolution.options, resolution.moduleDeclaration)` -
   * @medusajs/modules-sdk's loadModuleResources does this for every module,
   * not only ones with a `providers` array. `resolution.options` is
   * whatever this module was registered with: `modules: [{ resolve:
   * './src/modules/review', options }]` in medusa-config.ts directly, or,
   * for a real npm install of this plugin, cascaded unchanged from a
   * host's `plugins: [{ resolve: '@stathmos/medusa-plugin-reviews',
   * options }]` by @medusajs/utils's getResolvedPlugins() (every module a
   * plugin declares receives that same top-level `options` object - this
   * plugin only declares one, so there is no namespacing to worry about).
   */
  private readonly voteSalt_: string | undefined

  constructor(container: Record<string, unknown>, options?: ReviewModuleOptions) {
    super(container)
    this.voteSalt_ = resolveVoteSalt(options)
  }

  /**
   * Never throws for a missing salt - only a guest vote's call to
   * voterHash() actually needs one (a signed-in customer's vote never
   * calls it at all, see cast-review-vote.ts), so a store that only
   * expects authenticated voters must not be broken by a salt nobody
   * configured. The "fail loudly rather than silently default" guarantee
   * lives in voterHash() itself, not here - it raises a MedusaError the
   * moment an empty/undefined salt actually reaches it.
   *
   * `async` purely to satisfy this codebase's lint rule that every public
   * service method be async - there is no I/O here, `voteSalt_` was
   * already resolved once in the constructor.
   */
  async getVoteSalt(): Promise<string | undefined> {
    return this.voteSalt_
  }

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
   * Inserts one review_vote row via a plain INSERT, issued through this
   * module's own EntityManager/connection (same reasoning as
   * claimMediaForReview() above - never a connection resolved from the app
   * container). Unlike claimMediaForReview()/upsertReviewReply(), a plain
   * INSERT has no read-then-write race to close: there is no existing row
   * to find first, so Task 1's two partial unique indexes are the only
   * thing that needs to adjudicate concurrent votes, and Postgres already
   * does that atomically for a single INSERT with no help needed here.
   *
   * Raw SQL rather than `this.createReviewVotes()` (the generated method)
   * for exactly one reason: catching the failure. A unique-index violation
   * from a raw `knex.raw INSERT` surfaces as a driver error with a stable
   * `.code === '23505'` (see PostgreSqlExceptionConverter), which this
   * method catches and translates into a MedusaError itself - see below.
   * `createReviewVotes()` goes through MikroORM's repository layer first,
   * which may or may not finish that translation for us depending on
   * whether it can parse a constraint name out of the driver error's
   * `.detail` (@medusajs/utils's dbErrorMapper) - relying on that would
   * make this method's error contract depend on an implementation detail
   * of a layer this plugin does not own.
   *
   * Exactly one of `customer_id`/`voter_hash` must be set and the other
   * null - the caller (cast-review-vote.ts) is responsible for that
   * invariant; this method does not re-derive or enforce it beyond what
   * Task 1's two partial unique indexes already guarantee at the database
   * level.
   */
  @InjectManager()
  async castVote(
    input: { review_id: string; customer_id: string | null; voter_hash: string | null },
    @MedusaContext() context: Context<ReviewMediaManager> = {}
  ): Promise<{
    id: string
    review_id: string
    customer_id: string | null
    voter_hash: string | null
    created_at: Date
  }> {
    const manager = context.manager

    if (!manager) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'castVote requires a manager from the review module context.'
      )
    }

    const knex = manager.getTransactionContext() ?? manager.getKnex()
    const now = new Date()

    try {
      const { rows } = await knex.raw(
        `insert into "review_vote" ("id", "review_id", "customer_id", "voter_hash", "created_at", "updated_at")
         values (?, ?, ?, ?, ?, ?)
         returning "id", "review_id", "customer_id", "voter_hash", "created_at"`,
        [
          generateEntityId(undefined, 'rvot'),
          input.review_id,
          input.customer_id,
          input.voter_hash,
          now,
          now,
        ]
      )

      return rows[0] as {
        id: string
        review_id: string
        customer_id: string | null
        voter_hash: string | null
        created_at: Date
      }
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new MedusaError(
          MedusaError.Types.CONFLICT,
          'You have already voted this review as helpful.'
        )
      }

      throw error
    }
  }

  /**
   * Hard-deletes the caller's own vote on a review, in one conditional
   * DELETE ... RETURNING rather than a SELECT to find it followed by a
   * delete by id - the same "let the database adjudicate in one statement"
   * reasoning as deleteUnattachedMedia() above. A find-then-delete here
   * would let two concurrent unvote requests for the same identity both
   * read "a vote exists", both delete it (the second deleting nothing but
   * not knowing that), and both tell their caller's step to decrement
   * `helpful_count` - double-decrementing a counter that only one vote ever
   * incremented. RETURNING tells the caller definitively whether a row was
   * actually removed.
   *
   * Deliberately a hard delete (spec §4): a soft-deleted row would still
   * satisfy Task 1's partial unique indexes' `deleted_at IS NULL`
   * predicate being false, which excludes it from the index rather than
   * freeing the slot outright - a hard delete is what lets the same
   * identity vote again afterwards without the row ever being useful to
   * keep around. Mirrors deleteReviewReplyStep's identical reasoning.
   *
   * Exactly one of `customer_id`/`voter_hash` identifies the caller - never
   * both, same invariant as castVote() above - so the WHERE clause matches
   * on whichever one is set.
   */
  @InjectManager()
  async withdrawVote(
    input: { review_id: string; customer_id: string | null; voter_hash: string | null },
    @MedusaContext() context: Context<ReviewMediaManager> = {}
  ): Promise<{
    id: string
    review_id: string
    customer_id: string | null
    voter_hash: string | null
  }> {
    const manager = context.manager

    if (!manager) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'withdrawVote requires a manager from the review module context.'
      )
    }

    const knex = manager.getTransactionContext() ?? manager.getKnex()

    const identity = input.customer_id
      ? { customer_id: input.customer_id }
      : { voter_hash: input.voter_hash }

    const deleted: {
      id: string
      review_id: string
      customer_id: string | null
      voter_hash: string | null
    }[] = await knex('review_vote')
      .where({ review_id: input.review_id, ...identity })
      .whereNull('deleted_at')
      .del()
      .returning(['id', 'review_id', 'customer_id', 'voter_hash'])

    if (!deleted.length) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Vote not found')
    }

    return deleted[0]
  }

  /**
   * THE only place `review.helpful_count` may be written. A single
   * conditional `UPDATE ... increment` issued through this module's own
   * EntityManager/connection - same atomicity reasoning as
   * claimMediaForReview() above, and for the same kind of reason: this
   * codebase has already lost concurrent increments twice to a
   * listReviews() -> `+1` in JS -> updateReviews() read-then-write, and
   * fixed it both times by moving to a single atomic statement. Never
   * reintroduce that shape for this counter.
   *
   * `delta` is signed rather than this being two methods
   * (incrementHelpfulCount/decrementHelpfulCount) because cast and
   * withdraw are otherwise identical callers - one atomic statement either
   * way, `+1` or `-1` - and their respective step compensations need the
   * exact same call shape in reverse.
   *
   * Returns the row's new count via the same UPDATE's RETURNING clause -
   * still one statement, not a second read - so callers (the vote route)
   * can report an authoritative fresh count without an extra round trip.
   */
  @InjectManager()
  async adjustHelpfulCount(
    reviewId: string,
    delta: number,
    @MedusaContext() context: Context<ReviewMediaManager> = {}
  ): Promise<number> {
    const manager = context.manager

    if (!manager) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'adjustHelpfulCount requires a manager from the review module context.'
      )
    }

    const knex = manager.getTransactionContext() ?? manager.getKnex()

    const updated: { helpful_count: number }[] = await knex('review')
      .where({ id: reviewId })
      .whereNull('deleted_at')
      .increment('helpful_count', delta)
      .returning('helpful_count')

    return updated[0]?.helpful_count ?? 0
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
   * Shared WHERE-clause builder for the gallery's list and count queries -
   * both call this and add only what differs (select/order/limit vs.
   * count), so the two can never quietly disagree about which rows
   * qualify. That agreement is the point: a gallery grid whose `count`
   * (used to render "page 3 of N") was computed against different
   * filters than the rows it paginates is the same class of bug Phase 3's
   * search fix had to correct for a JS-side filter, just reached a
   * different way - two independently-maintained WHERE clauses drifting
   * apart instead of one filter never reaching the database at all.
   *
   * A single joined query, not the two-step "approved review ids, then
   * media WHERE review_id IN (...)" shape listVisibleReviewMedias() above
   * uses. That shape is right for listVisibleReviewMedias(): its caller
   * already has a bounded, specific set of review ids (a page of reviews)
   * before it ever calls in. The gallery has no such id list - it is
   * either scoped to one product or genuinely global - so materialising
   * "every approved review's id" first would be the unbounded fetch this
   * method exists to avoid. A join lets Postgres apply approval,
   * `hidden_at`, `product_id` and `type` together, with its own indexes,
   * and hand back only the rows that already satisfy every filter.
   */
  private buildGalleryQuery(knex: Knex, filters: GalleryFilters): Knex.QueryBuilder {
    return knex('review_media as m')
      .innerJoin('review as r', 'r.id', 'm.review_id')
      .whereNull('m.deleted_at')
      .whereNull('m.hidden_at')
      .whereNull('r.deleted_at')
      .where('r.status', 'approved')
      .modify((qb) => {
        if (filters.product_id) {
          qb.andWhere('r.product_id', filters.product_id)
        }

        if (filters.type) {
          qb.andWhere('m.type', filters.type)
        }
      })
  }

  /**
   * THE enforcement point for "which media the gallery API may show" -
   * the same rule listVisibleReviewMedias() enforces above, re-derived
   * here for a caller shaped completely differently: the gallery route
   * has no id list to hand in at all (spec §5 - it is scoped by
   * `product_id`, optionally, or is the global site-wide gallery), which
   * is exactly the shape most likely to tempt a route into trusting its
   * own query params as the visibility filter instead of asking this
   * layer. It does not: approval is re-derived from a live JOIN against
   * `review` inside buildGalleryQuery() above, never trusted from
   * `filters`, so a route that forgets to pre-filter by status cannot
   * leak a pending or rejected review's photo into a public gallery.
   *
   * `hidden_at IS NULL` is applied the same way, for the same reason as
   * listVisibleReviewMedias(): a moderator's curation decision must hold
   * here too.
   *
   * Ordering and pagination happen in this one query, not in JS:
   * `pinned_at DESC NULLS LAST, created_at DESC` puts curated media
   * first, then newest - `NULLS LAST` is load-bearing, since Postgres's
   * default for a bare `DESC` sort treats NULL as the largest value and
   * would otherwise put every UNPINNED item ahead of pinned ones. `limit`
   * is clamped to GALLERY_MAX_LIMIT here too (see that constant's
   * docstring) before it ever reaches the database.
   */
  @InjectManager()
  async listGalleryMedia(
    filters: GalleryFilters & { limit?: number; offset?: number },
    @MedusaContext() context: Context<ReviewMediaManager> = {}
  ): Promise<GalleryMediaRow[]> {
    const manager = context.manager

    if (!manager) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'listGalleryMedia requires a manager from the review module context.'
      )
    }

    const knex = manager.getTransactionContext() ?? manager.getKnex()

    const limit = Math.min(
      Math.max(filters.limit ?? GALLERY_DEFAULT_LIMIT, 1),
      GALLERY_MAX_LIMIT
    )
    const offset = Math.max(filters.offset ?? 0, 0)

    return await this.buildGalleryQuery(knex, filters)
      .select(
        'm.id as id',
        'm.review_id as review_id',
        'm.type as type',
        'm.url as url',
        'm.thumbnail_url as thumbnail_url',
        'm.pinned_at as pinned_at',
        'm.created_at as created_at',
        'r.rating as rating',
        'r.display_name as display_name',
        'r.product_id as product_id'
      )
      .orderByRaw('m.pinned_at DESC NULLS LAST, m.created_at DESC')
      .limit(limit)
      .offset(offset)
  }

  /**
   * The gallery's total-match count, counted rather than materialised -
   * same reasoning as countVisibleReviewMedias() above. Built on the exact
   * same buildGalleryQuery() as listGalleryMedia(), so `count` can never
   * disagree with what paging through `media` actually returns; see that
   * method's own docstring for why that agreement is the point.
   *
   * Deliberately has no `limit`/`offset` parameter - a COUNT has no
   * pagination to bound. GALLERY_MAX_LIMIT still governs it indirectly:
   * because both queries share buildGalleryQuery(), the identical
   * approval/hidden_at/product_id/type predicate that keeps
   * listGalleryMedia() from ever paginating past a wider set of rows than
   * this counts.
   */
  @InjectManager()
  async countGalleryMedia(
    filters: GalleryFilters,
    @MedusaContext() context: Context<ReviewMediaManager> = {}
  ): Promise<number> {
    const manager = context.manager

    if (!manager) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'countGalleryMedia requires a manager from the review module context.'
      )
    }

    const knex = manager.getTransactionContext() ?? manager.getKnex()

    const [{ count }] = (await this.buildGalleryQuery(knex, filters).count({
      count: 'm.id',
    })) as { count: string }[]

    return Number(count)
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
