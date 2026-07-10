import { getAccessIdentity, type CmsAccessEnv } from './_access-auth.ts'

export const onRequestGet: PagesFunction<CmsAccessEnv> = async ({
  request,
  env,
}) => {
  const auth = await getAccessIdentity(request, env)

  if (!auth.ok) {
    return json({ message: auth.message }, auth.status)
  }

  return json({ email: auth.email })
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
