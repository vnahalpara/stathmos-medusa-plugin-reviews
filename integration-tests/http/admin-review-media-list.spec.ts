import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { createAdminUser, adminHeaders } from '../helpers/admin'

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await createAdminUser(getContainer())
    })

    /**
     * The decoy this project's standing instruction (see progress.md's
     * "pattern worth carrying into the remaining tasks") calls for: a
     * single-review test would pass even with the `review_id` filter
     * dropped entirely, which is the exact failure this project has now
     * hit five times. A second review with its own media proves the
     * filter is real.
     */
    it("returns only the requested review's media, not another review's", async () => {
      const service = getContainer().resolve(REVIEW_MODULE)

      const target = await service.createReviews({
        product_id: 'prod_media_list_a',
        display_name: 'Target',
        rating: 5,
        content: 'x'.repeat(10),
      })
      const decoy = await service.createReviews({
        product_id: 'prod_media_list_b',
        display_name: 'Decoy',
        rating: 5,
        content: 'y'.repeat(10),
      })

      const [targetMedia] = await service.createReviewMedias([
        {
          review_id: target.id,
          type: 'image',
          file_id: 'file_list_target',
          url: 'http://localhost/static/file_list_target.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
      ])
      await service.createReviewMedias([
        {
          review_id: decoy.id,
          type: 'image',
          file_id: 'file_list_decoy',
          url: 'http://localhost/static/file_list_decoy.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
      ])

      const response = await api.get(`/admin/reviews/${target.id}/media`, adminHeaders)

      expect(response.status).toEqual(200)
      expect(response.data.media).toHaveLength(1)
      expect(response.data.media[0].id).toEqual(targetMedia.id)
    })

    it('reports an empty array for a review with no media', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      const review = await service.createReviews({
        product_id: 'prod_media_list_none',
        display_name: 'Guest',
        rating: 5,
        content: 'x'.repeat(10),
      })

      const response = await api.get(`/admin/reviews/${review.id}/media`, adminHeaders)

      expect(response.status).toEqual(200)
      expect(response.data.media).toEqual([])
    })

    /**
     * The half that distinguishes this from the store-facing
     * listVisibleReviewMedias() rule, and the half admin-review-media-
     * count.spec.ts already proved for the count endpoint - this is the
     * same rule applied to the list.
     */
    it('includes media the moderator has already hidden', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      const review = await service.createReviews({
        product_id: 'prod_media_list_hidden',
        display_name: 'Guest',
        rating: 5,
        content: 'x'.repeat(10),
      })

      const [visible] = await service.createReviewMedias([
        {
          review_id: review.id,
          type: 'image',
          file_id: 'file_list_visible',
          url: 'http://localhost/static/file_list_visible.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
      ])
      const [hidden] = await service.createReviewMedias([
        {
          review_id: review.id,
          type: 'image',
          file_id: 'file_list_hidden',
          url: 'http://localhost/static/file_list_hidden.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
      ])
      await service.updateReviewMedias({ id: hidden.id, hidden_at: new Date() })

      const response = await api.get(`/admin/reviews/${review.id}/media`, adminHeaders)

      expect(response.data.media).toHaveLength(2)
      const ids = response.data.media.map((item: { id: string }) => item.id)
      expect(ids).toEqual(expect.arrayContaining([visible.id, hidden.id]))

      const hiddenItem = response.data.media.find((item: { id: string }) => item.id === hidden.id)
      expect(hiddenItem.hidden_at).not.toBeNull()
      const visibleItem = response.data.media.find(
        (item: { id: string }) => item.id === visible.id
      )
      expect(visibleItem.hidden_at).toBeNull()
    })

    it('orders media by sort_order, not creation order', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      const review = await service.createReviews({
        product_id: 'prod_media_list_order',
        display_name: 'Guest',
        rating: 5,
        content: 'x'.repeat(10),
      })

      // Created out of order on purpose: last, first, middle.
      const [last] = await service.createReviewMedias([
        {
          review_id: review.id,
          type: 'image',
          file_id: 'file_list_last',
          url: 'http://localhost/static/file_list_last.png',
          mime_type: 'image/png',
          size_bytes: 100,
          sort_order: 2,
        },
      ])
      const [first] = await service.createReviewMedias([
        {
          review_id: review.id,
          type: 'image',
          file_id: 'file_list_first',
          url: 'http://localhost/static/file_list_first.png',
          mime_type: 'image/png',
          size_bytes: 100,
          sort_order: 0,
        },
      ])
      const [middle] = await service.createReviewMedias([
        {
          review_id: review.id,
          type: 'image',
          file_id: 'file_list_middle',
          url: 'http://localhost/static/file_list_middle.png',
          mime_type: 'image/png',
          size_bytes: 100,
          sort_order: 1,
        },
      ])

      const response = await api.get(`/admin/reviews/${review.id}/media`, adminHeaders)

      expect(response.data.media.map((item: { id: string }) => item.id)).toEqual([
        first.id,
        middle.id,
        last.id,
      ])
    })

    /**
     * Route-collision check, run explicitly rather than assumed: this
     * task adds GET /admin/reviews/:id/media alongside the pre-existing
     * DELETE /admin/reviews/media/:id. The two path patterns only
     * *structurally* overlap if a review's id were literally the string
     * "media" (real ids are prefix-generated, e.g. `rev_...`, so this
     * never happens in practice) - see task-9-report.md for the full
     * analysis. This proves both routes resolve to their own handler for
     * realistic ids, in the same test run, so a genuine conflict would
     * fail one assertion or the other rather than passing by accident.
     */
    it('GET /admin/reviews/:id/media and DELETE /admin/reviews/media/:id both resolve correctly', async () => {
      const service = getContainer().resolve(REVIEW_MODULE)
      const review = await service.createReviews({
        product_id: 'prod_media_list_collision',
        display_name: 'Guest',
        rating: 5,
        content: 'x'.repeat(10),
      })
      const [media] = await service.createReviewMedias([
        {
          review_id: review.id,
          type: 'image',
          file_id: 'file_list_collision',
          url: 'http://localhost/static/file_list_collision.png',
          mime_type: 'image/png',
          size_bytes: 100,
        },
      ])

      const listResponse = await api.get(`/admin/reviews/${review.id}/media`, adminHeaders)
      expect(listResponse.status).toEqual(200)
      expect(listResponse.data.media).toHaveLength(1)
      expect(listResponse.data.media[0].id).toEqual(media.id)

      const deleteResponse = await api.delete(`/admin/reviews/media/${media.id}`, adminHeaders)
      expect(deleteResponse.status).toEqual(200)
      expect(deleteResponse.data).toEqual({ id: media.id, object: 'review_media', deleted: true })

      const afterDelete = await api.get(`/admin/reviews/${review.id}/media`, adminHeaders)
      expect(afterDelete.data.media).toEqual([])
    })

    it('requires authentication', async () => {
      const response = await api
        .get('/admin/reviews/rev_nope/media')
        .catch((e) => e.response)

      expect(response.status).toEqual(401)
    })
  },
})
