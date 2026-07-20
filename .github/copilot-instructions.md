このリポジトリは Hatt の Astro 静的サイトで、Cloudflare Pages にデプロイされています。

変更前に `AGENTS.md` を確認してください。要点は次の通りです。

- GitHub 上のユーザー向け文章は、明示がない限り日本語で書く。
- PR タイトルと本文は日本語にし、関連 Issue、概要、確認、補足を簡潔に書く。
- 差分は目的に必要な範囲に絞り、既存の Astro、TypeScript、UnoCSS、Sveltia CMS 構成を尊重する。
- CMS content の shape は `src/content.config.ts` を正とし、横断制約は `npm run validate:content` で確認する。
- CMS 認証は Cherry 型とし、Cloudflare Access をログイン入口、Pages Functions の GitHub proxy を保存経路として扱う。
- Access は `hatt-cms-editors` 専用 group と完全一致メール allowlist に限定し、共有管理者 group やメールドメイン一括許可を CMS に流用しない。
- CMS proxy は `createCommitOnBranch` の画像とコンテンツを同じ commit/PR にまとめ、Sveltia CMS が必要とする GitHub API だけを許可する。
- サイト出力に影響する変更では `npm run build` を実行する。
- CMS/content/schema/route/link に関わる変更では `npm run format:check`、`npm run validate:content`、`npm run build` を確認する。
- CMS proxy に関わる変更では `npm run test:cms` と `npm run typecheck:functions` も確認する。
- docs/template のみなら対象ファイルの format check と `git diff --check` を行う。
