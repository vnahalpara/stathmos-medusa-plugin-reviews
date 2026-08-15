import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { castReviewVoteWorkflow } from '../../src/workflows/vote-review'
import { createCustomerAuthHeaders, getPublishableKeyHeaders } from '../helpers/store'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST/DELETE /store/reviews/:id/vote', () => {
      let storeHeaders: Record<string, string>

      beforeAll(async () => {
        storeHeaders = await getPublishableKeyHeaders(getContainer())
      })

      // Settings resolve through the Cache Module, which the DB-restore-
      // per-test harness does not reset - same convention as
      // store-read.spec.ts/store-submit.spec.ts's identical afterEach. Only
      // the settings.enabled test below flips anything, but this runs
      // unconditionally so a future test that also flips a setting cannot
      // leak into the next one by omission.
      afterEach(async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const rows = await service.listReviewSettings()
        if (rows.length) {
          await service.deleteReviewSettings(rows.map((r) => r.id))
        }
        await updateReviewSettingsWorkflow(getContainer()).run({ input: {} })
      })

      it('increments helpful_count and creates exactly one vote row, without touching a decoy review voted on first', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        // Seeded and voted on FIRST, so it is the row an unscoped counter
        // update (one that forgot its WHERE id = reviewId, or that just
        // grabbed "the first review") would silently bump instead of, or
        // in addition to, the review actually under test below.
        const decoy = await service.createReviews({
          product_id: 'prod_vote_decoy',
          display_name: 'Decoy',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })
        await castReviewVoteWorkflow(container).run({
          input: { review_id: decoy.id, customer_id: 'cus_decoy_voter', voter_hash: null },
        })

        const review = await service.createReviews({
          product_id: 'prod_vote_target',
          display_name: 'Target',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const response = await api.post(
          `/store/reviews/${review.id}/vote`,
          {},
          { headers: storeHeaders }
        )

        expect(response.status).toEqual(201)
        expect(response.data.helpful_count).toEqual(1)

        const [updated] = await service.listReviews({ id: review.id })
        expect(updated.helpful_count).toEqual(1)
        expect(await service.listReviewVotes({ review_id: review.id })).toHaveLength(1)

        // The load-bearing assertion: the decoy's own count is exactly
        // what its own single vote produced, not bumped a second time by
        // the vote cast on a different review above.
        const [decoyAfter] = await service.listReviews({ id: decoy.id })
        expect(decoyAfter.helpful_count).toEqual(1)
        expect(await service.listReviewVotes({ review_id: decoy.id })).toHaveLength(1)
      })

      it('refuses a second vote from the same identity with 409, leaving a decoy review untouched', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const decoy = await service.createReviews({
          product_id: 'prod_vote_dup_decoy',
          display_name: 'Decoy',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })
        await castReviewVoteWorkflow(container).run({
          input: { review_id: decoy.id, customer_id: 'cus_dup_decoy_voter', voter_hash: null },
        })

        const review = await service.createReviews({
          product_id: 'prod_vote_dup',
          display_name: 'Dup test',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const first = await api.post(`/store/reviews/${review.id}/vote`, {}, { headers: storeHeaders })
        expect(first.status).toEqual(201)

        const second = await api
          .post(`/store/reviews/${review.id}/vote`, {}, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(second.status).toEqual(409)

        // The refused second vote must not have written a row or moved the
        // counter at all - not even transiently.
        expect(await service.listReviewVotes({ review_id: review.id })).toHaveLength(1)
        const [updated] = await service.listReviews({ id: review.id })
        expect(updated.helpful_count).toEqual(1)

        const [decoyAfter] = await service.listReviews({ id: decoy.id })
        expect(decoyAfter.helpful_count).toEqual(1)
      })

      it("unvoting removes the row and decrements the counter, without touching a decoy review's own vote", async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const decoy = await service.createReviews({
          product_id: 'prod_vote_unvote_decoy',
          display_name: 'Decoy',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })
        await castReviewVoteWorkflow(container).run({
          input: { review_id: decoy.id, customer_id: 'cus_unvote_decoy_voter', voter_hash: null },
        })

        const review = await service.createReviews({
          product_id: 'prod_vote_unvote',
          display_name: 'Unvote test',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const castResponse = await api.post(
          `/store/reviews/${review.id}/vote`,
          {},
          { headers: storeHeaders }
        )
        expect(castResponse.status).toEqual(201)

        const deleteResponse = await api.delete(`/store/reviews/${review.id}/vote`, {
          headers: storeHeaders,
        })

        expect(deleteResponse.status).toEqual(200)
        expect(deleteResponse.data.helpful_count).toEqual(0)
        expect(await service.listReviewVotes({ review_id: review.id })).toHaveLength(0)

        const [updated] = await service.listReviews({ id: review.id })
        expect(updated.helpful_count).toEqual(0)

        // Decoy was created and voted on first - unvoting a different,
        // later-created review must not touch it.
        const [decoyAfter] = await service.listReviews({ id: decoy.id })
        expect(decoyAfter.helpful_count).toEqual(1)
        expect(await service.listReviewVotes({ review_id: decoy.id })).toHaveLength(1)
      })

      it('404s unvoting when no vote exists, not 500', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_vote_missing',
          display_name: 'Missing vote test',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const response = await api
          .delete(`/store/reviews/${review.id}/vote`, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(404)
      })

      // Task 1's review-vote-model.spec.ts proved this at the service
      // layer directly; this proves the real HTTP route resolves identity
      // the same way - a guest never reaches voterHash() with a computed
      // hash once a customer session/bearer token is present (see
      // resolveVoterIdentity() in the route), which is what lets both
      // succeed on the same review instead of racing the same dedup key.
      it('lets a guest and a signed-in customer both vote successfully on the same review', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_vote_mixed',
          display_name: 'Mixed identity test',
          rating: 4,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const { headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'mixed-voter@example.com'
        )

        const guestResponse = await api.post(
          `/store/reviews/${review.id}/vote`,
          {},
          { headers: storeHeaders }
        )
        expect(guestResponse.status).toEqual(201)

        const customerResponse = await api.post(
          `/store/reviews/${review.id}/vote`,
          {},
          { headers: { ...storeHeaders, ...customerHeaders } }
        )
        expect(customerResponse.status).toEqual(201)
        expect(customerResponse.data.helpful_count).toEqual(2)

        const votes = await service.listReviewVotes({ review_id: review.id })
        expect(votes).toHaveLength(2)
        expect(votes.some((v) => v.voter_hash !== null && v.customer_id === null)).toBe(true)
        expect(votes.some((v) => v.customer_id !== null && v.voter_hash === null)).toBe(true)
      })

      // The NAT case, exercised through the real route rather than
      // service.createReviewVotes() directly (review-vote-model.spec.ts
      // already covers the model/DB level): an office, household or VPN
      // puts two different customers behind one IP and one browser. If a
      // future change ever starts computing and storing voter_hash for a
      // signed-in customer too (the exact regression Task 1's review
      // caught), the second POST below would 409 against the first
      // customer's hash despite being a different account entirely.
      it('lets two different customers who share an IP and user agent both vote successfully on the same review', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_vote_nat',
          display_name: 'NAT test',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const alice = await createCustomerAuthHeaders(container, 'alice-nat-voter@example.com')
        const bob = await createCustomerAuthHeaders(container, 'bob-nat-voter@example.com')

        // Both requests come from this same test process/connection, so
        // they already share an IP as the server observes it; the shared
        // User-Agent below makes the "one browser" half of the scenario
        // explicit too.
        const sharedUserAgent = 'Mozilla/5.0 shared-office-browser'

        const aliceResponse = await api.post(
          `/store/reviews/${review.id}/vote`,
          {},
          { headers: { ...storeHeaders, ...alice.headers, 'User-Agent': sharedUserAgent } }
        )
        expect(aliceResponse.status).toEqual(201)

        const bobResponse = await api.post(
          `/store/reviews/${review.id}/vote`,
          {},
          { headers: { ...storeHeaders, ...bob.headers, 'User-Agent': sharedUserAgent } }
        )
        expect(bobResponse.status).toEqual(201)

        const votes = await service.listReviewVotes({ review_id: review.id })
        expect(votes).toHaveLength(2)
        expect(votes.every((v) => v.voter_hash === null)).toBe(true)
        expect(new Set(votes.map((v) => v.customer_id))).toEqual(
          new Set([alice.customer.id, bob.customer.id])
        )
      })

      it('refuses voting on a review that has not been approved, while an approved decoy still accepts votes', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const decoy = await service.createReviews({
          product_id: 'prod_vote_pending_decoy',
          display_name: 'Approved decoy',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const pending = await service.createReviews({
          product_id: 'prod_vote_pending',
          display_name: 'Pending test',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'pending',
        })

        const pendingResponse = await api
          .post(`/store/reviews/${pending.id}/vote`, {}, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(pendingResponse.status).toEqual(400)
        expect(await service.listReviewVotes({ review_id: pending.id })).toHaveLength(0)

        // Proves the refusal is specific to this review's status, not a
        // blanket failure (a misconfigured salt, say) that happens to also
        // return 400.
        const decoyResponse = await api.post(
          `/store/reviews/${decoy.id}/vote`,
          {},
          { headers: storeHeaders }
        )
        expect(decoyResponse.status).toEqual(201)
      })

      it('404s voting on a review that does not exist', async () => {
        const response = await api
          .post('/store/reviews/rev_does_not_exist/vote', {}, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(404)
      })

      // Matches GET /store/products/:id/reviews and POST /store/reviews,
      // both of which already 404 when the feature is switched off store-
      // wide - a merchant who disables reviews reasonably expects the
      // whole surface to stop, not one endpoint that keeps accumulating
      // votes on content nothing else displays.
      it('404s both casting and withdrawing a vote when reviews are disabled', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        // Cast while the feature is still enabled, so the DELETE
        // assertion below can prove the gate refuses before
        // service.withdrawVote() ever runs - the vote must still be
        // there afterwards, not silently removed as a side effect of the
        // feature being off.
        const review = await service.createReviews({
          product_id: 'prod_vote_disabled_withdraw',
          display_name: 'Disabled withdraw test',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const castResponse = await api.post(
          `/store/reviews/${review.id}/vote`,
          {},
          { headers: storeHeaders }
        )
        expect(castResponse.status).toEqual(201)

        await updateReviewSettingsWorkflow(container).run({ input: { enabled: false } })

        // A separate, never-voted-on review for the cast-side assertion -
        // otherwise this identity already having a vote on `review` above
        // would risk a 409 (already voted) masking whether the enabled
        // gate ran at all.
        const otherReview = await service.createReviews({
          product_id: 'prod_vote_disabled_cast',
          display_name: 'Disabled cast test',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        const voteResponse = await api
          .post(`/store/reviews/${otherReview.id}/vote`, {}, { headers: storeHeaders })
          .catch((e) => e.response)
        expect(voteResponse.status).toEqual(404)
        expect(await service.listReviewVotes({ review_id: otherReview.id })).toHaveLength(0)

        const unvoteResponse = await api
          .delete(`/store/reviews/${review.id}/vote`, { headers: storeHeaders })
          .catch((e) => e.response)
        expect(unvoteResponse.status).toEqual(404)
        expect(await service.listReviewVotes({ review_id: review.id })).toHaveLength(1)
      })
    })
  },
})
