# Hattのホームページ

絵・小説・VRChat向け3Dアバター/ギミック制作を掲載する、Astro製の静的サイトです。

## 技術

| 使用箇所     | 使用技術                          |
| ------------ | --------------------------------- |
| サイト生成   | Astro v6, TypeScript              |
| CSS          | UnoCSS, custom CSS                |
| CMS          | Sveltia CMS + GitHub OAuth Worker |
| 検索         | Pagefind                          |
| OGP          | satori + sharp                    |
| ホスティング | Cloudflare Pages                  |
| 広告         | Google AdSense                    |
| コメント     | Cloudflare Pages Functions + D1   |

## 開発

```bash
npm install
npm run dev
```

`npm run dev` の前に `/admin/runtime-config.js` が生成され、Sveltia CMS の編集対象 branch が実行環境に合わせて切り替わります。

## ビルド

```bash
npm run build
```

`npm run build` は `astro build && pagefind --site dist` を実行します。

## CMS

- 管理画面: `/admin/index.html`
- 設定: `public/admin/config.yml`
- OAuth Worker: `workers/sveltia-cms-auth`
- ブログ、タグ、著者、モデリング項目、キャンペーン通知、サイト基本設定を編集できます。
- ブログ記事の `公開日` は日本時間の `YYYY-MM-DDTHH:mm` として扱います。
- 未来日時の記事カードと記事本文は HTML に残しつつ、訪問者のブラウザ時刻で表示を切り替えます。デプロイ後も時刻到達時に表示されます。

### 本番 CMS の保存と PR 反映

- 本番 CMS の保存先は `cms-content` ブランチです。`main` は protected branch のため、CMS から直接 commit しません。
- `cms-content` に保存されると `.github/workflows/cms-content-pr.yml` が `main` 向けの「CMS編集内容を反映」PRを作成します。既に open PR がある場合は二重作成しません。
- 初回セットアップやブランチ再作成が必要な場合は、`main` の最新状態から `git fetch origin main`、`git push origin origin/main:refs/heads/cms-content` で `cms-content` を用意します。
- CMS PR を merge した後は、CMS の次回保存で workflow が動くように `cms-content` ブランチも merge 後の `main` へ fast-forward してください。
- GitHub Actions の `GITHUB_TOKEN` で PR 作成が許可されていない環境では、Repository settings の Actions 権限を見直すか、PR 作成権限を持つ `CMS_PR_TOKEN` secret を設定します。

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
- Variable: `COURSE_SIGNUP_EMAIL_TO=info@acecore.net`

メールの本文には名前、連絡先、相談内容、希望日時が入ります。連絡先がメールアドレスの場合は返信先としても設定します。
