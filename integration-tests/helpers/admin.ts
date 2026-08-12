import { MedusaContainer } from '@medusajs/framework/types'
import { createUsersWorkflow } from '@medusajs/medusa/core-flows'
import jwt from 'jsonwebtoken'

export const adminHeaders = {
  headers: { authorization: '' as string },
}

export async function createAdminUser(container: MedusaContainer) {
  const { result } = await createUsersWorkflow(container).run({
    input: { users: [{ email: 'admin@test.local', first_name: 'Ad', last_name: 'Min' }] },
  })

  const token = jwt.sign(
    { actor_id: result[0].id, actor_type: 'user', auth_identity_id: 'test', app_metadata: {} },
    'test',
    { expiresIn: '1d' }
  )

  adminHeaders.headers.authorization = `Bearer ${token}`

  return result[0]
}
