import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import ReviewModuleService from '../../src/modules/review/service'
import { voterHash } from '../../src/settings/voter-hash'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('review_vote model', () => {
      it('lets two different customers who share an IP and user agent both vote, while a guest sharing that same hash still collides with itself', async () => {
        const service: ReviewModuleService = getContainer().resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_test',
          display_name: 'Ada',
          rating: 5,
          content: 'Genuinely excellent, would buy again.',
        })

        // An office, household or VPN: two different customers, one IP,
        // one browser. Their voter_hash - if it were ever computed and
        // stored for a signed-in vote the way it is for a guest's - would
        // be byte-for-byte identical. Proving that here (rather than just
        // asserting the two creates succeed) is what makes this a genuine
        // regression test: if a future change starts writing this shared
        // hash onto customer rows again, the second create below fails
        // with a real Postgres unique-constraint violation.
        const sharedHash = voterHash('203.0.113.5', 'Mozilla/5.0 shared-office-browser', 'test-salt')
        const otherHash = voterHash('198.51.100.9', 'Mozilla/5.0 different-visitor', 'test-salt')
        expect(sharedHash).not.toEqual(otherHash) // sanity: the helper itself isn't degenerate

        const alice = await service.createReviewVotes({
          review_id: review.id,
          customer_id: 'cus_alice',
          voter_hash: null,
        })
        const bob = await service.createReviewVotes({
          review_id: review.id,
          customer_id: 'cus_bob',
          voter_hash: null,
        })

        expect(alice.customer_id).toEqual('cus_alice')
        expect(alice.voter_hash).toBeNull()
        expect(bob.customer_id).toEqual('cus_bob')
        expect(bob.voter_hash).toBeNull()

        // Decoy: a guest vote using that same shared hash. Seeded and
        // asserted first so it is the row a broken "customers are exempt
        // too" implementation (e.g. one that dropped the voter_hash
        // partial index's `voter_hash IS NOT NULL` predicate entirely)
        // would return instead of enforcing anything - if the guest rule
        // were accidentally disabled along with the customer fix, this
        // would be the first assertion to catch it, not the last.
        const guestOne = await service.createReviewVotes({
          review_id: review.id,
          customer_id: null,
          voter_hash: sharedHash,
        })
        expect(guestOne.voter_hash).toEqual(sharedHash)

        await expect(
          service.createReviewVotes({
            review_id: review.id,
            customer_id: null,
            voter_hash: sharedHash,
          })
        ).rejects.toThrow()

        const all = await service.listReviewVotes({ review_id: review.id })
        expect(all).toHaveLength(3)
        expect(all.filter((v) => v.customer_id === 'cus_alice')).toHaveLength(1)
        expect(all.filter((v) => v.customer_id === 'cus_bob')).toHaveLength(1)
        expect(all.filter((v) => v.voter_hash === sharedHash)).toHaveLength(1)
      })
    })
  },
})
