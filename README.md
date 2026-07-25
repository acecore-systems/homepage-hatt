# Hattのホームページ

絵・小説・VRChat向け3Dアバター/ギミック制作を掲載する、Astro製の静的サイトです。

## 技術

| 使用箇所     | 使用技術                              |
| ------------ | ------------------------------------- |
| サイト生成   | Astro v7, TypeScript                  |
| CSS          | UnoCSS, custom CSS                    |
| CMS          | Sveltia CMS + Cloudflare Access proxy |
| 検索         | Pagefind                              |
| OGP          | satori + sharp                        |
| ホスティング | Cloudflare Pages                      |
| 広告         | Google AdSense                        |
| コメント     | Cloudflare Pages Functions + D1       |
| ショップ     | Stripe Checkout + D1 + R2             |

## 開発

Node.js 24.18.0 以上を使用してください。リポジトリの固定バージョンは `.node-version` に記載しています。

```bash
npm install
npm run dev
```

Sveltia CMS の編集対象 branch は `main` 固定です。CMS 保存は `/admin/api/*` の Pages Functions proxy が受け、画像とコンテンツを同じ commit にまとめた短命な `cms/hatt/*` branch と PR として作成します。

## ビルド

```bash
npm run build
npm run validate:content
npm run test:cms
npm run typecheck:functions
```

`npm run build` は `astro build && node scripts/audit-image-alts.mjs && pagefind --site dist` を実行し、画像の代替テキストを監査してから検索インデックスを生成します。

## CMS

- 管理画面: `/admin/index.html`
- 設定: `public/admin/config.yml`
- GitHub proxy: `functions/admin/api/github/[[path]].ts`
- GraphQL proxy: `functions/admin/api/graphql.ts`
- Access session: `functions/admin/api/session.ts`
- 認証方式: Cherry 型。編集者は Cloudflare Access で `/admin/` に入り、保存は専用 GitHub App の短期 installation token を使う proxy が行います。
- Access application の Allow policy はサイト専用の `hatt-cms-editors` group だけを参照します。共有管理者 group やメールドメイン一括許可は使いません。
- ブログ、タグ、著者、モデリング項目、キャンペーン通知、サイト基本設定を編集できます。
- ブログ記事の `公開日` は日本時間の `YYYY-MM-DDTHH:mm` として扱います。
- 未来日時の記事カードと記事本文は HTML に残しつつ、訪問者のブラウザ時刻で表示を切り替えます。デプロイ後も時刻到達時に表示されます。

Cloudflare Pages 側で以下を設定してください。

- Variable: `CMS_GITHUB_APP_CLIENT_ID`
- Variable: `CMS_GITHUB_APP_INSTALLATION_ID`
- Secret: `CMS_GITHUB_APP_PRIVATE_KEY`（PKCS#8 PEM）
- Optional Variable: `CMS_ACCESS_TEAM_DOMAIN=https://acecore.cloudflareaccess.com`
- Optional Variable: `CMS_ACCESS_AUD=044fc6624d4c84e5bcf78bc8a0ac1b505c9d2227cb6b1dba4dd6c4e10d4579d4`
- Secret または Variable: `CMS_ACCESS_ALLOWED_EMAILS=editor@example.com`
- Variable: `CMS_ACCESS_HOSTNAMES=hatt.acecore.net,www.hatt.acecore.net,homepage-hatt.pages.dev`

`CMS_ACCESS_ALLOWED_EMAILS` は `hatt-cms-editors` と同じ完全一致メールだけを production / preview の両方へ設定します。他サイト編集者、共有管理者、メールドメイン一括許可は追加しません。

`CMS_ACCESS_TEAM_DOMAIN` と `CMS_ACCESS_AUD` は上記の値を既定値として持ちます。Access application を作り直した場合だけ、新しい値で上書きしてください。

GitHub App は `acecore-systems/homepage-hatt` だけへインストールし、Repository permissions は `Contents: Read and write`、`Pull requests: Read and write`、`Metadata: Read-only` にします。proxy は秘密鍵で9分以内のApp JWTを署名し、repositoryと権限を再指定した1時間以内のinstallation tokenを発行します。

GitHub App を新規作成または置換するときは `npm run setup:cms-app` を実行します。セットアップ画面では `homepage-hatt` だけを選択してください。補助スクリプトはAppの所有者、権限、対象repositoryが1件だけであることを検証し、秘密鍵をファイルへ保存せず、production / preview の両方へ必要な3 secretを登録します。

### 本番 CMS の保存と PR 反映

- 本番 CMS の publication branch は `main` です。`cms-content` のような恒久的な別本流 branch は使いません。
- CMS の保存は Pages Functions proxy により、画像とコンテンツを同じ commit に含む短命な `cms/hatt/*` branch と PR として作成されます。
- CMS 由来の PR は通常の PR と同じく review し、`.github/workflows/ci.yml` の `npm run format:check`、`npm run validate:content`、`npm run test:cms`、`npm run typecheck:functions`、`npm run build` を通してから `main` に merge します。
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
- Secret: `SHOP_DOWNLOAD_TOKEN_SECRET`
- Variable: `SHOP_CONTACT_EMAIL_FROM=Hatt shop <noreply@hatt.acecore.net>`
- Variable: `SHOP_CONTACT_EMAIL_TO=borubin@outlook.jp`
- Service binding: `COURSE_EMAIL_SERVICE` -> `homepage-hatt-course-email`
- Variable: `SHOP_ACCESS_TEAM_DOMAIN=https://acecore.cloudflareaccess.com`
- Variable: `SHOP_ACCESS_AUD=12faf91ff5d66812272272ec869557e4367f7f0a48cb1447f37e4b9e34de9e84`
- Variable: `SHOP_ACCESS_HOSTNAMES=hatt.acecore.net,www.hatt.acecore.net,homepage-hatt.pages.dev,*.homepage-hatt.pages.dev`

ショップ用 D1/R2 は Preview と Production で同じリソースを使います。D1 schema は `migrations/shop/0001_create_shop.sql` です。コメント用 D1 とは migration directory を分けています。

デジタル商品のファイルは非公開 R2 bucket の `r2ObjectKey` に配置します。購入完了後、`/api/shop/order` が短時間有効な download token を発行し、`/api/shop/download` が R2 object をストリーム返却します。BOOTH から移した有料商品の R2 key は `products/<slug>.zip` です。応援版は通常版と同じ内容物として同じ R2 object を参照します。

管理画面は `/shop/admin/` です。Cloudflare Access application `Hatt shop admin` が画面と `/api/shop/admin/*` の両方を保護し、Pages Functions でも Access JWT の署名・発行元・audience を再検証します。Allow policy は `default-admin` と `hatt-cms-editors` group を参照します。発送ステータス、追跡番号、手動納品メモ、返金・キャンセルメモを更新でき、更新者の Access メールを監査ログに記録します。

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
