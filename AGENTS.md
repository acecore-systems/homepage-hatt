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
- CMSへログインできるユーザーはAcecoreIDの永続entitlement `hatt-cms-editor`だけで指定する。AcecoreIDは`https://acecore.net/claims/entitlements` OIDC claimへ現在のentitlementを載せ、Access application policyとPages Functionsは同じ署名済みclaimを検証する。Access group、メール完全一致・ドメイン一括allowlist、`CMS_ACCESS_ALLOWED_EMAILS`を権限元にしない。
- CMS backend の publication branch は `main` にし、Pages Functions proxy が CMS 管理対象だけを `main` の1 commitへ直接保存する。
- Sveltia CMS の保存は `createCommitOnBranch` で画像とコンテンツを同時に送る。proxy は許可済み path だけで mutation を組み立て直し、`expectedHeadOid` が現在の `main` と一致するときだけ同じ commit にまとめる。
- GitHub REST/GraphQL proxy は Sveltia CMS が必要とする read と write だけを許可し、GitHub App installation token で任意の repository API を実行できる汎用 proxy にしない。
- `cms-content` のような恒久的な CMS 投稿受け皿 branch は使わない。
- CMS画面からのコンテンツ・画像保存だけは同期allowlist検証後に `main` へ直接入れ、Cloudflare Pagesの公開を開始する。CIやレビューの完了を保存リクエスト内で待たない。
- Functions、CMS設定、schema、workflow、サイトコードなどの変更は従来どおりbranch・PR・CIを通し、CMS用GitHub Appからは書き込ませない。
- CMS 保存は repository 限定の GitHub App installation token を短期発行し、編集者個人 OAuth を保存 actor にしない。
- GitHub proxy の書き込み可能 path はCMS設定にある各 `src/content/<collection>/*` の直下ファイルと `public/uploads/hatt/**` に限定する。content collectionの下位directoryはwrite・delete・reference state・readの全経路で拒否し、mediaの下位directoryだけを許可する。
- CMS保存前は、照合済みの正確な `main` commit SHAから現行stateを取得し、同じmutationの追加・削除を適用したprojected stateで全CMS content、author・tag、local media参照を再検証する。可変のbranch名から参照stateを取得しない。
- CMS textは448 KiB以下、author id・tag slug・blog effective slugは共有slug制約を使い、tag/blogはprojected全体で一意とする。画像parserのchunk、marker、sub-block、box数上限を外さない。

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
