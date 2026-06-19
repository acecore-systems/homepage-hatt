このリポジトリは Hatt の Astro 静的サイトで、Cloudflare Pages にデプロイされています。

変更前に `AGENTS.md` を確認してください。要点は次の通りです。

- GitHub 上のユーザー向け文章は、明示がない限り日本語で書く。
- PR タイトルと本文は日本語にし、`.github/pull_request_template.md` に沿って書く。
- 差分は目的に必要な範囲に絞り、既存の Astro、TypeScript、UnoCSS、Sveltia CMS 構成を尊重する。
- CMS content の shape は `src/content.config.ts` を正とし、横断制約は `npm run validate:content` で確認する。
- サイト出力に影響する変更では `npm run build` を実行する。
- CMS/content/schema/route/link に関わる変更では `npm run format:check`、`npm run validate:content`、`npm run build` を確認する。
- docs/template のみなら対象ファイルの format check と `git diff --check` を行う。
