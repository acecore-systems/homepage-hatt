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
| ショップ     | Stripe Checkout + D1 + R2         |

## 開発

```bash
npm install
npm run dev
```

`npm run dev` の前に `/admin/runtime-config.js` が生成され、Sveltia CMS の編集対象 branch は通常 `main` になります。検証用に変えたい場合は `CMS_BACKEND_BRANCH` で明示します。

## ビルド

```bash
npm run build
npm run validate:content
```

`npm run build` は `astro build && pagefind --site dist` を実行します。

## CMS

- 管理画面: `/admin/index.html`
- 設定: `public/admin/config.yml`
- OAuth Worker: `workers/sveltia-cms-auth`
- 認証方式: GitHub 認証型。編集者は GitHub OAuth Worker 経由で保存し、Cloudflare Access を使う場合も前段の入口保護に限定します。
- ブログ、タグ、著者、モデリング項目、キャンペーン通知、サイト基本設定を編集できます。
- ブログ記事の `公開日` は日本時間の `YYYY-MM-DDTHH:mm` として扱います。
- 未来日時の記事カードと記事本文は HTML に残しつつ、訪問者のブラウザ時刻で表示を切り替えます。デプロイ後も時刻到達時に表示されます。

### 本番 CMS の保存と PR 反映

- 本番 CMS の publication branch は `main` です。`cms-content` のような恒久的な別本流 branch は使いません。
- `publish_mode: editorial_workflow` により、CMS の保存は短命な CMS branch と PR として作成されます。
- CMS 由来の PR は通常の PR と同じく review し、`.github/workflows/ci.yml` の `npm run format:check`、`npm run validate:content`、`npm run build` を通してから `main` に merge します。
- Cloudflare Pages の production deploy 元は GitHub 連携の `main` にします。
- 詳細は `docs/cms-write-workflow.md` を参照してください。
- 旧 remote `cms-content` branch は未反映差分がないことを確認して削除済みです。

## キャンペーン通知

`src/content/campaigns/*.json` を Sveltia CMS の「キャンペーン通知」から編集できます。

- `種別: トップ告知バナー` はサイト上部に表示されます。
- `種別: ページ内キャンペーン通知` は選択した表示位置に表示されます。
- `表示する`、`表示開始日時`、`表示終了日時` で公開期間を制御します。日時は日本時間として扱われ、デプロイ済みのページ上でも訪問者の表示時刻で自動的に切り替わります。

## ショップ

`/shop/` で絵・小説・3D作品・グッズを横断する商品カタログを表示します。BOOTH で公開中のエースコア商品は `products` に移し、サイト側のカートから Stripe Checkout に進む構成です。カートはブラウザの `localStorage` に `productId` と `quantity` だけを保存し、価格・在庫・受け渡し方法は `/api/shop/checkout` でサーバー側再検証します。

CMS では以下を編集できます。

- 商品: `src/content/products/*.json`
- ショップ設定: `src/content/shop-settings/main.json`

決済は `shop-settings/main.json` の `checkoutEnabled` が `true` で、販売者情報・返品・プライバシー・利用条件が埋まっている場合だけ開始できます。無料配布品は一覧に表示しますが、Stripe Checkout の対象外です。

Cloudflare Pages 側で以下を設定してください。

- D1 binding: `SHOP_DB` (`homepage-hatt-shop`)
- R2 binding: `SHOP_FILES` (`homepage-hatt-shop-files`)
- Secret: `STRIPE_SECRET_KEY`
- Secret: `STRIPE_WEBHOOK_SECRET`
- Secret: `SHOP_ADMIN_PASSWORD_HASH`
- Secret: `SHOP_ADMIN_SESSION_SECRET`
- Secret: `SHOP_DOWNLOAD_TOKEN_SECRET`

ショップ用 D1/R2 は Preview と Production で同じリソースを使います。D1 schema は `migrations/shop/0001_create_shop.sql` です。コメント用 D1 とは migration directory を分けています。

デジタル商品のファイルは非公開 R2 bucket の `r2ObjectKey` に配置します。購入完了後、`/api/shop/order` が短時間有効な download token を発行し、`/api/shop/download` が R2 object をストリーム返却します。BOOTH から移した有料商品の R2 key は `products/<slug>.zip` です。応援版は通常版と同じ内容物として同じ R2 object を参照します。

管理画面は `/shop/admin/` です。発送ステータス、追跡番号、手動納品メモ、返金・キャンセルメモを更新できます。

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
