import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { REVIEW_MODULE } from '../../src/modules/review'
import { deleteReviewReplyStep } from '../../src/workflows/steps/delete-review-reply'

/**
 * This compensation path used to be unreachable - the workflow was a
 * single step, so nothing downstream could fail - and this file existed to
 * stop an unexercised path from rotting. **It is reachable now:** Phase 5
 * added `emitEventStep` after `deleteReviewReplyStep` (for
 * `review.reply.deleted`), so an event-bus failure rolls the delete back
 * for real, in production, on a merchant's actual reply.
 *
 * That promotion is also what made the restore's fidelity matter. It was
 * documented as lossy - a fresh id and fresh timestamps - which was
 * acceptable while unreachable and is not now, so the step snapshots the
 * whole row and re-inserts it verbatim. The tests below assert the id and
 * `created_at` specifically, because "a reply exists afterwards" was true
 * of the lossy version too: an existence check passes against the very bug
 * this is meant to catch.
 *
 * Same reliability reasoning as the other *-compensation.spec.ts files: a
 * plain injected failing step reproduces "downstream step fails after this
 * step committed" deterministically, without relying on forcing a throw
 * inside a real framework step.
 */
const alwaysFail = createStep('always-fail-after-delete', async () => {
  throw new Error('forced failure for compensation test')
})

const workflowUnderTest = createWorkflow(
  'delete-review-reply-compensation-test',
  function (input: { review_id: string }) {
    const result = deleteReviewReplyStep(input)
    // No data dependency on `result`: ordering between plain (non-
    // emitEventStep) steps is sequential regardless - same reasoning as the
    // other *-compensation.spec.ts files - and threading `result` through
    // only to satisfy a type signature would misleadingly imply the
    // ordering depends on it.
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
    describe('deleteReviewReplyStep compensation', () => {
      it('restores the deleted reply verbatim - same id and created_at, not a fresh row', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_reply_delete_comp',
          display_name: 'Comp C',
          rating: 5,
          content: 'x'.repeat(10),
        })

        // Backdated so the assertions below can tell a real restore from a
        // recreate. This is the whole design of the test: with a reply
        // written moments ago, a rollback that mints `created_at: now()`
        // lands within milliseconds of the truth and any timestamp
        // assertion passes by luck. Months of distance makes the lossy
        // behaviour fail loudly.
        const originalCreatedAt = new Date('2026-01-05T09:30:00.000Z')

        // Passed as a variable, not an object literal, and deliberately so:
        // the ORM honours an explicit `created_at` on create, but Medusa's
        // generated create-input type omits the managed timestamps, and
        // TypeScript's excess-property check only fires on literals. This
        // is not a trick to dodge the compiler - it is precisely how the
        // production compensation passes the same field (it hands
        // `createReviewReplies` its snapshot object), so the seeding here
        // exercises the same mechanism the fix depends on. If a future
        // Medusa release stops honouring it, the assertion immediately
        // below goes red rather than the restore silently regressing.
        const seed = {
          review_id: review.id,
          content: 'Original reply',
          replied_by: 'usr_test',
          created_at: originalCreatedAt,
        }
        const original = await service.createReviewReplies(seed)

        // Precondition, not decoration: everything below is meaningless if
        // the backdating silently didn't take, and this is the same
        // "explicit timestamp on create is honoured" behaviour the
        // compensation itself depends on.
        expect(original.created_at.toISOString()).toEqual(originalCreatedAt.toISOString())

        await runAndExpectRejection(
          workflowUnderTest(container).run({ input: { review_id: review.id } }),
          'forced failure for compensation test'
        )

        const restored = await service.listReviewReplies({ review_id: review.id })
        expect(restored).toHaveLength(1)

        // The two assertions that actually catch the bug. "A reply exists
        // afterwards" and "its content matches" were both TRUE of the old
        // lossy restore, which recreated the row with a new id and a
        // rollback-time `created_at` - so neither could distinguish a real
        // restore from a plausible-looking replacement. The id matters
        // because anything holding it (an admin drawer open in another
        // tab, a log line, an external system) is pointing at a row that
        // would otherwise no longer exist; the timestamp matters because a
        // reply written in January must not come back claiming to be new.
        expect(restored[0].id).toEqual(original.id)
        expect(restored[0].created_at.toISOString()).toEqual(originalCreatedAt.toISOString())

        expect(restored[0].content).toEqual('Original reply')
        expect(restored[0].replied_by).toEqual('usr_test')

        // Exactly one row, not the restored one plus a soft-deleted
        // tombstone: this step hard-deletes and re-inserts on rollback, and
        // that must leave the table as it found it.
        const withDeleted = await service.listReviewReplies(
          { review_id: review.id },
          { withDeleted: true }
        )
        expect(withDeleted).toHaveLength(1)
      })

      it('leaves nothing behind when the review has no reply to delete', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_reply_delete_comp_2',
          display_name: 'Comp D',
          rating: 4,
          content: 'y'.repeat(10),
        })

        // deleteReviewReplyStep throws NOT_FOUND before returning a
        // StepResponse, so there is no compensation payload to run - this
        // proves that failure mode doesn't crash the rollback path.
        //
        // Snapshots the *total* row count across every review, not just
        // this one's review_id: scoping the after-assertion to
        // `review.id` alone would miss a broken guard that fabricated a
        // reply under some other, unrelated review_id - it would still
        // read as "0 replies for review.id" and pass. Comparing totals
        // before/after catches a stray create regardless of which
        // review_id it lands under.
        const before = await service.listReviewReplies({}, { withDeleted: true })

        await runAndExpectRejection(
          workflowUnderTest(container).run({ input: { review_id: review.id } }),
          'Reply not found'
        )

        const after = await service.listReviewReplies({}, { withDeleted: true })
        expect(after).toHaveLength(before.length)
      })
    })
  },
})
