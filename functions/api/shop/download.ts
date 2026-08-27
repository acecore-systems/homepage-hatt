import {
  getDb,
  getFiles,
  handleApiError,
  hashDownloadToken,
  jsonResponse,
  methodNotAllowed,
  type PagesContext,
} from './_shared'

type DownloadTokenRow = {
  token_hash: string
  order_id: string
  product_slug: string
  r2_object_key: string
  expires_at: string
  max_uses: number
  use_count: number
}

export const onRequestGet = async ({ request, env }: PagesContext) => {
  try {
    const token = new URL(request.url).searchParams.get('token') || ''
    if (token.length < 24 || token.length > 160) {
      return jsonResponse(
        { ok: false, message: 'ダウンロードURLが無効です。' },
        404,
      )
    }

    const db = getDb(env)
    const files = getFiles(env)
    const tokenHash = await hashDownloadToken(env, token)
    const row = await db
      .prepare(
        `SELECT *
         FROM shop_download_tokens
         WHERE token_hash = ? AND expires_at > ? AND use_count < max_uses
         LIMIT 1`,
      )
      .bind(tokenHash, new Date().toISOString())
      .first<DownloadTokenRow>()

    if (!row) {
      return jsonResponse(
        { ok: false, message: 'ダウンロードURLが無効です。' },
        404,
      )
    }

    const object = await files.get(row.r2_object_key)
    if (!object) {
      return jsonResponse(
        { ok: false, message: 'ファイルが見つかりません。' },
        404,
      )
    }

    await db
      .prepare(
        `UPDATE shop_download_tokens
         SET use_count = use_count + 1, last_used_at = ?
         WHERE token_hash = ?`,
      )
      .bind(new Date().toISOString(), tokenHash)
      .run()

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    headers.set('Cache-Control', 'private, no-store')
    headers.set(
      'Content-Disposition',
      `attachment; filename="${row.product_slug}.zip"`,
    )

    return new Response(object.body, { headers })
  } catch (error) {
    return handleApiError(error)
  }
}

export const onRequestPost = () => methodNotAllowed(['GET'])
