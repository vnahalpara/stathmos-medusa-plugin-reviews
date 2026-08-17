import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import sharp from 'sharp'
import { REVIEW_MODULE } from '../../src/modules/review'
import { recomputeReviewStats } from '../../src/workflows/steps/recompute-review-stats'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { createReviewWorkflow } from '../../src/workflows/create-review'
import { uploadReviewMediaWorkflow } from '../../src/workflows/upload-review-media'
import { createCustomerAuthHeaders, getPublishableKeyHeaders } from '../helpers/store'
import { emittedEvents, REVIEW_WORKFLOW_EVENTS } from '../helpers/events'

async function pngBase64(background: string): Promise<string> {
  const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background } })
    .png()
    .toBuffer()

  return buf.toString('base64')
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/reviews/:id', () => {
      let storeHeaders: Record<string, string>

      beforeAll(async () => {
        storeHeaders = await getPublishableKeyHeaders(getContainer())
      })

      // Settings resolve through the Cache Module, which the DB-restore-
      // per-test harness does not reset - same convention as
      // store-submit.spec.ts/store-vote.spec.ts's identical afterEach.
      afterEach(async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const rows = await service.listReviewSettings()
        if (rows.length) {
          await service.deleteReviewSettings(rows.map((r) => r.id))
        }
        await updateReviewSettingsWorkflow(getContainer()).run({ input: {} })
        jest.restoreAllMocks()
      })

      it("edits the customer's own review and sets edited_at", async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: false },
        })

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'own-edit@example.com'
        )

        const review = await service.createReviews({
          product_id: 'prod_edit_own',
          customer_id: customer.id,
          display_name: 'Ada',
          rating: 3,
          title: 'Original title',
          content: 'The original content of this review, long enough to pass.',
          status: 'approved',
        })

        expect(review.edited_at).toBeNull()

        const response = await api.post(
          `/store/reviews/${review.id}`,
          { rating: 5, title: 'Updated title', content: 'The updated content of this review, also long enough.' },
          { headers: { ...storeHeaders, ...customerHeaders } }
        )

        expect(response.status).toEqual(200)
        expect(response.data.review.rating).toEqual(5)
        expect(response.data.review.title).toEqual('Updated title')
        expect(response.data.review.content).toEqual(
          'The updated content of this review, also long enough.'
        )
        expect(response.data.review.status).toEqual('approved')
        expect(response.data.review.edited_at).not.toBeNull()

        const [updated] = await service.listReviews({ id: review.id })
        expect(updated.rating).toEqual(5)
        expect(updated.title).toEqual('Updated title')
        expect(updated.edited_at).not.toBeNull()
      })

      // Decoy seeded FIRST, per this phase's standing instruction: the
      // OTHER customer's review is created before the acting customer even
      // exists, so a lookup that forgot to scope strictly by `review_id`
      // (or that quietly fell back to "some review this identity can
      // reach") would find it and, worse, might silently succeed against
      // it instead of refusing. Editing someone else's review is the worst
      // outcome available in this feature - it lets one customer rewrite
      // another's public words - so both the refusal AND the decoy's
      // untouched content are asserted.
      it('refuses to edit another customer\'s review, leaving its content untouched', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({ input: { allow_edit: true } })

        const other = await createCustomerAuthHeaders(container, 'owner-of-review@example.com')

        const otherReview = await service.createReviews({
          product_id: 'prod_edit_other_owner',
          customer_id: other.customer.id,
          display_name: 'Original Owner',
          rating: 4,
          title: 'Not yours to change',
          content: 'Content that belongs to the other customer and must survive this test intact.',
          status: 'approved',
        })

        // The acting/attacking customer is created AFTER the review it will
        // try to edit, and has no review of its own at all - there is
        // nothing for a buggy "find a review for this customer" shortcut to
        // land on instead of correctly comparing against the target row.
        const actor = await createCustomerAuthHeaders(container, 'attacker@example.com')

        const response = await api
          .post(
            `/store/reviews/${otherReview.id}`,
            { content: 'Rewritten by someone who does not own this review.' },
            { headers: { ...storeHeaders, ...actor.headers } }
          )
          .catch((e) => e.response)

        expect(response.status).toEqual(403)
        expect(response.data.message).toMatch(/own review/i)

        const [stillOriginal] = await service.listReviews({ id: otherReview.id })
        expect(stillOriginal.content).toEqual(
          'Content that belongs to the other customer and must survive this test intact.'
        )
        expect(stillOriginal.rating).toEqual(4)
        expect(stillOriginal.title).toEqual('Not yours to change')
        expect(stillOriginal.edited_at).toBeNull()
      })

      it('refuses a guest edit and explains that a guest submission has no ownership proof, leaving the review untouched', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({ input: { allow_edit: true } })

        const { customer } = await createCustomerAuthHeaders(container, 'guest-target@example.com')

        const review = await service.createReviews({
          product_id: 'prod_edit_guest',
          customer_id: customer.id,
          display_name: 'Real Owner',
          rating: 5,
          content: 'Content that a guest request must not be able to touch at all.',
          status: 'approved',
        })

        // No auth header at all - the exact shape of an unauthenticated
        // storefront request.
        const response = await api
          .post(
            `/store/reviews/${review.id}`,
            { content: 'A guest tried to rewrite this.' },
            { headers: storeHeaders }
          )
          .catch((e) => e.response)

        expect(response.status).toEqual(403)
        // Must say WHY, not be a bare 403 - there is no credential tying a
        // guest to any review at all.
        expect(response.data.message).toMatch(/guest|account|sign in/i)

        const [stillOriginal] = await service.listReviews({ id: review.id })
        expect(stillOriginal.content).toEqual(
          'Content that a guest request must not be able to touch at all.'
        )
        expect(stillOriginal.edited_at).toBeNull()
      })

      // The core of re-moderation: editing an approved review while
      // require_approval is on must (a) return it to pending, (b) drop it
      // from the storefront listing immediately, and (c) recompute
      // review_stats so it stops contributing to the product's average -
      // all three checked here since they are one causal chain, not three
      // independent behaviours. A second, untouched approved review on the
      // same product is the proof that the recompute correctly re-derives
      // the average from what remains, rather than merely zeroing
      // everything or leaving stale data behind.
      it('sends an edited review back to pending, removes it from the storefront, and recomputes stats to exclude it - leaving a decoy review\'s own contribution intact', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: true },
        })

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'remoderation@example.com'
        )

        const productId = 'prod_edit_remoderation'

        // Decoy: a second customer's approved review on the SAME product,
        // never touched by this test's edit request. If the recompute (or
        // the storefront listing) ever forgot to scope by review id and
        // instead touched "the product's reviews" indiscriminately, this
        // row's own rating would move or vanish too.
        const decoyOwner = await createCustomerAuthHeaders(
          container,
          'remoderation-decoy@example.com'
        )
        await service.createReviews({
          product_id: productId,
          customer_id: decoyOwner.customer.id,
          display_name: 'Decoy',
          rating: 3,
          content: 'A separate approved review on the same product that must not be touched.',
          status: 'approved',
        })

        const review = await service.createReviews({
          product_id: productId,
          customer_id: customer.id,
          display_name: 'Edited Reviewer',
          rating: 5,
          content: 'This review will be edited and must leave the average once it is.',
          status: 'approved',
        })

        await recomputeReviewStats(container, productId)

        const [beforeStats] = await service.listReviewStats({ product_id: productId })
        expect(beforeStats).toMatchObject({ count: 2, average: 4 })

        const beforeListing = await api.get(`/store/products/${productId}/reviews`, {
          headers: storeHeaders,
        })
        expect(beforeListing.data.count).toEqual(2)
        expect(
          beforeListing.data.reviews.some((r: { id: string }) => r.id === review.id)
        ).toBe(true)

        const response = await api.post(
          `/store/reviews/${review.id}`,
          { content: 'Edited content that must trigger re-moderation.' },
          { headers: { ...storeHeaders, ...customerHeaders } }
        )

        expect(response.status).toEqual(200)
        expect(response.data.review.status).toEqual('pending')
        expect(response.data.review.edited_at).not.toBeNull()

        // Removed from the storefront immediately.
        const afterListing = await api.get(`/store/products/${productId}/reviews`, {
          headers: storeHeaders,
        })
        expect(afterListing.data.count).toEqual(1)
        expect(
          afterListing.data.reviews.some((r: { id: string }) => r.id === review.id)
        ).toBe(false)
        expect(
          afterListing.data.reviews.some((r: { display_name: string }) => r.display_name === 'Decoy')
        ).toBe(true)

        // Stats recomputed inside the same workflow: the edited review no
        // longer counts, so count drops to 1 and the average is exactly the
        // decoy's own rating - not zeroed, not stale.
        const [afterStats] = await service.listReviewStats({ product_id: productId })
        expect(afterStats).toMatchObject({ count: 1, average: 3 })
      })

      it('keeps an edit approved when require_approval is off', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: false },
        })

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'stays-approved@example.com'
        )

        const review = await service.createReviews({
          product_id: 'prod_edit_stays_approved',
          customer_id: customer.id,
          display_name: 'Ada',
          rating: 2,
          content: 'Content that will be edited but must remain visible immediately.',
          status: 'approved',
        })

        const response = await api.post(
          `/store/reviews/${review.id}`,
          { rating: 4 },
          { headers: { ...storeHeaders, ...customerHeaders } }
        )

        expect(response.status).toEqual(200)
        expect(response.data.review.status).toEqual('approved')

        const listing = await api.get('/store/products/prod_edit_stays_approved/reviews', {
          headers: storeHeaders,
        })
        expect(listing.data.count).toEqual(1)
        expect(listing.data.reviews[0].rating).toEqual(4)
      })

      /**
       * The edit workflow emitted nothing at all until Phase 5, which made
       * the transition below invisible to any host caching a product page:
       * under `require_approval`, an edit sends an APPROVED review back to
       * `pending`, i.e. removes it from the storefront - and a cached PDP
       * would keep serving it, text and all, for the whole ISR window.
       *
       * Asserted under both settings on purpose. The pending case is the
       * one that must never be missed; the still-approved case is here
       * because a subscriber revalidating on this event has to fire for an
       * ordinary typo fix too - the old text is just as cached as a
       * withdrawn review is.
       */
      it('emits review.updated with the product_id on every edit, whether it stays approved or returns to pending', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)
        const emitSpy = jest.spyOn(container.resolve(Modules.EVENT_BUS), 'emit')

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'edit-events@example.com'
        )

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: false },
        })

        const staysApproved = await service.createReviews({
          product_id: 'prod_edit_event_approved',
          customer_id: customer.id,
          display_name: 'Ada',
          rating: 2,
          content: 'Content long enough to satisfy the configured minimum bound.',
          status: 'approved',
        })

        emitSpy.mockClear()

        const approvedEdit = await api.post(
          `/store/reviews/${staysApproved.id}`,
          { rating: 4 },
          { headers: { ...storeHeaders, ...customerHeaders } }
        )
        expect(approvedEdit.data.review.status).toEqual('approved')

        expect(emittedEvents(emitSpy, REVIEW_WORKFLOW_EVENTS)).toEqual([
          {
            name: 'review.updated',
            data: { id: staysApproved.id, product_id: 'prod_edit_event_approved' },
          },
        ])

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: true },
        })

        const goesPending = await service.createReviews({
          product_id: 'prod_edit_event_pending',
          customer_id: customer.id,
          display_name: 'Ada',
          rating: 5,
          content: 'Another review, currently approved and therefore publicly visible.',
          status: 'approved',
        })

        emitSpy.mockClear()

        const pendingEdit = await api.post(
          `/store/reviews/${goesPending.id}`,
          { content: 'Rewritten content, which sends this review back for moderation.' },
          { headers: { ...storeHeaders, ...customerHeaders } }
        )
        // The review has just LEFT the storefront - the case the event
        // exists for.
        expect(pendingEdit.data.review.status).toEqual('pending')

        expect(emittedEvents(emitSpy, REVIEW_WORKFLOW_EVENTS)).toEqual([
          {
            name: 'review.updated',
            // The product whose cached page still shows a review that is
            // no longer public.
            data: { id: goesPending.id, product_id: 'prod_edit_event_pending' },
          },
        ])
      })

      // Fix round 1, CRITICAL: require_approval: false must never let an
      // edit resurrect a review a moderator explicitly rejected. Policy
      // ("nobody has reviewed this yet, publish it") and a human's specific
      // judgment about THIS review are different things - only a moderator
      // reverses the latter. The review lands in `pending` regardless of
      // require_approval, exactly like any other edit that needs a human
      // to look at it again.
      it('sends an edited REJECTED review to pending even when require_approval is off, and keeps it off the storefront', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: false },
        })

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'rejected-edit@example.com'
        )

        const review = await service.createReviews({
          product_id: 'prod_edit_rejected_stays_pending',
          customer_id: customer.id,
          display_name: 'Ada',
          rating: 1,
          content: 'Content a moderator rejected; editing it must not republish it.',
          status: 'rejected',
          rejection_reason: 'Off-topic',
        })

        const response = await api.post(
          `/store/reviews/${review.id}`,
          { content: 'Fixed content the customer hopes will be approved this time.' },
          { headers: { ...storeHeaders, ...customerHeaders } }
        )

        expect(response.status).toEqual(200)
        expect(response.data.review.status).toEqual('pending')
        expect(response.data.review.edited_at).not.toBeNull()

        const listing = await api.get(
          '/store/products/prod_edit_rejected_stays_pending/reviews',
          { headers: storeHeaders }
        )
        expect(listing.data.count).toEqual(0)

        const [stored] = await service.listReviews({ id: review.id })
        expect(stored.status).toEqual('pending')
      })

      // The companion case, so the fix above is not over-broad: an
      // APPROVED review edited under the same require_approval: false
      // settings must still stay approved and still be listed - only a
      // prior REJECTED status forces the pending override.
      it('keeps an edited APPROVED review approved and listed under the same require_approval: false settings', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: false },
        })

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'approved-edit-not-overbroad@example.com'
        )

        const review = await service.createReviews({
          product_id: 'prod_edit_approved_not_overbroad',
          customer_id: customer.id,
          display_name: 'Ada',
          rating: 4,
          content: 'Content that was approved and must remain approved after a minor edit.',
          status: 'approved',
        })

        const response = await api.post(
          `/store/reviews/${review.id}`,
          { content: 'A small fix to already-approved content.' },
          { headers: { ...storeHeaders, ...customerHeaders } }
        )

        expect(response.status).toEqual(200)
        expect(response.data.review.status).toEqual('approved')

        const listing = await api.get(
          '/store/products/prod_edit_approved_not_overbroad/reviews',
          { headers: storeHeaders }
        )
        expect(listing.data.count).toEqual(1)
        expect(listing.data.reviews[0].id).toEqual(review.id)
      })

      it('refuses the edit with 400 when allow_edit is off, leaving the review untouched', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({ input: { allow_edit: false } })

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'edit-disabled@example.com'
        )

        const review = await service.createReviews({
          product_id: 'prod_edit_disabled',
          customer_id: customer.id,
          display_name: 'Ada',
          rating: 3,
          content: 'Content that must survive because editing is switched off store-wide.',
          status: 'approved',
        })

        const response = await api
          .post(
            `/store/reviews/${review.id}`,
            { content: 'This must never be saved.' },
            { headers: { ...storeHeaders, ...customerHeaders } }
          )
          .catch((e) => e.response)

        expect(response.status).toEqual(400)

        const [stillOriginal] = await service.listReviews({ id: review.id })
        expect(stillOriginal.content).toEqual(
          'Content that must survive because editing is switched off store-wide.'
        )
        expect(stillOriginal.edited_at).toBeNull()
      })

      // Rejection deletes media (Phase 3); editing must not. Exercised
      // under require_approval: true specifically, since that is the
      // riskier path - the review's status changes exactly the way a
      // rejection's does (leaves 'approved'), so this proves the edit
      // workflow never reaches for the rejection-only media-deletion path.
      it("survives the review's media through an edit that returns it to pending", async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: false, allow_guest: true },
        })

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'media-survives@example.com'
        )

        const { result: uploaded } = await uploadReviewMediaWorkflow(container).run({
          input: {
            files: [
              {
                filename: 'photo.png',
                content: await pngBase64('#336699'),
                size_bytes: 100,
              },
            ],
          },
        })

        const { result: review } = await createReviewWorkflow(container).run({
          input: {
            product_id: 'prod_edit_media_survives',
            customer_id: customer.id,
            rating: 4,
            content: 'A review with a photo attached that must survive being edited.',
            display_name: 'Ada',
            media_ids: uploaded.media.map((m) => m.id),
          },
        })

        const mediaBefore = await service.listReviewMedias({ review_id: review.id })
        expect(mediaBefore).toHaveLength(1)

        // Now switch to re-moderation on, so the edit below both changes
        // status AND must not touch media - the same combination that
        // deletes media on a rejection.
        await updateReviewSettingsWorkflow(container).run({
          input: { require_approval: true },
        })

        const response = await api.post(
          `/store/reviews/${review.id}`,
          { content: 'Edited content; the photo above must remain attached.' },
          { headers: { ...storeHeaders, ...customerHeaders } }
        )

        expect(response.status).toEqual(200)
        expect(response.data.review.status).toEqual('pending')

        const mediaAfter = await service.listReviewMedias({ review_id: review.id })
        expect(mediaAfter).toHaveLength(1)
        expect(mediaAfter[0].id).toEqual(mediaBefore[0].id)

        const fileService = container.resolve(Modules.FILE)
        await expect(fileService.getAsBuffer(mediaAfter[0].file_id)).resolves.toBeDefined()
      })

      // Step 3's brief: reuse createReviewWorkflow's content-length bounds
      // rather than duplicating them. This proves the edit path is wired
      // to the SAME settings-driven bound, not a hardcoded or forgotten
      // check - lowering min_content_length in this test and asserting the
      // exact bound value appears in the error message is what would catch
      // a copy that silently diverged from validateReviewSubmissionStep's.
      it('rejects an edit whose content is shorter than the configured minimum, using the same bound review creation uses', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, min_content_length: 50 },
        })

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'too-short-edit@example.com'
        )

        const review = await service.createReviews({
          product_id: 'prod_edit_too_short',
          customer_id: customer.id,
          display_name: 'Ada',
          rating: 3,
          content: 'x'.repeat(60),
          status: 'approved',
        })

        const response = await api
          .post(
            `/store/reviews/${review.id}`,
            { content: 'too short' },
            { headers: { ...storeHeaders, ...customerHeaders } }
          )
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
        expect(response.data.message).toMatch(/at least 50 characters/)

        const [stillOriginal] = await service.listReviews({ id: review.id })
        expect(stillOriginal.content).toEqual('x'.repeat(60))
      })

      it('refuses an edit body with none of rating, title or content', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({ input: { allow_edit: true } })

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'empty-body@example.com'
        )

        const review = await service.createReviews({
          product_id: 'prod_edit_empty_body',
          customer_id: customer.id,
          display_name: 'Ada',
          rating: 3,
          content: 'Content that an empty edit request must not touch.',
          status: 'approved',
        })

        const response = await api
          .post(
            `/store/reviews/${review.id}`,
            {},
            { headers: { ...storeHeaders, ...customerHeaders } }
          )
          .catch((e) => e.response)

        expect(response.status).toEqual(400)

        const [stillOriginal] = await service.listReviews({ id: review.id })
        expect(stillOriginal.edited_at).toBeNull()
      })

      // Fix round 1, MINOR: UpdateReviewSchema only allowed `title` to be
      // omitted, never set to null - applyReviewEditStep's own
      // `input.title !== undefined ? input.title : review.title` branch
      // already handled null correctly, so the schema was the gap.
      // `{ title: null }` is the only way a customer can remove a title
      // they previously added; there is no other endpoint for it.
      it('clears a title when the edit sets it to null, both in the response and in the storefront listing', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_edit: true, require_approval: false },
        })

        const { customer, headers: customerHeaders } = await createCustomerAuthHeaders(
          container,
          'clear-title@example.com'
        )

        const review = await service.createReviews({
          product_id: 'prod_edit_clear_title',
          customer_id: customer.id,
          display_name: 'Ada',
          rating: 4,
          title: 'A title the customer wants to remove',
          content: 'Content that stays exactly as it is; only the title changes.',
          status: 'approved',
        })

        const response = await api.post(
          `/store/reviews/${review.id}`,
          { title: null },
          { headers: { ...storeHeaders, ...customerHeaders } }
        )

        expect(response.status).toEqual(200)
        expect(response.data.review.title).toBeNull()

        const [stored] = await service.listReviews({ id: review.id })
        expect(stored.title).toBeNull()
        expect(stored.content).toEqual(
          'Content that stays exactly as it is; only the title changes.'
        )

        const listing = await api.get('/store/products/prod_edit_clear_title/reviews', {
          headers: storeHeaders,
        })
        expect(listing.data.reviews[0].title).toBeNull()
      })

      // Adjacency check, not an assumption: POST /store/reviews/:id sits at
      // the same path depth as the existing static POST
      // /store/reviews/uploads and GET /store/reviews/gallery routes. Both
      // must keep resolving to their own handlers rather than being
      // swallowed by the new `:id` matcher treating "uploads"/"gallery" as
      // a review id.
      it('does not shadow the sibling static routes /store/reviews/uploads and /store/reviews/gallery', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({ input: { allow_edit: true } })

        await service.createReviews({
          product_id: 'prod_edit_adjacency',
          display_name: 'Ada',
          rating: 5,
          content: 'An approved review with media for the gallery adjacency check.',
          status: 'approved',
        })

        const galleryResponse = await api.get('/store/reviews/gallery', { headers: storeHeaders })
        expect(galleryResponse.status).toEqual(200)

        const form = new FormData()
        form.append(
          'files',
          new Blob([await sharp({ create: { width: 4, height: 4, channels: 3, background: '#abcdef' } }).png().toBuffer()] as BlobPart[], { type: 'image/png' }),
          'adjacency.png'
        )
        const uploadResponse = await api.post('/store/reviews/uploads', form, {
          headers: storeHeaders,
        })
        expect(uploadResponse.status).toEqual(201)
      })
    })
  },
})
