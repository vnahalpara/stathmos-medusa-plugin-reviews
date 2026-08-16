import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { REVIEW_MODULE } from '../../src/modules/review'
import { castReviewVoteStep } from '../../src/workflows/steps/cast-review-vote'
import { withdrawReviewVoteStep } from '../../src/workflows/steps/withdraw-review-vote'
import { castReviewVoteWorkflow, CastReviewVoteInput, WithdrawReviewVoteInput } from '../../src/workflows/vote-review'

/**
 * Neither castReviewVoteWorkflow nor withdrawReviewVoteWorkflow has a step
 * after the real one today (see vote-review.ts's docstring: no
 * emitEventStep, deliberately), so nothing in production yet exercises
 * either compensation path. That is exactly the case that most needs a
 * test - an unexercised compensation is the one most likely to silently
 * rot - and it is the same reasoning delete-review-reply-compensation.spec.ts
 * gives for the same shape of gap.
 *
 * A plain injected failing step, run immediately after the real one,
 * reproduces "a downstream step fails after this step committed"
 * deterministically - the same technique every other
 * *-compensation.spec.ts file in this repo uses, and for the same
 * reliability reason documented in update-review-settings-compensation.spec.ts:
 * forcing a throw inside a real framework step (e.g. emitEventStep) was
 * flaky in this local workflow engine.
 */
const alwaysFail = createStep('always-fail-after-vote', async () => {
  throw new Error('forced failure for compensation test')
})

const castWorkflowUnderTest = createWorkflow(
  'cast-review-vote-compensation-test',
  function (input: CastReviewVoteInput) {
    const result = castReviewVoteStep(input)
    // No data dependency on `result`: ordering between plain (non-
    // emitEventStep) steps is sequential regardless - same reasoning as
    // the other *-compensation.spec.ts files - and threading `result`
    // through only to satisfy a type signature would misleadingly imply
    // the ordering depends on it.
    alwaysFail()
    return new WorkflowResponse(result)
  }
)

const withdrawWorkflowUnderTest = createWorkflow(
  'withdraw-review-vote-compensation-test',
  function (input: WithdrawReviewVoteInput) {
    const result = withdrawReviewVoteStep(input)
    alwaysFail()
    return new WorkflowResponse(result)
  }
)

async function runAndExpectRejection(promise: Promise<unknown>, messageIncludes: string) {
  let threw = false
  try {
    await promise
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain(messageIncludes)
  }
  expect(threw).toBe(true)
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('castReviewVoteStep / withdrawReviewVoteStep compensation', () => {
      it('leaves neither a review_vote row nor a changed helpful_count when a downstream step fails after casting a vote', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_vote_cast_comp',
          display_name: 'Cast comp',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        await runAndExpectRejection(
          castWorkflowUnderTest(container).run({
            input: { review_id: review.id, customer_id: 'cus_cast_comp_voter', voter_hash: null },
          }),
          'forced failure for compensation test'
        )

        // The load-bearing pair: the vote row that castReviewVoteStep
        // committed must be gone (not left as an orphan nobody can vote
        // past), AND the counter it bumped in a SEPARATE table must be
        // back to what it was before - either half surviving on its own
        // would leave the review's public "N people found this helpful"
        // number wrong forever, since nothing else ever revisits it.
        expect(await service.listReviewVotes({ review_id: review.id })).toHaveLength(0)

        const [restored] = await service.listReviews({ id: review.id })
        expect(restored.helpful_count).toEqual(0)
      })

      it('restores the vote row and its helpful_count contribution when a downstream step fails after withdrawing a vote', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_vote_withdraw_comp',
          display_name: 'Withdraw comp',
          rating: 5,
          content: 'x'.repeat(10),
          status: 'approved',
        })

        // Cast a real vote first, through the real (non-synthetic)
        // workflow, so there is a genuine row and a genuine helpful_count
        // of 1 for the withdraw-under-test to remove and for its
        // compensation to restore.
        await castReviewVoteWorkflow(container).run({
          input: { review_id: review.id, customer_id: 'cus_withdraw_comp_voter', voter_hash: null },
        })

        await runAndExpectRejection(
          withdrawWorkflowUnderTest(container).run({
            input: { review_id: review.id, customer_id: 'cus_withdraw_comp_voter', voter_hash: null },
          }),
          'forced failure for compensation test'
        )

        // The load-bearing pair, mirrored: the vote withdrawReviewVoteStep
        // deleted must come back (the compensation's
        // service.createReviewVotes() call), AND helpful_count must be
        // back to 1, not left at 0 from the decrement nothing then
        // reversed.
        const votes = await service.listReviewVotes({ review_id: review.id })
        expect(votes).toHaveLength(1)
        expect(votes[0].customer_id).toEqual('cus_withdraw_comp_voter')

        const [restored] = await service.listReviews({ id: review.id })
        expect(restored.helpful_count).toEqual(1)
      })
    })
  },
})
