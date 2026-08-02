import {
  assertSellerDisclosureRequestOrigin,
  getSellerDisclosurePublicConfig,
  processSellerDisclosureRequest,
  validateSellerDisclosureRequest,
} from './_disclosure.ts'
import {
  handleApiError,
  jsonResponse,
  methodNotAllowed,
  readJson,
  type PagesContext,
} from './_shared.ts'

export const onRequestGet = async ({ request, env }: PagesContext) =>
  jsonResponse({
    ok: true,
    ...(await getSellerDisclosurePublicConfig(request, env)),
  })

export const onRequestPost = async ({ request, env }: PagesContext) => {
  try {
    assertSellerDisclosureRequestOrigin(request, env)
    const input = validateSellerDisclosureRequest(await readJson(request))
    const result = await processSellerDisclosureRequest(request, env, input)

    return jsonResponse(
      {
        ok: true,
        requestId: result.requestId,
        message: '販売者情報をメールで送信しました。',
      },
      201,
    )
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestOptions = () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })

export const onRequestPut = () => methodNotAllowed(['GET', 'POST', 'OPTIONS'])
export const onRequestPatch = () => methodNotAllowed(['GET', 'POST', 'OPTIONS'])
export const onRequestDelete = () =>
  methodNotAllowed(['GET', 'POST', 'OPTIONS'])
