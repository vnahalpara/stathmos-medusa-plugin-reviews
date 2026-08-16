import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { REVIEW_MODULE } from '../../src/modules/review'
import { setMediaCurationStep } from '../../src/workflows/steps/set-media-curation'
import { CurateReviewMediaInput } from '../../src/workflows/curate-review-media'
import { createAdminUser, adminHeaders } from '../helpers/admin'
import { getPublishableKeyHeaders } from '../helpers/store'

type MediaInput = {
  review_id: string
  type: 'image' | 'video'
  file_id: string
  url: string
  mime_type: string
  size_bytes: number
}

/**
 * Same technique as vote-review-compensation.spec.ts and
 * update-review-settings-compensation.spec.ts: a plain injected failing
 * step run immediately after the real one, reproducing "a downstream step
 * fails after this step committed" deterministically. Neither
 * curateReviewMediaWorkflow has a step after setMediaCurationStep today, so
 * nothing in production yet exercises its compensation branch - exactly the
 * kind of unexercised path most likely to silently rot.
 */
const alwaysFail = createStep('always-fail-after-curation', async () => {
  throw new Error('forced failure for compensation test')
})

const curateWorkflowUnderTest = createWorkflow(
  'curate-review-media-compensation-test',
  function (input: CurateReviewMediaInput) {
    const result = setMediaCurationStep(input)
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
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await createAdminUser(getContainer())
    })

    describe('POST /admin/reviews/media/:id/curation', () => {
      it('pins media, setting pinned_at, and unpins it, nulling pinned_at', async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const review = await service.createReviews({
          product_id: 'prod_curate_pin',
          display_name: 'Guest',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })
        const [media] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_curate_pin',
            url: 'http://localhost/static/file_curate_pin.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])

        const pinResponse = await api.post(
          `/admin/reviews/media/${media.id}/curation`,
          { pinned: true },
          adminHeaders
        )
        expect(pinResponse.status).toEqual(200)
        expect(pinResponse.data.media.id).toEqual(media.id)
        expect(pinResponse.data.media.pinned_at).not.toBeNull()

        const [pinnedRow] = await service.listReviewMedias({ id: media.id })
        expect(pinnedRow.pinned_at).not.toBeNull()

        const unpinResponse = await api.post(
          `/admin/reviews/media/${media.id}/curation`,
          { pinned: false },
          adminHeaders
        )
        expect(unpinResponse.data.media.pinned_at).toBeNull()

        const [unpinnedRow] = await service.listReviewMedias({ id: media.id })
        expect(unpinnedRow.pinned_at).toBeNull()
      })

      it('hides media, setting hidden_at, and unhides it, nulling hidden_at', async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const review = await service.createReviews({
          product_id: 'prod_curate_hide',
          display_name: 'Guest',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })
        const [media] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_curate_hide',
            url: 'http://localhost/static/file_curate_hide.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])

        const hideResponse = await api.post(
          `/admin/reviews/media/${media.id}/curation`,
          { hidden: true },
          adminHeaders
        )
        expect(hideResponse.status).toEqual(200)
        expect(hideResponse.data.media.hidden_at).not.toBeNull()

        const [hiddenRow] = await service.listReviewMedias({ id: media.id })
        expect(hiddenRow.hidden_at).not.toBeNull()

        const unhideResponse = await api.post(
          `/admin/reviews/media/${media.id}/curation`,
          { hidden: false },
          adminHeaders
        )
        expect(unhideResponse.data.media.hidden_at).toBeNull()

        const [unhiddenRow] = await service.listReviewMedias({ id: media.id })
        expect(unhiddenRow.hidden_at).toBeNull()
      })

      it('pins and hides in the same request', async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const review = await service.createReviews({
          product_id: 'prod_curate_both',
          display_name: 'Guest',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })
        const [media] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_curate_both',
            url: 'http://localhost/static/file_curate_both.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])

        const response = await api.post(
          `/admin/reviews/media/${media.id}/curation`,
          { pinned: true, hidden: true },
          adminHeaders
        )

        expect(response.data.media.pinned_at).not.toBeNull()
        expect(response.data.media.hidden_at).not.toBeNull()
      })

      it('404s a non-existent media id', async () => {
        const response = await api
          .post('/admin/reviews/media/rmed_nope/curation', { pinned: true }, adminHeaders)
          .catch((e) => e.response)

        expect(response.status).toEqual(404)
      })

      it('400s an empty body rather than silently no-op succeeding', async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const review = await service.createReviews({
          product_id: 'prod_curate_empty_body',
          display_name: 'Guest',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })
        const [media] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_curate_empty_body',
            url: 'http://localhost/static/file_curate_empty_body.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])

        const response = await api
          .post(`/admin/reviews/media/${media.id}/curation`, {}, adminHeaders)
          .catch((e) => e.response)

        expect(response.status).toEqual(400)

        // Load-bearing: an empty body must not have silently changed
        // anything either, even though it was rejected before reaching the
        // step - belt-and-braces against a middleware/route mismatch that
        // would let an unvalidated body slip through.
        const [untouched] = await service.listReviewMedias({ id: media.id })
        expect(untouched.pinned_at).toBeNull()
        expect(untouched.hidden_at).toBeNull()
      })

      it('400s an unrecognized field even alongside a valid one (.strict())', async () => {
        // `pinned: true` alone would be valid - isolates that this 400
        // comes from the `.strict()` unknown-key rejection, not from the
        // "at least one of the two" refinement above it.
        const response = await api
          .post(
            '/admin/reviews/media/rmed_nope/curation',
            { pinned: true, nonsense: true },
            adminHeaders
          )
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })

      it('requires authentication', async () => {
        const response = await api
          .post('/admin/reviews/media/rmed_nope/curation', { pinned: true })
          .catch((e) => e.response)

        expect(response.status).toEqual(401)
      })

      /**
       * The decoy this project's standing instruction calls for: the item
       * being hidden is seeded LAST (newest, and therefore first under the
       * gallery's `created_at DESC` half of its ordering) so it would be
       * returned first by both the gallery and the store route if the
       * `hidden_at` filter were ever dropped from either query. Both
       * `listVisibleReviewMedias` (the store product route) and
       * `listGalleryMedia`/`buildGalleryQuery` (Task 4) apply that filter
       * independently - proving both here, in the same test, is what
       * catches either one regressing on its own.
       */
      it(
        'a hidden item disappears from the gallery and from the store product ' +
          'reviews route, seeded NEWEST so an unfiltered query would return it first',
        async () => {
          const container = getContainer()
          const service = container.resolve(REVIEW_MODULE)
          const storeHeaders = await getPublishableKeyHeaders(container)

          const review = await service.createReviews({
            product_id: 'prod_curate_hide_visibility',
            display_name: 'Guest',
            rating: 5,
            content: 'x'.repeat(20),
            status: 'approved',
          })

          const [staysVisible] = await service.createReviewMedias([
            {
              review_id: review.id,
              type: 'image',
              file_id: 'file_curate_hide_stays',
              url: 'http://localhost/static/file_curate_hide_stays.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])

          // Created strictly after staysVisible, so it is the newer of the
          // two - ranks first under the gallery's `created_at DESC` if
          // `hidden_at` were not applied.
          const [toHide] = await service.createReviewMedias([
            {
              review_id: review.id,
              type: 'image',
              file_id: 'file_curate_hide_target',
              url: 'http://localhost/static/file_curate_hide_target.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])

          const curateResponse = await api.post(
            `/admin/reviews/media/${toHide.id}/curation`,
            { hidden: true },
            adminHeaders
          )
          expect(curateResponse.status).toEqual(200)

          const galleryResponse = await api.get(
            `/store/reviews/gallery?product_id=prod_curate_hide_visibility`,
            { headers: storeHeaders }
          )
          expect(galleryResponse.data.media.map((m: { id: string }) => m.id)).toEqual([
            staysVisible.id,
          ])

          const storeReviewsResponse = await api.get(
            `/store/products/prod_curate_hide_visibility/reviews`,
            { headers: storeHeaders }
          )
          const mediaIds = storeReviewsResponse.data.reviews[0].media.map(
            (m: { id: string }) => m.id
          )
          expect(mediaIds).toEqual([staysVisible.id])

          // The half that distinguishes this from the store-facing rule:
          // the admin media list deliberately keeps showing what it hid, so
          // a moderator can find and un-hide it later.
          const adminMediaResponse = await api.get(
            `/admin/reviews/${review.id}/media`,
            adminHeaders
          )
          const adminIds = adminMediaResponse.data.media.map((m: { id: string }) => m.id)
          expect(adminIds).toEqual(expect.arrayContaining([staysVisible.id, toHide.id]))
          const hiddenInAdmin = adminMediaResponse.data.media.find(
            (m: { id: string }) => m.id === toHide.id
          )
          expect(hiddenInAdmin.hidden_at).not.toBeNull()
        }
      )

      it('a pinned item leads the gallery even when a newer unpinned item exists', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)
        const storeHeaders = await getPublishableKeyHeaders(container)

        const review = await service.createReviews({
          product_id: 'prod_curate_pin_order',
          display_name: 'Guest',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })

        const [older] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_curate_pin_order_old',
            url: 'http://localhost/static/file_curate_pin_order_old.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])

        // Strictly newer than `older` - under a bare `created_at DESC` this
        // would sort first. Pinning `older` through the curation endpoint
        // below must override that.
        const [newer] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_curate_pin_order_new',
            url: 'http://localhost/static/file_curate_pin_order_new.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])

        const pinResponse = await api.post(
          `/admin/reviews/media/${older.id}/curation`,
          { pinned: true },
          adminHeaders
        )
        expect(pinResponse.status).toEqual(200)

        const galleryResponse = await api.get(
          `/store/reviews/gallery?product_id=prod_curate_pin_order`,
          { headers: storeHeaders }
        )
        expect(galleryResponse.data.media.map((m: { id: string }) => m.id)).toEqual([
          older.id,
          newer.id,
        ])
      })

      /**
       * Route-collision check, run explicitly rather than assumed - the
       * same standing instruction Phase 3 needed for
       * GET /admin/reviews/:id/media alongside DELETE
       * /admin/reviews/media/:id (see admin-review-media-list.spec.ts's own
       * version of this test). This task adds a THIRD path in the same
       * family, one segment deeper than the DELETE:
       * POST /admin/reviews/media/:id/curation. All three are exercised
       * here, in the same test run, against the same two media rows, so a
       * genuine path conflict fails one assertion rather than passing by
       * accident.
       */
      it(
        'POST /admin/reviews/media/:id/curation, GET /admin/reviews/:id/media, and ' +
          'DELETE /admin/reviews/media/:id all resolve to their own handler',
        async () => {
          const service = getContainer().resolve(REVIEW_MODULE)
          const review = await service.createReviews({
            product_id: 'prod_curate_collision',
            display_name: 'Guest',
            rating: 5,
            content: 'x'.repeat(10),
          })
          const [keep] = await service.createReviewMedias([
            {
              review_id: review.id,
              type: 'image',
              file_id: 'file_curate_collision_keep',
              url: 'http://localhost/static/file_curate_collision_keep.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])
          const [toDelete] = await service.createReviewMedias([
            {
              review_id: review.id,
              type: 'image',
              file_id: 'file_curate_collision_delete',
              url: 'http://localhost/static/file_curate_collision_delete.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])

          const curationResponse = await api.post(
            `/admin/reviews/media/${keep.id}/curation`,
            { pinned: true },
            adminHeaders
          )
          expect(curationResponse.status).toEqual(200)
          expect(curationResponse.data.media.id).toEqual(keep.id)
          expect(curationResponse.data.media.pinned_at).not.toBeNull()

          const listResponse = await api.get(`/admin/reviews/${review.id}/media`, adminHeaders)
          expect(listResponse.status).toEqual(200)
          expect(listResponse.data.media.map((m: { id: string }) => m.id).sort()).toEqual(
            [keep.id, toDelete.id].sort()
          )

          const deleteResponse = await api.delete(
            `/admin/reviews/media/${toDelete.id}`,
            adminHeaders
          )
          expect(deleteResponse.status).toEqual(200)
          expect(deleteResponse.data).toEqual({
            id: toDelete.id,
            object: 'review_media',
            deleted: true,
          })

          const afterDelete = await api.get(`/admin/reviews/${review.id}/media`, adminHeaders)
          expect(afterDelete.data.media.map((m: { id: string }) => m.id)).toEqual([keep.id])

          // `keep`'s curation must have survived untouched by the DELETE
          // aimed at the other row.
          const [survivor] = await service.listReviewMedias({ id: keep.id })
          expect(survivor.pinned_at).not.toBeNull()
        }
      )
    })

    describe('setMediaCurationStep compensation', () => {
      it(
        'restores the previous (non-null) pinned_at and hidden_at when a downstream ' +
          'step fails after unpinning and unhiding - never leaves them cleared',
        async () => {
          const container = getContainer()
          const service = container.resolve(REVIEW_MODULE)

          const review = await service.createReviews({
            product_id: 'prod_curate_comp',
            display_name: 'Comp',
            rating: 5,
            content: 'x'.repeat(20),
            status: 'approved',
          })
          const [media] = await service.createReviewMedias([
            {
              review_id: review.id,
              type: 'image',
              file_id: 'file_curate_comp',
              url: 'http://localhost/static/file_curate_comp.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])

          // Pinned and hidden last week, through the real, committed
          // (non-synthetic) path - this is the curation a rollback of a
          // LATER, unrelated request must never clear.
          const pinnedSince = new Date('2026-08-01T00:00:00.000Z')
          const hiddenSince = new Date('2026-08-02T00:00:00.000Z')
          await service.updateReviewMedias({
            id: media.id,
            pinned_at: pinnedSince,
            hidden_at: hiddenSince,
          })

          // This week: a moderator unpins AND unhides in one request. The
          // step itself commits successfully (pinned_at/hidden_at both go
          // to null) before the injected step downstream fails the whole
          // workflow.
          await runAndExpectRejection(
            curateWorkflowUnderTest(container).run({
              input: { id: media.id, pinned: false, hidden: false },
            }),
            'forced failure for compensation test'
          )

          // The load-bearing assertion: compensation must put BOTH columns
          // back to their PREVIOUS values, not leave either null (which is
          // what the failed request's own un-pin/un-hide already set them
          // to, and what a naive "just clear curation" compensation would
          // leave in place).
          const [restored] = await service.listReviewMedias({ id: media.id })
          expect(restored.pinned_at).not.toBeNull()
          expect(restored.pinned_at?.toISOString()).toEqual(pinnedSince.toISOString())
          expect(restored.hidden_at).not.toBeNull()
          expect(restored.hidden_at?.toISOString()).toEqual(hiddenSince.toISOString())
        }
      )

      it('restores pinned_at to null when a downstream step fails after a fresh pin', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_curate_comp_fresh',
          display_name: 'Comp fresh',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })
        const [media] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_curate_comp_fresh',
            url: 'http://localhost/static/file_curate_comp_fresh.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])

        await runAndExpectRejection(
          curateWorkflowUnderTest(container).run({
            input: { id: media.id, pinned: true },
          }),
          'forced failure for compensation test'
        )

        const [restored] = await service.listReviewMedias({ id: media.id })
        expect(restored.pinned_at).toBeNull()
        // The field this request never touched must be entirely unaffected
        // by compensation, not just "also null" - it was already null, so
        // this alone wouldn't catch a compensation that overwrites every
        // column unconditionally; the paired test above (unpin+unhide)
        // covers the non-null case for hidden_at.
        expect(restored.hidden_at).toBeNull()
      })
    })
  },
})
