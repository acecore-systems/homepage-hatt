# CMS 直接公開フロー

最終更新日: 2026-07-28

## 現在の方針

- GitHub repository: `acecore-systems/homepage-hatt`
- GitHub default branch: `main`
- CMS backend: `public/admin/config.yml` の `backend.name: github`
- CMS auth mode: Cherry 型（Cloudflare Access + Pages Functions GitHub proxy）
- CMS Access group: `hatt-cms-editors`（このサイトの編集者だけ）
- CMS publication branch: `main`
- CMS save mode: `expectedHeadOid` 付きの `main` 直接commit

`main` を本番ソースの唯一の正にします。Cloudflare Pages の production deploy 元も GitHub 連携の `main` にします。

`cms-content` のような恒久的な投稿受け皿branchや、保存ごとの短命branch・PRは使いません。CMS保存はPages Functions proxyが同期検証し、許可済みのコンテンツと画像だけを `main` の1 commitへ直接保存します。

## 現行フロー

1. 編集者が Cloudflare Access 経由で `/admin/` にログインする。
2. Sveltia CMS が `/admin/api/session` で Access 認証済みメールを確認する。
3. Sveltia CMS が `/admin/api/github/*` と `/admin/api/graphql` を GitHub backend として使う。
4. Pages Functions proxy が専用 GitHub App の短期 installation token で GitHub API を呼び出す。
5. Sveltia CMS が画像とコンテンツをまとめた `createCommitOnBranch` mutation を送る。
6. proxy がrepository、branch、変更path、件数、合計サイズ、共有content schema、Markdown、raster media、現在の `main` HEADを同期検証し、許可済みpathだけでmutationを組み立て直す。
7. `expectedHeadOid` が現在のHEADと一致する場合だけ、画像とコンテンツを `main` の同じcommitへ原子的に保存する。
8. GitHub応答が失われた場合は固有operation marker、親SHA、変更path、blob SHA、削除後treeを照合し、成功済み保存の重複や誤った失敗扱いを避ける。
9. Cloudflare Pages がGitHub `main` pushを受けてproduction deployする。

## Cloudflare Pages 設定

Cloudflare Pages のproductionだけに以下のGitHub App設定を置きます。PR由来コードが動くpreviewへmain書込鍵を配布してはいけません。

- Variable: `CMS_GITHUB_APP_CLIENT_ID`
- Variable: `CMS_GITHUB_APP_INSTALLATION_ID`
- Secret: `CMS_GITHUB_APP_PRIVATE_KEY`（PKCS#8 PEM）

以下のAccess検証設定は必要なproduction / preview環境に設定できます。

- Optional Variable: `CMS_ACCESS_TEAM_DOMAIN=https://acecore.cloudflareaccess.com`
- Optional Variable: `CMS_ACCESS_AUD=044fc6624d4c84e5bcf78bc8a0ac1b505c9d2227cb6b1dba4dd6c4e10d4579d4`
- Secret または Variable: `CMS_ACCESS_ALLOWED_EMAILS`（`hatt-cms-editors` と同じ完全一致メール）
- Variable: `CMS_ACCESS_HOSTNAMES`

proxy は `Cf-Access-Jwt-Assertion` の署名、issuer、有効期限、audience を検証します。team domain と AUD tag は上記の値を既定値として持つため、Access application を作り直した場合だけ新しい値を環境変数へ設定してください。

`CMS_ACCESS_ALLOWED_EMAILS` は CMS 編集を許可する完全一致メールを指定します。Access application は `hatt-cms-editors` だけを許可し、共有 `default-admin` group、他サイトの編集者、メールドメイン一括許可を使いません。Access group と Pages Functions の allowlist の両方が一致したユーザーだけが CMS API を利用できます。

`CMS_ACCESS_HOSTNAMES` は必要に応じて preview hostname を追加するためのカンマ区切り allowlist です。既定で以下は許可されます。

- `hatt.acecore.net`
- `www.hatt.acecore.net`
- `homepage-hatt.pages.dev`
- `*.homepage-hatt.pages.dev`
- `localhost`
- `127.0.0.1`

## GitHub App のセットアップ

初回作成またはApp置換時は、依存関係を導入したうえで次を実行します。

```bash
npm ci
npm run setup:cms-app
```

GitHubではApp名が `Acecore Hatt CMS`、インストール先が `acecore-systems`、Repository accessが `Only select repositories: homepage-hatt`、Repository permissionsが `Contents: Read and write` と `Metadata: Read-only` だけであることを確認します。補助スクリプトは所有者、最小権限、対象repositoryが1件だけであることをGitHub APIで再検証し、PKCS#8秘密鍵をディスクへ保存せず、Cloudflare Pagesのproductionだけへ `CMS_GITHUB_APP_CLIENT_ID`、`CMS_GITHUB_APP_INSTALLATION_ID`、`CMS_GITHUB_APP_PRIVATE_KEY` を登録します。previewではApp設定不足により書込みをfail closedします。

`main` を対象にするrepository rulesetでは、通常の開発者に対するPR・CI要件を維持しながら、repository限定の `Acecore Hatt CMS` Appだけをbypass actorとして `Always allow` にします。CMS App以外のactorへbypassを付与しません。

## CMS で編集してよい範囲

- `src/content/blog/**`
- `src/content/art/**`
- `src/content/modeling/**`
- `src/content/tags/**`
- `src/content/authors/**`
- `src/content/site/main.json`
- `src/content/campaigns/**`
- `public/uploads/hatt/**`

proxy は上記のCMS管理対象以外へのwriteを拒否します。Functions、CMS設定、schema、workflow、AstroコンポーネントなどはCMSから変更できず、通常のbranch・PR・CIを通します。

必須 `src/content/site/main.json`、author、tagは削除を拒否します。コンテンツから参照され得る `public/uploads/hatt/**` も参照切れを防ぐため削除を拒否し、差し替え時は新しいraster画像の追加だけを許可します。

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
- GraphQL write は `createCommitOnBranch` だけを受け付け、受信したqueryをそのまま転送せず、proxyが許可済みpathと `main` だけでmutationを組み立て直します。
- REST read は recursive tree とblob取得だけを許可します。treeからCMS管理対象外のpathとblob SHAを除外し、除外済みtreeにないblobは取得できません。
- 全API requestで Cloudflare Access JWT の署名、issuer、audience、有効期限を検証します。
- 1回の保存は最大100ファイル、追加データ合計25 MiBまでです。
- 保存前とmutation実行時に `main` のHEADを `expectedHeadOid` で照合します。編集開始後または同時保存中にHEADが更新された場合は上書きせず409を返し、CMSの再読み込みを求めます。
- mutationの応答が失われた場合は、固有operation marker、親commit、最新履歴を照合します。保存済みと確認できた場合だけ成功応答を再構成し、判定できない場合は再保存せず再読み込みするよう案内します。

## 残る制約

CMS保存actorは `acecore-systems/homepage-hatt` だけへインストールした専用 GitHub App を使います。Repository permissions は `Contents: Read and write` と `Metadata: Read-only` だけに限定します。GitHubから取得したPKCS#1秘密鍵はPKCS#8へ変換して `CMS_GITHUB_APP_PRIVATE_KEY` に保存し、編集者個人のGitHub OAuthや長期PATを保存actorにしません。

Cloudflare Pages の本番設定では、Git Provider が有効、source repository が `acecore-systems/homepage-hatt`、production branch が `main`、custom domain が active であることを確認してください。

CMS保存リクエストはCI完了を待ちません。公開後のGitHub Actionsは監視として継続できますが、失敗時の通知とロールバックは運用側で扱います。
