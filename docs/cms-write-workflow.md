# CMS 書き込み branch 運用

最終更新日: 2026-06-22

## 現在の方針

- GitHub repository: `acecore-systems/homepage-hatt`
- GitHub default branch: `main`
- CMS backend: `public/admin/config.yml` の `backend.name: github`
- CMS auth mode: Cherry 型（Cloudflare Access + Pages Functions GitHub proxy）
- CMS publication branch: `main`
- CMS PR branch prefix: `cms/hatt/`

`main` を本番ソースの唯一の正にします。Cloudflare Pages の production deploy 元も GitHub 連携の `main` にします。

`cms-content` のような恒久的な投稿受け皿 branch は使いません。CMS 保存は Pages Functions proxy が受け取り、短命な `cms/hatt/*` branch と PR を作成します。

## 現行フロー

1. 編集者が Cloudflare Access 経由で `/admin/` にログインする。
2. Sveltia CMS が `/admin/api/session` で Access 認証済みメールを確認する。
3. Sveltia CMS が `/admin/api/github/*` と `/admin/api/graphql` を GitHub backend として使う。
4. Pages Functions proxy が `CMS_GITHUB_TOKEN` で GitHub API を呼び出す。
5. proxy が content-only の変更を `cms/hatt/*` branch に作成し、`main` 向け PR を開く。
6. PR CI が `npm run format:check`、`npm run validate:content`、`npm run build` を実行する。
7. レビュー後、CMS PR を `main` に merge する。
8. Cloudflare Pages が GitHub `main` push を受けて production deploy する。

## Cloudflare Pages 設定

Cloudflare Pages の production と preview の両方に以下を設定します。

- Secret: `CMS_GITHUB_TOKEN`
- Secret または Variable: `CMS_ACCESS_ALLOWED_EMAILS`
- Secret または Variable: `CMS_ACCESS_ALLOWED_DOMAINS`
- Variable: `CMS_ACCESS_HOSTNAMES`

`CMS_ACCESS_ALLOWED_EMAILS` は CMS 編集を許可する Cloudflare Access ユーザーのメールアドレスをカンマ区切りで指定します。

`CMS_ACCESS_ALLOWED_DOMAINS` は CMS 編集を許可するメールドメインをカンマ区切りで指定します。Cloudflare Access group でドメイン許可を使う場合、proxy 側にも同じドメインを設定します。

`CMS_ACCESS_HOSTNAMES` は必要に応じて preview hostname を追加するためのカンマ区切り allowlist です。既定で以下は許可されます。

- `hatt.acecore.net`
- `www.hatt.acecore.net`
- `homepage-hatt.pages.dev`
- `*.homepage-hatt.pages.dev`
- `localhost`
- `127.0.0.1`

## CMS で編集してよい範囲

- `src/content/blog/**`
- `src/content/art/**`
- `src/content/modeling/**`
- `src/content/tags/**`
- `src/content/authors/**`
- `src/content/site/main.json`
- `src/content/campaigns/**`
- `public/uploads/hatt/**`

proxy は上記の CMS 管理対象以外への write を拒否します。CMS 由来の PR で上記以外の差分が含まれる場合は、内容を確認してから merge してください。

`npm run validate:content` は CMS config が次の条件を満たすことも確認します。

- `backend.branch` が `main`
- `api_root` が `/admin/api/github`
- `graphql_api_root` が `/admin/api/graphql`
- `auth_methods` が `token`
- `include_credentials` が `true`
- legacy GitHub OAuth Worker を使っていない
- CMS に `path` field を露出しない
- CMS 管理対象が許可された content path に収まっている

## 残る制約

`CMS_GITHUB_TOKEN` は専用 bot または GitHub App 相当の専用 actor の token を使います。編集者個人の GitHub OAuth を保存 actor にしません。

Cloudflare Pages の本番設定では、Git Provider が有効、source repository が `acecore-systems/homepage-hatt`、production branch が `main`、custom domain が active であることを確認してください。
