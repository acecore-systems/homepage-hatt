# CMS 書き込み branch 運用

最終更新日: 2026-07-10

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
5. Sveltia CMS が画像とコンテンツをまとめた `createCommitOnBranch` mutation を送る。
6. proxy が repository、base branch、変更 path、合計サイズを検証し、`cms/hatt/*` branch 上で mutation を組み立て直す。
7. proxy が画像とコンテンツを同じ commit に保存し、`main` 向け PR を開く。
8. PR CI が `npm run format:check`、`npm run validate:content`、`npm run test:cms`、`npm run typecheck:functions`、`npm run build` を実行する。
9. レビュー後、CMS PR を `main` に merge する。
10. Cloudflare Pages が GitHub `main` push を受けて production deploy する。

## Cloudflare Pages 設定

Cloudflare Pages の production と preview の両方に以下を設定します。

- Secret: `CMS_GITHUB_TOKEN`
- Optional Variable: `CMS_ACCESS_TEAM_DOMAIN=https://acecore.cloudflareaccess.com`
- Optional Variable: `CMS_ACCESS_AUD=044fc6624d4c84e5bcf78bc8a0ac1b505c9d2227cb6b1dba4dd6c4e10d4579d4`
- Secret または Variable: `CMS_ACCESS_ALLOWED_EMAILS`
- Secret または Variable: `CMS_ACCESS_ALLOWED_DOMAINS`
- Variable: `CMS_ACCESS_HOSTNAMES`

proxy は `Cf-Access-Jwt-Assertion` の署名、issuer、有効期限、audience を検証します。team domain と AUD tag は上記の値を既定値として持つため、Access application を作り直した場合だけ新しい値を環境変数へ設定してください。

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

## GitHub proxy の制限

- GraphQL read は Sveltia CMS が使う `repository` query のうち、default branch、commit history、CMS対象blobの本文だけを許可します。
- GraphQL write は `createCommitOnBranch` だけを受け付け、受信した query をそのまま転送せず、proxy が許可済みpathだけで mutationを組み立て直します。
- REST read は recursive tree とblob取得だけを許可します。treeからCMS管理対象外のpathとblob SHAを除外し、除外済みtreeにないblobは取得できません。
- 全API requestで Cloudflare Access JWT の署名、issuer、audience、有効期限を検証します。
- 1回の保存は最大100ファイル、追加データ合計25 MiBまでです。
- 保存前に `main` のHEADを再確認します。編集開始後に `main` が更新されていた場合は409を返し、CMSの再読み込みを求めます。

## 残る制約

`CMS_GITHUB_TOKEN` は専用 bot または GitHub App 相当の専用 actor の token を使います。編集者個人の GitHub OAuth を保存 actor にしません。

Cloudflare Pages の本番設定では、Git Provider が有効、source repository が `acecore-systems/homepage-hatt`、production branch が `main`、custom domain が active であることを確認してください。
