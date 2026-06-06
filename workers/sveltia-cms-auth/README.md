# Sveltia CMS Auth Worker

Sveltia CMS の GitHub OAuth 認証を Cloudflare Workers で受けるための fallback Worker です。

本番の `public/admin/config.yml` は共通 Worker `https://sveltia-cms-auth.sparkling-tree-7cef.workers.dev` を使います。共通 Worker が使えない場合だけ、このディレクトリから Hatt 用にデプロイします。

## GitHub OAuth App

GitHub OAuth App を作成します。

- Homepage URL: `https://hatt.acecore.net/admin/`
- Authorization callback URL: `https://<worker-domain>/callback`

Worker に OAuth App の値を登録します。

```powershell
npx wrangler secret put GITHUB_CLIENT_ID --config workers/sveltia-cms-auth/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config workers/sveltia-cms-auth/wrangler.jsonc
```

デプロイします。

```powershell
npx wrangler deploy --config workers/sveltia-cms-auth/wrangler.jsonc
```

デプロイ後、`public/admin/config.yml` の `backend.base_url` を Worker の URL に差し替えてください。`ALLOWED_DOMAINS` はホスト名で判定するため、`https://hatt.acecore.net/admin/` のような `site_id` 形式でも `hatt.acecore.net` として扱われます。
