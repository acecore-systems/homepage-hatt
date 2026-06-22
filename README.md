# Hattのホームページ

絵・小説・VRChat向け3Dアバター/ギミック制作を掲載する、Astro製の静的サイトです。

## 技術

| 使用箇所     | 使用技術                              |
| ------------ | ------------------------------------- |
| サイト生成   | Astro v6, TypeScript                  |
| CSS          | UnoCSS, custom CSS                    |
| CMS          | Sveltia CMS + Cloudflare Access proxy |
| 検索         | Pagefind                              |
| OGP          | satori + sharp                        |
| ホスティング | Cloudflare Pages                      |
| 広告         | Google AdSense                        |
| コメント     | Cloudflare Pages Functions + D1       |

## 開発

```bash
npm install
npm run dev
```

Sveltia CMS の編集対象 branch は `main` 固定です。CMS 保存は `/admin/api/*` の Pages Functions proxy が受け、短命な `cms/hatt/*` branch と PR として作成します。

## ビルド

```bash
npm run build
npm run validate:content
```

`npm run build` は `astro build && pagefind --site dist` を実行します。

## CMS

- 管理画面: `/admin/index.html`
- 設定: `public/admin/config.yml`
- GitHub proxy: `functions/admin/api/github/[[path]].ts`
- GraphQL proxy: `functions/admin/api/graphql.ts`
- Access session: `functions/admin/api/session.ts`
- 認証方式: Cherry 型。編集者は Cloudflare Access で `/admin/` に入り、保存は Cloudflare Pages の `CMS_GITHUB_TOKEN` を使う proxy が行います。
- ブログ、タグ、著者、モデリング項目、キャンペーン通知、サイト基本設定を編集できます。
- ブログ記事の `公開日` は日本時間の `YYYY-MM-DDTHH:mm` として扱います。
- 未来日時の記事カードと記事本文は HTML に残しつつ、訪問者のブラウザ時刻で表示を切り替えます。デプロイ後も時刻到達時に表示されます。

Cloudflare Pages 側で以下を設定してください。

- Secret: `CMS_GITHUB_TOKEN`
- Secret または Variable: `CMS_ACCESS_ALLOWED_EMAILS=editor@example.com,editor2@example.com`
- Secret または Variable: `CMS_ACCESS_ALLOWED_DOMAINS=acecore.net`
- Variable: `CMS_ACCESS_HOSTNAMES=hatt.acecore.net,www.hatt.acecore.net,homepage-hatt.pages.dev`

### 本番 CMS の保存と PR 反映

- 本番 CMS の publication branch は `main` です。`cms-content` のような恒久的な別本流 branch は使いません。
- CMS の保存は Pages Functions proxy により、短命な `cms/hatt/*` branch と PR として作成されます。
- CMS 由来の PR は通常の PR と同じく review し、`.github/workflows/ci.yml` の `npm run format:check`、`npm run validate:content`、`npm run build` を通してから `main` に merge します。
- Cloudflare Pages の production deploy 元は GitHub 連携の `main` にします。
- 詳細は `docs/cms-write-workflow.md` を参照してください。
- 旧 remote `cms-content` branch は未反映差分がないことを確認して削除済みです。

## キャンペーン通知

`src/content/campaigns/*.json` を Sveltia CMS の「キャンペーン通知」から編集できます。

- `種別: トップ告知バナー` はサイト上部に表示されます。
- `種別: ページ内キャンペーン通知` は選択した表示位置に表示されます。
- `表示する`、`表示開始日時`、`表示終了日時` で公開期間を制御します。日時は日本時間として扱われ、デプロイ済みのページ上でも訪問者の表示時刻で自動的に切り替わります。

## ブログコメント

記事ページのコメントは Cloudflare Pages Function + D1 + Turnstile で動きます。

Cloudflare Pages 側で以下を設定してください。

- D1 binding: `COMMENTS_DB`
- Secret: `TURNSTILE_SECRET_KEY`
- Secret: `COMMENT_HASH_SALT`
- Variable: `COMMENT_ALLOWED_HOSTNAMES=hatt.acecore.net,www.hatt.acecore.net,homepage-hatt.pages.dev`

D1 schema は `migrations/0001_create_blog_comments.sql` です。D1 database を作成後、同ファイルを適用してください。

Turnstile の公開 Site Key は CMS の「サイト設定」から `turnstileSiteKey` に設定します。

## モデル制作講座の無料体験申し込み

`/modeling-course/` から無料体験申し込みを受け付け、Cloudflare Email Sendingで通知メールを送信します。

Cloudflare Pages 側で以下を設定してください。

- Email Sending domain: 送信元ドメインをCloudflare Email Serviceにonboard
- Service binding: `COURSE_EMAIL_SERVICE` -> `homepage-hatt-course-email`
- Secret: `TURNSTILE_SECRET_KEY`
- Variable: `COURSE_SIGNUP_EMAIL_FROM=Hattのホームページ <noreply@hatt.acecore.net>`
- Variable: `COURSE_SIGNUP_EMAIL_TO=borubin@outlook.jp`

メールの本文には名前、連絡先、相談内容、希望日時が入ります。連絡先がメールアドレスの場合は返信先としても設定します。
