import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { Modules } from '@medusajs/framework/utils'
import { REVIEW_MODULE } from '../../src/modules/review'
import { updateReviewSettingsWorkflow } from '../../src/workflows/update-review-settings'
import { createCustomerAuthHeaders, getPublishableKeyHeaders } from '../helpers/store'
import { emittedEvents, REVIEW_WORKFLOW_EVENTS } from '../helpers/events'

const body = {
  product_id: 'prod_submit',
  rating: 5,
  content: 'A perfectly serviceable jumper, warm and well made.',
  display_name: 'Ada',
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/reviews', () => {
      let storeHeaders: Record<string, string>

      beforeAll(async () => {
        storeHeaders = await getPublishableKeyHeaders(getContainer())
      })

      // Reset settings between tests so cases do not leak into each other.
      afterEach(async () => {
        const service = getContainer().resolve(REVIEW_MODULE)
        const rows = await service.listReviewSettings()
        if (rows.length) {
          await service.deleteReviewSettings(rows.map((r) => r.id))
        }
        await updateReviewSettingsWorkflow(getContainer()).run({ input: {} })
        jest.restoreAllMocks()
      })

      /**
       * Both halves matter and neither is redundant.
       *
       * The `require_approval: false` half is the feature: nobody ever
       * moderates an auto-approved review, so moderateReviewsWorkflow - the
       * plugin's other emitter of `review.approved` - never runs for it,
       * and without this emission the one event meaning "a review became
       * publicly visible" would never fire on such a store. A host
       * revalidating its PDP cache on `review.approved` would work on an
       * approval-gated store and silently do nothing here.
       *
       * The `require_approval: true` half is the decoy: an unconditional
       * emit passes the first half on its own, and would then announce
       * every unmoderated submission as approved - publishing pending
       * content into any cache a subscriber warms. Asserting the exact
       * event list (not just "contains review.approved") is what makes
       * that failure visible.
       */
      it('emits review.approved alongside review.created only when the store auto-approves', async () => {
        const emitSpy = jest.spyOn(getContainer().resolve(Modules.EVENT_BUS), 'emit')

        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true, require_approval: false },
        })
        emitSpy.mockClear()

        const approved = await api.post(
          '/store/reviews',
          { ...body, product_id: 'prod_event_auto' },
          { headers: storeHeaders }
        )
        expect(approved.data.review.status).toEqual('approved')

        expect(emittedEvents(emitSpy, REVIEW_WORKFLOW_EVENTS)).toEqual([
          { name: 'review.created', data: { id: approved.data.review.id } },
          {
            name: 'review.approved',
            // product_id is the whole point of the payload: a subscriber
            // revalidating a cache cannot act on a review id alone.
            data: { id: approved.data.review.id, product_id: 'prod_event_auto' },
          },
        ])

        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true, require_approval: true },
        })
        emitSpy.mockClear()

        const pending = await api.post(
          '/store/reviews',
          { ...body, product_id: 'prod_event_pending' },
          { headers: storeHeaders }
        )
        expect(pending.data.review.status).toEqual('pending')

        expect(emittedEvents(emitSpy, REVIEW_WORKFLOW_EVENTS)).toEqual([
          { name: 'review.created', data: { id: pending.data.review.id } },
        ])
      })

      it('rejects a guest when allow_guest is off', async () => {
        const response = await api
          .post('/store/reviews', body, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(401)
      })

      it('accepts a guest as pending when allow_guest is on', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true },
        })

        const response = await api.post('/store/reviews', body, { headers: storeHeaders })

        expect(response.status).toEqual(201)
        expect(response.data.review.status).toEqual('pending')
        expect(response.data.review.is_verified_purchase).toBe(false)
      })

      it('auto-approves when require_approval is off', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true, require_approval: false },
        })

        const response = await api.post(
          '/store/reviews',
          { ...body, product_id: 'prod_auto' },
          { headers: storeHeaders }
        )

        expect(response.data.review.status).toEqual('approved')
      })

      // NOTE (deviation from the task brief, per controller ruling R6): the
      // brief's test expected 403 here. The workflow correctly throws
      // MedusaError.Types.NOT_ALLOWED for this case (a guest cannot satisfy
      // verified_only), and Medusa's real error-handler middleware maps
      // NOT_ALLOWED to HTTP 400, not 403 - only MedusaError.Types.FORBIDDEN
      // maps to 403. Distorting the workflow to throw FORBIDDEN instead
      // would be semantically wrong (this is a business-rule rejection, not
      // an authorization/permissions failure), so the error type was kept
      // and this expectation was corrected to match the observed mapping.
      it('rejects a guest outright when verified_only is on', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true, verified_only: true },
        })

        const response = await api
          .post(
            '/store/reviews',
            { ...body, product_id: 'prod_verified' },
            { headers: storeHeaders }
          )
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })

      it('404s every store route when reviews are disabled', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true, enabled: false },
        })

        const response = await api
          .post('/store/reviews', { ...body, product_id: 'prod_off' }, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(404)
      })

      it('rejects a rating outside 1-5', async () => {
        const response = await api
          .post('/store/reviews', { ...body, rating: 9 }, { headers: storeHeaders })
          .catch((e) => e.response)

        expect(response.status).toEqual(400)
      })

      it('does not expose a guest email', async () => {
        await updateReviewSettingsWorkflow(getContainer()).run({
          input: { allow_guest: true },
        })

        const response = await api.post(
          '/store/reviews',
          { ...body, product_id: 'prod_email', email: 'ada@example.com' },
          { headers: storeHeaders }
        )

        expect(response.data.review.email).toBeUndefined()
      })

      // Controller ruling R5: the route reads req.auth_context?.actor_id to
      // distinguish a signed-in customer from a guest, but that context is
      // only ever populated if authenticate('customer', ...) actually runs
      // ahead of the route. Without this test, a regression that dropped
      // (or misordered) that middleware would silently turn every customer
      // into a guest - no verified badge could ever be earned and
      // one_review_per_customer would never fire - while every other test
      // in this file would keep passing, since none of them send a token.
      it('attributes a review to a signed-in customer, while an anonymous request stays unattributed', async () => {
        const container = getContainer()
        const service = container.resolve(REVIEW_MODULE)

        await updateReviewSettingsWorkflow(container).run({
          input: { allow_guest: true },
        })

        const { customer, headers: authHeaders } = await createCustomerAuthHeaders(
          container,
          'attribution-test@example.com'
        )

        const customerResponse = await api.post(
          '/store/reviews',
          { ...body, product_id: 'prod_customer_attribution' },
          { headers: { ...storeHeaders, ...authHeaders } }
        )
        expect(customerResponse.status).toEqual(201)

        const [customerReview] = await service.listReviews({
          id: customerResponse.data.review.id,
        })
        expect(customerReview.customer_id).toEqual(customer.id)

        const guestResponse = await api.post(
          '/store/reviews',
          { ...body, product_id: 'prod_guest_attribution' },
          { headers: storeHeaders }
        )
        expect(guestResponse.status).toEqual(201)

        const [guestReview] = await service.listReviews({ id: guestResponse.data.review.id })
        expect(guestReview.customer_id).toBeNull()
      })
    })
  },
})
