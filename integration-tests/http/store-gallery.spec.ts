import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { getPublishableKeyHeaders } from '../helpers/store'

type MediaInput = {
  review_id: string
  type: 'image' | 'video'
  file_id: string
  url: string
  mime_type: string
  size_bytes: number
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /store/reviews/gallery', () => {
      let storeHeaders: Record<string, string>

      beforeAll(async () => {
        storeHeaders = await getPublishableKeyHeaders(getContainer())
      })

      // Settings resolve through the Cache Module, which the DB-restore-
      // per-test harness does not reset - same convention as
      // store-vote.spec.ts/store-read.spec.ts's identical afterEach.
      afterEach(async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const rows = await service.listReviewSettings()
        if (rows.length) {
          await service.deleteReviewSettings(rows.map((r) => r.id))
        }
        await updateReviewSettingsWorkflow(getContainer()).run({ input: {} })
      })

      it(
        "returns only an approved review's media, with a pending review's " +
          'media seeded FIRST so an unfiltered query would return it',
        async () => {
          const container = getContainer()
          const service = container.resolve(REVIEW_MODULE)

          const pending = await service.createReviews({
            product_id: 'prod_gallery_approval',
            display_name: 'Pending',
            rating: 5,
            content: 'x'.repeat(20),
            status: 'pending',
          })
          await service.createReviewMedias([
            {
              review_id: pending.id,
              type: 'image',
              file_id: 'file_gallery_pending',
              url: 'http://localhost/static/file_gallery_pending.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])

          const approved = await service.createReviews({
            product_id: 'prod_gallery_approval',
            display_name: 'Approved',
            rating: 4,
            content: 'x'.repeat(20),
            status: 'approved',
          })
          const [approvedMedia] = await service.createReviewMedias([
            {
              review_id: approved.id,
              type: 'image',
              file_id: 'file_gallery_approved',
              url: 'http://localhost/static/file_gallery_approved.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])

          const response = await api.get(
            '/store/reviews/gallery?product_id=prod_gallery_approval',
            { headers: storeHeaders }
          )

          expect(response.status).toEqual(200)
          expect(response.data.count).toEqual(1)
          expect(response.data.media).toHaveLength(1)
          expect(response.data.media[0].id).toEqual(approvedMedia.id)
        }
      )

      it('excludes hidden media, seeded FIRST so an unfiltered query would return it', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_gallery_hidden',
          display_name: 'Guest',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })

        const [hidden] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_gallery_hidden',
            url: 'http://localhost/static/file_gallery_hidden.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])
        await service.updateReviewMedias({ id: hidden.id, hidden_at: new Date() })

        const [visible] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_gallery_visible',
            url: 'http://localhost/static/file_gallery_visible.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])

        const response = await api.get('/store/reviews/gallery?product_id=prod_gallery_hidden', {
          headers: storeHeaders,
        })

        expect(response.data.count).toEqual(1)
        expect(response.data.media.map((m: { id: string }) => m.id)).toEqual([visible.id])
      })

      it(
        'scopes to product_id when given (a decoy product seeded FIRST), ' +
          'and returns the global gallery when product_id is omitted',
        async () => {
          const container = getContainer()
          const service = container.resolve(REVIEW_MODULE)

          const decoyReview = await service.createReviews({
            product_id: 'prod_gallery_other',
            display_name: 'Other product',
            rating: 5,
            content: 'x'.repeat(20),
            status: 'approved',
          })
          const [decoyMedia] = await service.createReviewMedias([
            {
              review_id: decoyReview.id,
              type: 'image',
              file_id: 'file_gallery_scope_decoy',
              url: 'http://localhost/static/file_gallery_scope_decoy.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])

          const targetReview = await service.createReviews({
            product_id: 'prod_gallery_target',
            display_name: 'Target product',
            rating: 5,
            content: 'x'.repeat(20),
            status: 'approved',
          })
          const [targetMedia] = await service.createReviewMedias([
            {
              review_id: targetReview.id,
              type: 'image',
              file_id: 'file_gallery_scope_target',
              url: 'http://localhost/static/file_gallery_scope_target.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])

          const scoped = await api.get('/store/reviews/gallery?product_id=prod_gallery_target', {
            headers: storeHeaders,
          })
          expect(scoped.data.count).toEqual(1)
          expect(scoped.data.media.map((m: { id: string }) => m.id)).toEqual([targetMedia.id])

          const global = await api.get('/store/reviews/gallery', { headers: storeHeaders })
          expect(global.data.count).toEqual(2)
          expect(global.data.media.map((m: { id: string }) => m.id).sort()).toEqual(
            [decoyMedia.id, targetMedia.id].sort()
          )
        }
      )

      it('filters by type=image/video; type=all and an omitted type both return everything', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_gallery_type',
          display_name: 'Guest',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })

        const [image] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_gallery_type_image',
            url: 'http://localhost/static/file_gallery_type_image.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])
        const [video] = await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'video',
            file_id: 'file_gallery_type_video',
            url: 'http://localhost/static/file_gallery_type_video.mp4',
            mime_type: 'video/mp4',
            size_bytes: 1000,
          } satisfies MediaInput,
        ])

        const imageOnly = await api.get(
          '/store/reviews/gallery?product_id=prod_gallery_type&type=image',
          { headers: storeHeaders }
        )
        expect(imageOnly.data.media.map((m: { id: string }) => m.id)).toEqual([image.id])

        const videoOnly = await api.get(
          '/store/reviews/gallery?product_id=prod_gallery_type&type=video',
          { headers: storeHeaders }
        )
        expect(videoOnly.data.media.map((m: { id: string }) => m.id)).toEqual([video.id])

        const explicitAll = await api.get(
          '/store/reviews/gallery?product_id=prod_gallery_type&type=all',
          { headers: storeHeaders }
        )
        expect(explicitAll.data.media).toHaveLength(2)

        const omitted = await api.get('/store/reviews/gallery?product_id=prod_gallery_type', {
          headers: storeHeaders,
        })
        expect(omitted.data.media).toHaveLength(2)
      })

      it(
        'orders pinned media first, then newest - an OLD pinned item outranks ' +
          'a NEW unpinned one, which `created_at DESC` alone would get wrong',
        async () => {
          const container = getContainer()
          const service = container.resolve(REVIEW_MODULE)

          const review = await service.createReviews({
            product_id: 'prod_gallery_order',
            display_name: 'Guest',
            rating: 5,
            content: 'x'.repeat(20),
            status: 'approved',
          })

          const [oldItem] = await service.createReviewMedias([
            {
              review_id: review.id,
              type: 'image',
              file_id: 'file_gallery_order_old',
              url: 'http://localhost/static/file_gallery_order_old.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])

          // Created strictly after oldItem, so its created_at is strictly
          // newer - under a bare `created_at DESC` this would sort FIRST.
          const [newItem] = await service.createReviewMedias([
            {
              review_id: review.id,
              type: 'image',
              file_id: 'file_gallery_order_new',
              url: 'http://localhost/static/file_gallery_order_new.png',
              mime_type: 'image/png',
              size_bytes: 100,
            } satisfies MediaInput,
          ])

          // Pinned only now, after both exist - mirrors the real curation
          // flow (Task 5's endpoint pins an already-published photo later,
          // it does not backdate it).
          await service.updateReviewMedias({ id: oldItem.id, pinned_at: new Date() })

          const response = await api.get('/store/reviews/gallery?product_id=prod_gallery_order', {
            headers: storeHeaders,
          })

          // The load-bearing assertion: oldItem leads despite being older,
          // because pinned_at outranks recency.
          expect(response.data.media.map((m: { id: string }) => m.id)).toEqual([
            oldItem.id,
            newItem.id,
          ])
        }
      )

      it('rejects limit over 100 with 400, and defaults to 20 when limit is omitted', async () => {
        const rejected = await api
          .get('/store/reviews/gallery?limit=101', { headers: storeHeaders })
          .catch((e) => e.response)
        expect(rejected.status).toEqual(400)

        const defaulted = await api.get('/store/reviews/gallery', { headers: storeHeaders })
        expect(defaulted.status).toEqual(200)
        expect(defaulted.data.limit).toEqual(20)
      })

      it('404s when the gallery is disabled', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({ input: { gallery_enabled: false } })

        const response = await api
          .get('/store/reviews/gallery', { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(404)
      })

      // I1 (Phase 4 final review): the route used to check only
      // `gallery_enabled`, so a merchant who switched reviews off
      // store-wide - `enabled: false` - kept serving every approved
      // review's photos and videos from this one route. Real,
      // gallery-visible media is seeded here specifically so this test
      // would fail (200 with a full media payload) if the `enabled` half
      // of the route's condition were ever removed again - an empty
      // gallery would 404-or-empty either way and prove nothing.
      it('404s when reviews are disabled store-wide, even though gallery_enabled is still true', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_gallery_master_switch',
          display_name: 'Guest',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })
        await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_gallery_master_switch',
            url: 'http://localhost/static/file_gallery_master_switch.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])

        await updateReviewSettingsWorkflow(container).run({ input: { enabled: false } })

        const response = await api
          .get('/store/reviews/gallery?product_id=prod_gallery_master_switch', {
            headers: storeHeaders,
          })
          .catch((e) => e.response)

        expect(response.status).toEqual(404)
      })

      it('never exposes email, customer_id or replied_by', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_gallery_pii',
          display_name: 'Secretive',
          email: 'secret-reviewer@example.com',
          customer_id: 'cus_secret_gallery',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })
        await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_gallery_pii',
            url: 'http://localhost/static/file_gallery_pii.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])
        await service.createReviewReplies({
          review_id: review.id,
          content: 'Thanks for the kind words!',
          replied_by: 'usr_secret_gallery',
        })

        const response = await api.get('/store/reviews/gallery?product_id=prod_gallery_pii', {
          headers: storeHeaders,
        })

        expect(response.data.media).toHaveLength(1)
        expect(response.data.media[0].email).toBeUndefined()
        expect(response.data.media[0].customer_id).toBeUndefined()
        expect(response.data.media[0].replied_by).toBeUndefined()

        // Belt-and-braces over the whole payload, not just the first
        // item's keys - the same convention store-read.spec.ts uses.
        const serialized = JSON.stringify(response.data)
        expect(serialized).not.toContain('secret-reviewer@example.com')
        expect(serialized).not.toContain('cus_secret_gallery')
        expect(serialized).not.toContain('usr_secret_gallery')
      })

      it('exposes exactly the allow-listed fields on each media item', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        const review = await service.createReviews({
          product_id: 'prod_gallery_shape',
          display_name: 'Guest',
          rating: 5,
          content: 'x'.repeat(20),
          status: 'approved',
        })
        await service.createReviewMedias([
          {
            review_id: review.id,
            type: 'image',
            file_id: 'file_gallery_shape',
            url: 'http://localhost/static/file_gallery_shape.png',
            mime_type: 'image/png',
            size_bytes: 100,
          } satisfies MediaInput,
        ])

        const response = await api.get('/store/reviews/gallery?product_id=prod_gallery_shape', {
          headers: storeHeaders,
        })

        expect(Object.keys(response.data.media[0]).sort()).toEqual(
          [
            'id',
            'review_id',
            'type',
            'url',
            'thumbnail_url',
            'pinned_at',
            'created_at',
            'rating',
            'display_name',
            'product_id',
          ].sort()
        )
      })

      it('sets a shared-cache Cache-Control header', async () => {
        const response = await api.get('/store/reviews/gallery', { headers: storeHeaders })

        expect(response.headers['cache-control']).toEqual(
          'public, max-age=0, s-maxage=60, stale-while-revalidate=300'
        )
      })
    })
  },
})
