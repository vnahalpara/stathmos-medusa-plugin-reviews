import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { getReviewSettings } from '../../../../settings/get-review-settings'
import { updateReviewSettingsWorkflow } from '../../../../workflows/update-review-settings'
import { UpdateReviewSettingsSchema } from '../middlewares'

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const settings = await getReviewSettings(req.scope)

  res.json({ settings })
}

export async function POST(
  req: AuthenticatedMedusaRequest<UpdateReviewSettingsSchema>,
  res: MedusaResponse
) {
  await updateReviewSettingsWorkflow(req.scope).run({ input: req.validatedBody })

  const settings = await getReviewSettings(req.scope)

  res.json({ settings })
}
