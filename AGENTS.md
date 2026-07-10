# Repository Guidelines

このリポジトリは Hatt の Astro 静的サイトです。AI エージェントや自動化ツールは、変更前にこのファイルを確認してください。

## 基本方針

- ユーザー指示、issue/PR 本文、チェックリストを受け入れ条件として扱い、このファイルより具体的な現在の指示を優先する。
- GitHub 上のユーザー向け文章（issue、pull request、コメント、レビュー返信、作業報告）は、明示がない限り日本語で書く。
- 既存の Astro、TypeScript、UnoCSS、Sveltia CMS、Cloudflare Pages 構成に合わせ、差分は目的に必要な範囲に絞る。
- 関連のない整形、リファクタリング、生成物更新を混ぜない。
- 既存の未コミット変更や別 branch の作業を戻さない。
- 失敗した検証、未実施の確認、外部要因による制約は隠さず報告する。

## CMS とコンテンツ

- CMS content の shape は `src/content.config.ts` の Astro Content Collections schema に合わせる。
- このリポジトリの CMS 認証は Cherry 型とし、Cloudflare Access をログイン入口、Pages Functions の GitHub proxy を保存経路にする。
- CMS backend の publication branch は `main` にし、Pages Functions proxy が `cms/hatt/*` の短命 branch と PR を作る。
- Sveltia CMS の保存は `createCommitOnBranch` で画像とコンテンツを同時に送る。proxy は許可済み path だけで mutation を組み立て直し、1回の保存を同じ commit と PR にまとめる。
- GitHub REST/GraphQL proxy は Sveltia CMS が必要とする read と write だけを許可し、`CMS_GITHUB_TOKEN` で任意の repository API を実行できる汎用 proxy にしない。
- `cms-content` のような恒久的な CMS 投稿受け皿 branch は使わない。
- CMS 変更は PR と CI を通して `main` に入れる。`main` への無検証直 push 前提の運用に戻さない。
- CMS 由来の PR で `src/content/**`、`public/uploads/hatt/**`、CMS 設定で明示した path 以外の差分が含まれる場合は、内容を確認してから merge する。
- CMS 保存用 token は Cloudflare Pages の `CMS_GITHUB_TOKEN` に設定し、編集者個人 OAuth を保存 actor にしない。
- GitHub proxy の書き込み可能 path は `src/content/**` と `public/uploads/hatt/**` の CMS 管理対象に限定する。

## 検証

- サイト出力に影響する変更では原則 `npm run build` を実行する。
- Markdown、JSON、YAML、Astro、TypeScript、CSS を変更した場合は `npm run format:check` を実行する。
- CMS/content/schema/route/link に関わる変更では `npm run validate:content` を実行する。
- CMS proxy に関わる変更では `npm run test:cms` と `npm run typecheck:functions` も実行する。
- コミット前に `git diff --check` を実行する。
- Windows sandbox で `spawn EPERM` が出た場合は、同じコマンドを権限付きで再実行して環境要因か切り分ける。

## PR 作成

- PR タイトルと本文は日本語で書き、`.github/pull_request_template.md` に沿って関連 Issue、概要、確認、補足を簡潔に書く。
- PR は draft で作成してよい。ユーザーが ready を求めた場合、または自動化タスクが ready for review を明示している場合だけ ready にする。
- 実行したコマンドは省略せず書く。実行していない検証は「未実施」と明記する。
