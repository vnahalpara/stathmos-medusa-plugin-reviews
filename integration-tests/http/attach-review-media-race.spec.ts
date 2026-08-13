import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'

async function pngBase64(): Promise<string> {
  const buf = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#654321' },
  })
    .png()
    .toBuffer()

  return buf.toString('base64')
}

async function uploadOne(container: Parameters<typeof uploadReviewMediaWorkflow>[0]) {
  const { result } = await uploadReviewMediaWorkflow(container).run({
    input: { files: [{ filename: 'p.png', content: await pngBase64(), size_bytes: 100 }] },
  })

  return result.media[0].id
}

/**
 * A two-arrival barrier: `arrive()` resolves for every caller only once it
 * has been called `n` times. Used below to force two concurrently-running
 * `createReviewWorkflow` executions to both complete their read of the
 * media row (see attach-review-media.ts's existence/pre-claim
 * `listReviewMedias` call) before either is allowed to proceed to the
 * claim - i.e. to guarantee they race, rather than leaving it to incidental
 * event-loop timing, which could pass even against a buggy implementation
 * simply by luck.
 */
function makeBarrier(n: number) {
  let release: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrivals = 0

  return {
    async arrive() {
      arrivals += 1
      if (arrivals >= n) {
        release()
      }
      await ready
    },
  }
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('attachReviewMediaStep concurrency', () => {
      beforeEach(async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true },
        })
      })

      afterEach(() => {
        jest.restoreAllMocks()
      })

      /**
       * Forces two independent, real createReviewWorkflow runs to submit
       * the SAME not-yet-attached media id at (as close as this test can
       * force) the same instant, by gating attachReviewMediaStep's own
       * listReviewMedias read behind a barrier that only releases once
       * both runs have reached it. This reproduces exactly the shape
       * Important-1 of the fix-round review described: two concurrent
       * claims on the same unattached media id, both starting from a read
       * that still sees review_id === null.
       *
       * The load-bearing assertion is not "one throws" in isolation - a
       * flaky implementation could still get lucky under light concurrency
       * - it's that this passes DETERMINISTICALLY (not most of the time):
       * exactly one workflow settles fulfilled, exactly one settles
       * rejected, and the media row ends up attached to exactly the review
       * that won, every single run. That determinism is what proves the
       * decision is made by the database's own row-level locking on the
       * conditional UPDATE, not by whichever request happened to be
       * scheduled first at the JS layer.
       */
      it('lets exactly one of two concurrent claims on the same media id win', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)
        const mediaId = await uploadOne(container)

        const barrier = makeBarrier(2)
        const originalListReviewMedias = service.listReviewMedias.bind(service)

        jest.spyOn(service, 'listReviewMedias').mockImplementation(async (...args: unknown[]) => {
          const filter = args[0] as { id?: unknown } | undefined
          const isThisClaim =
            !!filter && Array.isArray(filter.id) && filter.id.length === 1 && filter.id[0] === mediaId

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await (originalListReviewMedias as any)(...args)

          if (isThisClaim) {
            await barrier.arrive()
          }

          return result
        })

        type Outcome =
          | { status: 'fulfilled'; reviewId: string; productId: string }
          | { status: 'rejected' }

        async function attempt(productId: string, displayName: string, rating: number): Promise<Outcome> {
          try {
            const { result } = await createReviewWorkflow(container).run({
              input: {
                product_id: productId,
                rating,
                content: 'x'.repeat(20),
                display_name: displayName,
                media_ids: [mediaId],
              },
            })
            return { status: 'fulfilled', reviewId: result.id, productId: result.product_id }
          } catch {
            return { status: 'rejected' }
          }
        }

        const [a, b] = await Promise.all([
          attempt('prod_race_a', 'Racer A', 5),
          attempt('prod_race_b', 'Racer B', 4),
        ])

        jest.restoreAllMocks()

        const outcomes = [a, b]
        const fulfilled = outcomes.filter(
          (o): o is Extract<Outcome, { status: 'fulfilled' }> => o.status === 'fulfilled'
        )
        const rejected = outcomes.filter((o) => o.status === 'rejected')

        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)

        const winner = fulfilled[0]

        const [media] = await service.listReviewMedias({ id: mediaId })
        expect(media.review_id).toEqual(winner.reviewId)

        // The loser's own review row must have been rolled back by
        // createReviewStep's compensation - not merely left orphaned with
        // no media - confirming this is a genuine full-workflow failure,
        // not a partial success that happened to also throw.
        const loserProductId = winner.productId === 'prod_race_a' ? 'prod_race_b' : 'prod_race_a'
        expect(await service.listReviews({ product_id: loserProductId })).toHaveLength(0)
      })
    })
  },
})
