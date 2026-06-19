# CMS 書き込み branch 運用

最終確認日: 2026-06-19

## 現在の方針

- GitHub repository: `acecore-systems/homepage-hatt`
- GitHub default branch: `main`
- CMS backend: `public/admin/config.yml` の `backend.name: github`
- CMS OAuth backend: `https://sveltia-cms-auth.sparkling-tree-7cef.workers.dev`
- CMS publication branch: `main`
- CMS publish mode: `editorial_workflow`
- `main`: GitHub branch API 上の `protected` は `true`
- Branch protection: admin enforcement on、PR review on、required status checks は未設定
- GitHub ruleset: なし

`main` を本番ソースの唯一の正にします。Cloudflare Pages の production deploy 元も GitHub 連携の `main` にします。

Cloudflare Pages は次の状態を API で確認済みです。

- Project: `homepage-hatt`
- Git Provider: Yes (`source.type: github`)
- Source repository: `acecore-systems/homepage-hatt`
- Production branch: `main`
- Custom domain: `hatt.acecore.net` は `active`

CMS は `backend.branch: main` と `publish_mode: editorial_workflow` で運用します。これにより、CMS 保存は恒久的な投稿受け皿 branch ではなく、短命な CMS branch と PR として扱われます。

`cms-content` は恒久運用しません。既存 remote branch は、この変更が `main` に反映され、未反映差分や open PR がないことを確認してから削除候補にします。

## 現行フロー

1. Sveltia CMS が `main` を publication branch として読み込む。
2. CMS 保存時、editorial workflow が短命な CMS branch と PR を作る。
3. PR CI が `npm run format:check` と `npm run build` を実行する。
4. レビュー後、CMS PR を `main` に merge する。
5. Cloudflare Pages が GitHub `main` push を受けて production deploy する。

## CMS で編集してよい範囲

- `src/content/blog/**`
- `src/content/art/**`
- `src/content/modeling/**`
- `src/content/tags/**`
- `src/content/authors/**`
- `src/content/site/main.json`
- `src/content/campaigns/**`
- `public/uploads/hatt/**`

CMS 由来の PR で上記以外の差分が含まれる場合は、内容を確認してから merge してください。

## 残る制約

現在の Sveltia CMS は GitHub OAuth 経由で保存します。editorial workflow により `main` 直 commit は避けられますが、PR branch 作成の actor は編集者個人の GitHub 権限です。

編集者個人ではなく専用 bot / GitHub App / backend actor に完全移行したい場合は、CMS 保存を受ける backend を別途実装し、その backend が content-only PR を作る形にします。
