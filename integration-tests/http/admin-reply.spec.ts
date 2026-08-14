import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { createAdminUser, adminHeaders } from '../helpers/admin'

/**
 * emitEventStep calls `eventBus.emit(message)` with `message` always an
 * array of `{ name, data, ... }` objects (see
 * @medusajs/core-flows/common/steps/emit-event.js) - flattened here and
 * filtered to this plugin's reply events, since other workflows invoked by
 * test setup (creating the admin user, creating the review) emit their own
 * unrelated events on the same spied bus.
 */
function replyEventNames(emitSpy: jest.SpyInstance): string[] {
  return emitSpy.mock.calls
    .flatMap(([messages]) => (Array.isArray(messages) ? messages : [messages]))
    .map((message) => (message as { name: string }).name)
    .filter((name) => name.startsWith('review.reply.'))
}

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

      it('emits review.reply.created on first reply and review.reply.updated on an edit', async () => {
        const eventBus = getContainer().resolve(Modules.EVENT_BUS)
        const emitSpy = jest.spyOn(eventBus, 'emit')

        await api.post(`/admin/reviews/${reviewId}/reply`, { content: 'Thanks!' }, adminHeaders)
        expect(replyEventNames(emitSpy)).toEqual(['review.reply.created'])

        emitSpy.mockClear()

        await api.post(
          `/admin/reviews/${reviewId}/reply`,
          { content: 'Thanks, updated.' },
          adminHeaders
        )
        expect(replyEventNames(emitSpy)).toEqual(['review.reply.updated'])

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

      it('does not emit an event on delete', async () => {
        await api.post(`/admin/reviews/${reviewId}/reply`, { content: 'Thanks!' }, adminHeaders)

        const eventBus = getContainer().resolve(Modules.EVENT_BUS)
        const emitSpy = jest.spyOn(eventBus, 'emit')

        await api.delete(`/admin/reviews/${reviewId}/reply`, adminHeaders)
        expect(replyEventNames(emitSpy)).toEqual([])

        emitSpy.mockRestore()
      })
    })
  },
})
