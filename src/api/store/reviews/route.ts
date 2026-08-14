import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { REVIEW_MODULE } from '../../../modules/review'
import { createReviewWorkflow } from '../../../workflows/create-review'
import { CreateReviewSchema } from './middlewares'

export async function POST(
  req: AuthenticatedMedusaRequest<CreateReviewSchema>,
  res: MedusaResponse
) {
  const customerId = req.auth_context?.actor_id ?? null

  const { result } = await createReviewWorkflow(req.scope).run({
    input: { ...req.validatedBody, customer_id: customerId },
  })

  const service = req.scope.resolve(REVIEW_MODULE)

  // The one place that deliberately does NOT use listVisibleReviewMedias():
  // a freshly submitted review is not yet approved (unless auto-approval is
  // on), but its own media is the submitter's own content and echoing it
  // back is the point of this response. The exception is named rather than
  // expressed as a raw filter here, so it reads as a decision and cannot be
  // copied into a new store route by accident - see the method's docstring.
  // Visibility to OTHER shoppers is unaffected: every read path goes
  // through the approved-only method.
  const media = await service.listOwnSubmissionMedia(result.id)

  // Field-by-field response, not the model: a guest's email must never
  // reach a store response, and an explicit allow-list cannot leak a
  // column added in a later phase.
  res.status(201).json({
    review: {
      id: result.id,
      product_id: result.product_id,
      rating: result.rating,
      title: result.title,
      content: result.content,
      display_name: result.display_name,
      status: result.status,
      is_verified_purchase: result.is_verified_purchase,
      helpful_count: result.helpful_count,
      created_at: result.created_at,
      media: media
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((m) => ({
          id: m.id,
          type: m.type,
          url: m.url,
          thumbnail_url: m.thumbnail_url,
        })),
    },
  })
}
