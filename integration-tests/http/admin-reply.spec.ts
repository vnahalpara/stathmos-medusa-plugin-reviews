import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { createAdminUser, adminHeaders } from '../helpers/admin'
import { emittedEvents, REVIEW_WORKFLOW_EVENTS } from '../helpers/events'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('review_reply model', () => {
      it('stores one reply per review and refuses a second', async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const review = await service.createReviews({
          product_id: 'prod_reply',
          display_name: 'A',
          rating: 5,
          content: 'x'.repeat(10),
        })

        const reply = await service.createReviewReplies({
          review_id: review.id,
          content: 'Thanks for the feedback!',
          replied_by: 'usr_test',
        })
        expect(reply.id).toMatch(/^rrep_/)

        await expect(
          service.createReviewReplies({
            review_id: review.id,
            content: 'Second reply',
            replied_by: 'usr_other',
          })
        ).rejects.toThrow()
      })

      it('frees the review_id for a new reply once the old one is soft-deleted', async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const review = await service.createReviews({
          product_id: 'prod_reply_2',
          display_name: 'B',
          rating: 4,
          content: 'y'.repeat(10),
        })

        const firstReply = await service.createReviewReplies({
          review_id: review.id,
          content: 'First reply',
          replied_by: 'usr_test',
        })

        await service.softDeleteReviewReplies(firstReply.id)

        const secondReply = await service.createReviewReplies({
          review_id: review.id,
          content: 'Second reply after delete',
          replied_by: 'usr_test',
        })
        expect(secondReply.id).toMatch(/^rrep_/)
        expect(secondReply.id).not.toEqual(firstReply.id)
      })
    })

    describe('POST /admin/reviews/:id/reply', () => {
      let reviewId: string

      beforeEach(async () => {
        await createAdminUser(getContainer())

        const service = getContainer().resolve(REVIEW_MODULE)
        const review = await service.createReviews({
          product_id: 'prod_reply_admin',
          display_name: 'C',
          rating: 5,
          content: 'z'.repeat(10),
        })
        reviewId = review.id
      })

      afterEach(() => {
        jest.restoreAllMocks()
      })

      it('creates a reply, then updates it in place', async () => {
        const created = await api.post(
          `/admin/reviews/${reviewId}/reply`,
          { content: 'Thanks!' },
          adminHeaders
        )
        expect(created.status).toEqual(200)
        expect(created.data.reply.content).toEqual('Thanks!')

        const updated = await api.post(
          `/admin/reviews/${reviewId}/reply`,
          { content: 'Thanks, updated.' },
          adminHeaders
        )
        expect(updated.status).toEqual(200)
        expect(updated.data.reply.id).toEqual(created.data.reply.id)
        expect(updated.data.reply.content).toEqual('Thanks, updated.')

        const service = getContainer().resolve(REVIEW_MODULE)
        const all = await service.listReviewReplies({ review_id: reviewId })
        expect(all).toHaveLength(1)
      })

      it('resolves two concurrent first replies without a double-insert or a failed request', async () => {
        // Regression test for the read-then-branch race the atomic
        // upsertReviewReply() service method replaced: two requests with no
        // existing reply used to both observe "none exists" and race each
        // other into the partial unique index, with the loser failing a
        // raw constraint violation instead of landing as an edit. Both must
        // now succeed, and the database - not application logic - decides
        // which one becomes the create and which becomes the edit.
        const [first, second] = await Promise.all([
          api.post(`/admin/reviews/${reviewId}/reply`, { content: 'Reply A' }, adminHeaders),
          api.post(`/admin/reviews/${reviewId}/reply`, { content: 'Reply B' }, adminHeaders),
        ])

        expect(first.status).toEqual(200)
        expect(second.status).toEqual(200)

        const service = getContainer().resolve(REVIEW_MODULE)
        const all = await service.listReviewReplies({ review_id: reviewId })
        expect(all).toHaveLength(1)
      })

      /**
       * Two distinct events (a first reply is not an edit), each carrying
       * the PRODUCT the reply is rendered on - a reply row knows only its
       * `review_id`, and a subscriber invalidating a cached product page
       * cannot act on that.
       *
       * The decoy is free here and load-bearing: the `beforeEach` review
       * on `prod_reply_admin` was created BEFORE this one, so an
       * unfiltered `listReviews(..., { take: 1 })` in the step that
       * resolves the product returns that one instead, and the assertion
       * below fails on the wrong product id. A single-review version of
       * this test would pass either way.
       */
      it("emits review.reply.created then review.reply.updated, each carrying the review's product_id", async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_reply_events',
          display_name: 'Ada',
          rating: 5,
          content: 'x'.repeat(20),
        })

        const emitSpy = jest.spyOn(container.resolve(Modules.EVENT_BUS), 'emit')

        await api.post(`/admin/reviews/${review.id}/reply`, { content: 'Thanks!' }, adminHeaders)
        expect(emittedEvents(emitSpy, REVIEW_WORKFLOW_EVENTS)).toEqual([
          {
            name: 'review.reply.created',
            data: { review_id: review.id, product_id: 'prod_reply_events' },
          },
        ])

        emitSpy.mockClear()

        await api.post(
          `/admin/reviews/${review.id}/reply`,
          { content: 'Thanks, updated.' },
          adminHeaders
        )
        expect(emittedEvents(emitSpy, REVIEW_WORKFLOW_EVENTS)).toEqual([
          {
            name: 'review.reply.updated',
            data: { review_id: review.id, product_id: 'prod_reply_events' },
          },
        ])

        emitSpy.mockRestore()
      })

      it('refuses a reply to a review that does not exist', async () => {
        const err = await api
          .post('/admin/reviews/rev_nope/reply', { content: 'Hi' }, adminHeaders)
          .catch((e) => e.response)
        expect(err.status).toEqual(404)
      })

      it('refuses an empty reply', async () => {
        const err = await api
          .post(`/admin/reviews/${reviewId}/reply`, { content: '' }, adminHeaders)
          .catch((e) => e.response)
        expect(err.status).toEqual(400)
      })

      it('requires authentication', async () => {
        const err = await api
          .post(`/admin/reviews/${reviewId}/reply`, { content: 'Hi' })
          .catch((e) => e.response)
        expect(err.status).toEqual(401)
      })
    })

    describe('GET /admin/reviews/:id/reply', () => {
      let reviewId: string

      beforeEach(async () => {
        await createAdminUser(getContainer())

        const service = getContainer().resolve(REVIEW_MODULE)
        const review = await service.createReviews({
          product_id: 'prod_reply_read',
          display_name: 'E',
          rating: 5,
          content: 'v'.repeat(10),
        })
        reviewId = review.id
      })

      it('reports no reply as `{ reply: null }` with a 200, not a 404', async () => {
        const response = await api.get(`/admin/reviews/${reviewId}/reply`, adminHeaders)
        expect(response.status).toEqual(200)
        expect(response.data).toEqual({ reply: null })
      })

      /**
       * The decoy this project's standing instruction calls for (see
       * progress.md's "pattern worth carrying into the remaining tasks"):
       * a single-review test would pass even with the `review_id` filter
       * dropped entirely - `listReviewReplies({})` would still find A
       * REPLY and this test would never notice it was the wrong one. A
       * second review with its own reply proves the filter is real.
       */
      it("returns only the requested review's own reply, not another review's", async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const decoy = await service.createReviews({
          product_id: 'prod_reply_read_decoy',
          display_name: 'Decoy',
          rating: 3,
          content: 'decoy content here',
        })

        // The DECOY's reply is written first, deliberately. An unfiltered
        // `listReviewReplies({}, { take: 1 })` returns whichever row comes
        // back first, so writing the target's reply first would make this
        // test pass against a dropped `review_id` filter purely by luck of
        // insertion order - which it did, until this line was flipped.
        // Seeding the decoy first means an unfiltered read returns the
        // decoy and the assertions below fail loudly.
        await api.post(`/admin/reviews/${decoy.id}/reply`, { content: 'Decoy reply' }, adminHeaders)
        await api.post(`/admin/reviews/${reviewId}/reply`, { content: 'Target reply' }, adminHeaders)

        const response = await api.get(`/admin/reviews/${reviewId}/reply`, adminHeaders)

        expect(response.status).toEqual(200)
        expect(response.data.reply.review_id).toEqual(reviewId)
        expect(response.data.reply.content).toEqual('Target reply')
      })

      it('never returns replied_by', async () => {
        await api.post(`/admin/reviews/${reviewId}/reply`, { content: 'Thanks!' }, adminHeaders)

        const response = await api.get(`/admin/reviews/${reviewId}/reply`, adminHeaders)

        // Exact-shape match, not a partial one: if `replied_by` were
        // present this would fail on the extra key alone, not just on a
        // value mismatch - matching store/products/[id]/reviews/route.ts's
        // own convention of asserting the whole allow-listed shape.
        expect(response.data.reply).toEqual({
          id: expect.any(String),
          review_id: reviewId,
          content: 'Thanks!',
          created_at: expect.any(String),
          updated_at: expect.any(String),
        })
      })

      it('requires authentication', async () => {
        const err = await api.get(`/admin/reviews/${reviewId}/reply`).catch((e) => e.response)
        expect(err.status).toEqual(401)
      })
    })

    describe('DELETE /admin/reviews/:id/reply', () => {
      let reviewId: string

      beforeEach(async () => {
        await createAdminUser(getContainer())

        const service = getContainer().resolve(REVIEW_MODULE)
        const review = await service.createReviews({
          product_id: 'prod_reply_delete',
          display_name: 'D',
          rating: 5,
          content: 'w'.repeat(10),
        })
        reviewId = review.id
      })

      afterEach(() => {
        jest.restoreAllMocks()
      })

      it('deletes a reply', async () => {
        await api.post(`/admin/reviews/${reviewId}/reply`, { content: 'Thanks!' }, adminHeaders)

        const response = await api.delete(`/admin/reviews/${reviewId}/reply`, adminHeaders)
        expect(response.status).toEqual(200)
        expect(response.data).toEqual({ id: expect.any(String), object: 'review_reply', deleted: true })

        const service = getContainer().resolve(REVIEW_MODULE)
        const remaining = await service.listReviewReplies({ review_id: reviewId })
        expect(remaining).toHaveLength(0)
      })

      it('hard-deletes the row, not just soft-deletes it', async () => {
        await api.post(`/admin/reviews/${reviewId}/reply`, { content: 'Thanks!' }, adminHeaders)
        await api.delete(`/admin/reviews/${reviewId}/reply`, adminHeaders)

        // Asserts on the actual row, including soft-deleted ones - not on
        // whether a repost afterwards succeeds. A repost is a poor proxy
        // here: the POST handler is an upsert (service.upsertReviewReply,
        // ON CONFLICT ("review_id") WHERE "deleted_at" IS NULL DO UPDATE),
        // so it succeeds after a hard delete, a soft delete, or even no
        // delete at all - a still-present row just gets updated in place.
        // The partial unique index (`WHERE deleted_at IS NULL`) also does
        // NOT block a soft-deleted row from a repost; it deliberately
        // excludes it. `withDeleted: true` is what actually distinguishes
        // hard from soft: a hard delete leaves no row at all, even with
        // `withDeleted: true`; a soft delete leaves one row with
        // `deleted_at` set.
        const service = getContainer().resolve(REVIEW_MODULE)
        const rows = await service.listReviewReplies(
          { review_id: reviewId },
          { withDeleted: true }
        )
        expect(rows).toHaveLength(0)
      })

      it('deleting a reply that does not exist is a 404, not a 500', async () => {
        const err = await api
          .delete(`/admin/reviews/${reviewId}/reply`, adminHeaders)
          .catch((e) => e.response)
        expect(err.status).toEqual(404)
      })

      it('deleting a reply on a review that does not exist is a 404', async () => {
        const err = await api
          .delete('/admin/reviews/rev_nope/reply', adminHeaders)
          .catch((e) => e.response)
        expect(err.status).toEqual(404)
      })

      it('requires authentication', async () => {
        const err = await api
          .delete(`/admin/reviews/${reviewId}/reply`)
          .catch((e) => e.response)
        expect(err.status).toEqual(401)
      })

      /**
       * This test used to assert the OPPOSITE - "does not emit an event on
       * delete" - and it was right at the time: nothing consumed such an
       * event, and the workflow's docstring said to add one when a real
       * consumer appeared. Phase 5's storefront is that consumer. A
       * storefront caches the reply as part of the review list it renders,
       * so once a merchant deletes a reply - posted in error, on the wrong
       * review, or saying something they should not have - the row being
       * gone no longer means shoppers stop seeing it. Without this event
       * nothing can invalidate that page.
       *
       * Same decoy as the create/update test: the `beforeEach` review on
       * `prod_reply_delete` predates the one built here, so a product
       * lookup that lost its filter would report the wrong product.
       */
      it('emits review.reply.deleted with the product_id when a reply is removed', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_reply_delete_events',
          display_name: 'Ada',
          rating: 5,
          content: 'x'.repeat(20),
        })

        await api.post(`/admin/reviews/${review.id}/reply`, { content: 'Thanks!' }, adminHeaders)

        const emitSpy = jest.spyOn(container.resolve(Modules.EVENT_BUS), 'emit')

        const response = await api.delete(`/admin/reviews/${review.id}/reply`, adminHeaders)
        expect(response.status).toEqual(200)

        expect(emittedEvents(emitSpy, REVIEW_WORKFLOW_EVENTS)).toEqual([
          {
            name: 'review.reply.deleted',
            data: { review_id: review.id, product_id: 'prod_reply_delete_events' },
          },
        ])

        emitSpy.mockRestore()
      })
    })
  },
})
