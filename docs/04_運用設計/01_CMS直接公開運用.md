# CMS直接公開運用

最終更新日: 2026-08-31

## 現在の方針

- GitHub repository: `acecore-systems/homepage-hatt`
- GitHub default branch: `main`
- CMS backend: `public/admin/config.yml` の `backend.name: github`
- CMS auth mode: Cherry 型（Cloudflare Access + Pages Functions GitHub proxy）
- CMS editor entitlement: `hatt-cms-editor`（AcecoreIDが正本）
- CMS publication branch: `main`
- CMS save mode: `expectedHeadOid` 付きの `main` 直接commit

`main` を本番ソースの唯一の正にします。Cloudflare Pages の production deploy 元も GitHub 連携の `main` にします。

`cms-content` のような恒久的な投稿受け皿branchや、保存ごとの短命branch・PRは使いません。CMS保存はPages Functions proxyが同期検証し、許可済みのコンテンツと画像だけを `main` の1 commitへ直接保存します。

## 現行フロー

1. `hatt-cms-editor` entitlementを持つ編集者がAcecoreIDでCloudflare Access経由の`/admin/`へログインする。
2. Access application policyがAcecoreIDの`https://acecore.net/claims/entitlements` OIDC claimを検証する。
3. Sveltia CMS が `/admin/api/session` で署名済みAccess JWTの同じclaimと認証済みメールを確認する。
4. Sveltia CMS が `/admin/api/github/*` と `/admin/api/graphql` を GitHub backend として使う。
5. Pages Functions proxy が専用 GitHub App の短期 installation token で GitHub API を呼び出す。
6. Sveltia CMS が画像とコンテンツをまとめた `createCommitOnBranch` mutation を送る。
7. proxy がrepository、branch、変更path、件数、合計サイズ、共有content schema、Markdown、raster media、現在の `main` HEADを同期検証し、許可済みpathだけでmutationを組み立て直す。保存直前に照合した正確な `main` commit SHAからCMS対象treeとtext blobを取得し、同じ保存の追加・削除を反映したprojected stateで全CMS contentを再検証する。記事のauthor・tagと `/uploads/hatt/` の画像参照は、同じ保存で追加される対象を含めて存在を確認する。author id、tag slug、記事の実効slugは共有形式制約を使い、tagと記事はprojected全体での一意性を確認する。PNGは全chunkのCRC、IHDR、連結IDATのzlib展開、scanline長とfilterを確認する。JPEG / GIF / WebP / AVIFはcontainer、marker、宣言length、終端の構造を確認し、ブラウザ相当の完全decodeまでは保証しない。各形式のblock数には上限を設け、極端な小block列を拒否する。
8. `expectedHeadOid` が現在のHEADと一致する場合だけ、画像とコンテンツを `main` の同じcommitへ原子的に保存する。
9. GitHub応答が失われた場合は固有operation marker、親SHA、変更path、blob SHA、削除後treeを照合し、成功済み保存の重複や誤った失敗扱いを避ける。
10. Cloudflare Pages がGitHub `main` pushを受けてproduction deployする。

## Cloudflare Pages 設定

Cloudflare Pages のproductionだけに以下のGitHub App設定を置きます。PR由来コードが動くpreviewへmain書込鍵を配布してはいけません。

- Variable: `CMS_GITHUB_APP_CLIENT_ID`
- Variable: `CMS_GITHUB_APP_INSTALLATION_ID`
- Secret: `CMS_GITHUB_APP_PRIVATE_KEY`（PKCS#8 PEM）

以下のAccess検証設定は必要なproduction / preview環境に設定できます。

- Optional Variable: `CMS_ACCESS_TEAM_DOMAIN=https://acecore.cloudflareaccess.com`
- Optional Variable: `CMS_ACCESS_AUD=044fc6624d4c84e5bcf78bc8a0ac1b505c9d2227cb6b1dba4dd6c4e10d4579d4`
- Variable: `CMS_ACCESS_HOSTNAMES`

proxy は `Cf-Access-Jwt-Assertion` の署名、issuer、有効期限、audienceに加え、`custom["https://acecore.net/claims/entitlements"]`に`hatt-cms-editor`があることを検証します。team domain と AUD tag は上記の値を既定値として持つため、Access application を作り直した場合だけ新しい値を環境変数へ設定してください。

CMSへログインできるユーザーはAcecoreID D1の`account_entitlements`で指定します。`hatt-cms-editor`には有効期限を持たせず、明示的に`revoked_at`を設定するまで有効です。Access group、完全一致メール、メールドメイン、`CMS_ACCESS_ALLOWED_EMAILS`はCMS権限の正本として使いません。

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

- `src/content/blog/*.md`
- `src/content/art/*.json`
- `src/content/modeling/*.json`
- `src/content/tags/*.json`
- `src/content/authors/*.json`
- `src/content/site/main.json`
- `src/content/campaigns/*.json`
- `public/uploads/hatt/**`

proxy は上記のCMS管理対象以外へのwriteを拒否します。content collectionは各folder直下のファイルだけを許可し、下位directoryはwrite・delete・reference state・read treeの全経路から除外します。mediaだけは `public/uploads/hatt/**` の下位directoryを利用できます。Functions、CMS設定、schema、workflow、AstroコンポーネントなどはCMSから変更できず、通常のbranch・PR・CIを通します。

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
- CMS text 1ファイルは最大448 KiBです。通常のCMS readが使うGitHub GraphQL `Blob.text`で省略されない範囲に固定し、追加時、現行state取得時、全content再検証時に同じ上限を適用します。
- 保存前とmutation実行時に `main` のHEADを `expectedHeadOid` で照合します。編集開始後または同時保存中にHEADが更新された場合は上書きせず409を返し、CMSの再読み込みを求めます。
- 参照整合性の検証は保存直前に照合した正確な `main` commit SHAへ束縛します。tree省略、blobの不正SHA・binary・truncated・byte size不一致、件数または合計size上限超過はfail closedします。
- projected stateでは現行treeへ同じmutationの追加・削除を適用してから、全CMS contentのschemaと記事author・tag・local media参照を再検証します。Markdownのlocal media参照はcodeを除外し、backslash escape、HTML entity、percent encoding、dot-segment traversalを正規化して確認します。
- author id、tag slug、記事の実効slugは `^[a-z0-9][a-z0-9_-]*$`、最大120文字に限定します。author idはJSON filenameとの一致も要求し、tagと記事のroute slugはprojected state全体で重複を拒否します。tagの `index` は `/blog/tag/` の静的一覧routeと衝突するため予約済みです。記事でfrontmatter `slug` を省略した場合は拡張子を除いたfilenameを同じ制約で検証します。
- mutationの応答が失われた場合は、固有operation marker、親commit、最新履歴を照合します。保存済みと確認できた場合だけ成功応答を再構成し、判定できない場合は再保存せず再読み込みするよう案内します。

## 残る制約

CMS保存actorは `acecore-systems/homepage-hatt` だけへインストールした専用 GitHub App を使います。Repository permissions は `Contents: Read and write` と `Metadata: Read-only` だけに限定します。GitHubから取得したPKCS#1秘密鍵はPKCS#8へ変換して `CMS_GITHUB_APP_PRIVATE_KEY` に保存し、編集者個人のGitHub OAuthや長期PATを保存actorにしません。

Cloudflare Pages の本番設定では、Git Provider が有効、source repository が `acecore-systems/homepage-hatt`、production branch が `main`、custom domain が active であることを確認してください。

CMS保存リクエストはCI完了を待ちません。公開後のGitHub Actionsは監視として継続できますが、失敗時の通知とロールバックは運用側で扱います。
