type PagesContext = {
  request: Request
  next: () => Promise<Response>
}

export const onRequestGet = async ({
  request,
  next,
}: PagesContext): Promise<Response> => {
  const response = await next()

  if (!response.ok) return response

  const origin = new URL(request.url).origin
  const source = await response.text()
  const config = source
    .replace(/^(\s*api_root:\s*).+$/m, `$1${origin}/admin/api/github`)
    .replace(/^(\s*graphql_api_root:\s*).+$/m, `$1${origin}/admin/api/graphql`)

  return new Response(config, {
    status: response.status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/yaml; charset=utf-8',
    },
  })
}
