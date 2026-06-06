# Sveltia CMS Auth Worker

Sveltia CMS の GitHub OAuth 認証を Cloudflare Workers で受けるための Worker です。既存の共通 Worker が `hatt.acecore.net` を許可していない場合、このディレクトリから Hatt 用にデプロイできます。

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

デプロイ後、`public/admin/config.yml` の `backend.base_url` を Worker の URL に差し替えてください。
