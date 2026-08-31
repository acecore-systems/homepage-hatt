import { getAccessIdentity, type CmsAccessEnv } from './_access-auth.ts'
import {
  handleProductFilesDelete,
  handleProductFilesGet,
  handleProductFilesPost,
  handleProductFilesPut,
} from '../../api/shop/admin/files.ts'
import {
  handleApiError,
  methodNotAllowed,
  ShopApiError,
  type ShopEnv,
} from '../../api/shop/_shared.ts'

type CmsProductFilesContext = {
  request: Request
  env: ShopEnv & CmsAccessEnv
}

export const onRequestGet = async ({
  request,
  env,
}: CmsProductFilesContext) => {
  try {
    await requireCmsProductFilesAdmin(request, env)
    return await handleProductFilesGet(request, env)
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestPost = async ({
  request,
  env,
}: CmsProductFilesContext) => {
  try {
    const identity = await requireCmsProductFilesAdmin(request, env)
    return await handleProductFilesPost(request, env, identity)
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestPut = async ({
  request,
  env,
}: CmsProductFilesContext) => {
  try {
    await requireCmsProductFilesAdmin(request, env)
    return await handleProductFilesPut(request, env)
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestDelete = async ({
  request,
  env,
}: CmsProductFilesContext) => {
  try {
    await requireCmsProductFilesAdmin(request, env)
    return await handleProductFilesDelete(request, env)
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestPatch = () =>
  methodNotAllowed(['GET', 'POST', 'PUT', 'DELETE'])

async function requireCmsProductFilesAdmin(
  request: Request,
  env: ShopEnv & CmsAccessEnv,
) {
  const identity = await getAccessIdentity(request, env)
  if (!identity.ok) {
    throw new ShopApiError(identity.status, identity.message)
  }
  return identity
}
