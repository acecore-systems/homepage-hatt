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

Sveltia CMS の編集対象 branch は `main` 固定です。CMS 保存は `/admin/api/*` の Pages Functions proxy が受け、許可済みの画像とコンテンツだけを `main` の同じ commit に直接保存します。

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
- ブログ、タグ、著者、モデリング項目、商品、商品ZIP、キャンペーン通知、サイト基本設定を編集できます。商品ZIPはCMS内から非公開R2へ保存します。
- ブログ記事の `公開日` は日本時間の `YYYY-MM-DDTHH:mm` として扱います。
- 未来日時の記事カードと記事本文は HTML に残しつつ、訪問者のブラウザ時刻で表示を切り替えます。デプロイ後も時刻到達時に表示されます。

Cloudflare Pages のproductionだけに以下のGitHub App設定を置いてください。previewへmain書込鍵を配布してはいけません。

- Variable: `CMS_GITHUB_APP_CLIENT_ID`
- Variable: `CMS_GITHUB_APP_INSTALLATION_ID`
- Secret: `CMS_GITHUB_APP_PRIVATE_KEY`（PKCS#8 PEM）

Access検証設定は必要なproduction / preview環境に設定できます。

- Optional Variable: `CMS_ACCESS_TEAM_DOMAIN=https://acecore.cloudflareaccess.com`
- Optional Variable: `CMS_ACCESS_AUD=044fc6624d4c84e5bcf78bc8a0ac1b505c9d2227cb6b1dba4dd6c4e10d4579d4`
- Secret または Variable: `CMS_ACCESS_ALLOWED_EMAILS=editor@example.com`
- Variable: `CMS_ACCESS_HOSTNAMES=hatt.acecore.net,www.hatt.acecore.net,homepage-hatt.pages.dev`

`CMS_ACCESS_ALLOWED_EMAILS` は `hatt-cms-editors` と同じ完全一致メールだけを production / preview の両方へ設定します。他サイト編集者、共有管理者、メールドメイン一括許可は追加しません。

`CMS_ACCESS_TEAM_DOMAIN` と `CMS_ACCESS_AUD` は上記の値を既定値として持ちます。Access application を作り直した場合だけ、新しい値で上書きしてください。

GitHub App は `acecore-systems/homepage-hatt` だけへインストールし、Repository permissions は `Contents: Read and write`、`Metadata: Read-only` にします。proxy は秘密鍵で9分以内のApp JWTを署名し、repositoryと権限を再指定した1時間以内のinstallation tokenを発行します。

GitHub App を新規作成または置換するときは `npm run setup:cms-app` を実行します。セットアップ画面では `homepage-hatt` だけを選択してください。補助スクリプトはAppの所有者、権限、対象repositoryが1件だけであることを検証し、秘密鍵をファイルへ保存せず、productionだけへ必要な3 secretを登録します。preview FunctionsはGitHub App設定不足で書込みをfail closedします。

### 本番 CMS の保存と公開

- 本番 CMS の publication branch は `main` です。`cms-content` のような恒久的な別本流 branch は使いません。
- CMS の保存は Pages Functions proxy が共有content schema、Markdown、raster mediaを同期検証し、許可済みの画像とコンテンツを `main` の同じcommitへ直接保存します。保存直前に照合した正確な `main` commit SHAからCMS対象を読み、同じ保存の追加・削除を反映したprojected stateで全contentを再検証します。記事のauthor・tagと `/uploads/hatt/` の画像参照は同じ保存で追加する対象を含めて存在確認し、欠損参照はGitHub送信前に拒否します。
- CMS textはGitHub GraphQL readで本文が省略されない448 KiB以下に限定します。author id、tag slug、記事の実効slug（frontmatter `slug`、未指定時はfilename）へ共有route形式制約を適用し、tagと記事はprojected state全体で一意性も確認します。tagの `index` は静的一覧routeとの衝突を避けるため予約済みです。
- CMS content collectionは各folder直下のファイルだけを許可し、下位directoryへは保存・削除・readできません。`public/uploads/hatt/**` のmediaだけは下位directoryを利用できます。
- PNGは全chunkのCRC、IHDR、連結IDATのzlib展開、scanline長とfilterを確認し、JPEG / GIF / WebP / AVIFはcontainer、marker、宣言length、終端の構造を確認します。各形式のchunk、marker、sub-block、box数には上限を設け、極端な小block列を拒否します。`expectedHeadOid` が現在のHEADと一致しない場合は上書きせず、再読み込みを求めます。
- 必須 `src/content/site/main.json`、author、tagと、コンテンツから参照され得る `public/uploads/hatt/**` はCMSから削除できません。
- 保存後はGitHub連携のCloudflare Pagesがproduction deployを開始します。CIや手動mergeの完了をCMS保存リクエスト内で待ちません。
- Functions、CMS設定、schema、workflow、サイトコードなどの変更は通常のbranch・PR・CIを通します。CMS用GitHub Appはこれらのpathへ書き込めません。
- `main` のrepository rulesetでは通常のPR・CI要件を維持し、repository限定の `Acecore Hatt CMS` Appだけをbypass actorに指定します。
- Cloudflare Pages の production deploy 元は GitHub 連携の `main` にします。
- 詳細は [CMS直接公開運用](docs/04_運用設計/01_CMS直接公開運用.md) を参照してください。

設計文書の入口は [docs/README.md](docs/README.md) です。

### CMS AI修正依頼

管理画面の「AIに依頼」から、Hattの管理対象URL・修正内容・AIの考える深さを送れます。考える深さは `low` / `medium` / `high` から依頼ごとに選択でき、既定は `medium` です。画像の入力・生成機能は含みません。

依頼はCloudflare Accessで認証した編集者とともにD1へ保存します。GitHub Appが repository_dispatch を送ると、CMS AI Automation workflowがGitHub Actions OIDC tokenで、Access配下から分離したOIDC専用の `/api/cms-ai/runner` Pages Functionへ認証します。Workers AIの `@cf/zai-org/glm-5.3` は選択された `reasoning_effort` で変更案だけを返し、workflowが許可範囲のファイルを別branchへ書き込み、ローカル検証・PR作成・CIを行います。

- AIが変更できるのは src/、public/（public/admin/ と public/uploads/ を除く）、docs/ のテキストだけです。
- 認証、CMS管理API、決済、テスト、依存関係、migration、workflow、Cloudflare設定は自動変更の対象外です。
- CMS_AI_AUTOMERGE_ENABLED=false が既定です。まず本番相当の1件でWorkers AI・D1 migration・GitHub Actions OIDC・CI・Pages GitHub連携を確認し、問題がなければproductionの同変数を true へ変更すると、CI成功後にsquash mergeまで自動化します。
- CMS_AI_DB は既存の homepage-hatt-comments D1を利用します。`migrations/0002_create_cms_ai_jobs.sql` と `migrations/0003_add_cms_ai_reasoning_effort.sql` を順にD1へ適用してください。
- Workers AI binding AI をPagesへ追加します。`@cf/zai-org/glm-5.3` の利用にはWorkers Paidまたはprepaid AI Gateway creditsが必要です。

GitHub Actionsは変更を作る前に、OIDC tokenのissuer・audience・repository・repository_dispatch event・refs/heads/main を検証します。PagesやGitHubの設定を変更しただけでは本番反映済みとは扱わず、GitHub連携のmain deployとカスタムドメインを実機で確認してください。

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

決済は `shop-settings/main.json` の `checkoutEnabled` が `true` で、販売者情報・返品・プライバシー・利用条件が埋まっている場合だけ開始できます。所在地は公開掲載のほか、請求時開示を選べます。請求時開示ではCMSのURL・プロファイル版、CloudflareのSecret、D1 migrationがすべて揃わない限り、Pages Functionがcheckoutを停止します。無料配布品は一覧に表示しますが、Stripe Checkout の対象外です。

Cloudflare Pages 側で以下を設定してください。

- D1 binding: `SHOP_DB` (`homepage-hatt-shop`)
- R2 binding: `SHOP_FILES` (`homepage-hatt-shop-files`)
- Secret: `STRIPE_SECRET_KEY`
- Secret: `STRIPE_WEBHOOK_SECRET`
- Secret: `SHOP_DOWNLOAD_TOKEN_SECRET`
- Variable: `SHOP_DISCLOSURE_ENABLED=true`（所在地の請求時開示を有効化するProduction環境だけ）
- Variable: `SHOP_DISCLOSURE_TURNSTILE_SITE_KEY`（サイト設定のTurnstile公開Site Keyと同じ値）
- Optional variable: `SHOP_DISCLOSURE_ALLOWED_HOSTNAMES`（既定値は`hatt.acecore.net,www.hatt.acecore.net`）
- Secret: `SHOP_DISCLOSURE_HMAC_SECRET`（ランダムな32文字以上の値）
- Secret: `SHOP_DISCLOSURE_SERVICE_TOKEN`（専用Workerの`DISCLOSURE_SERVICE_TOKEN`と同じランダムな32文字以上の値）
- Service binding: `DISCLOSURE_EMAIL_SERVICE` -> `homepage-hatt-disclosure-email`
- Variable: `SHOP_CONTACT_EMAIL_FROM=Hatt shop <noreply@hatt.acecore.net>`
- Variable: `SHOP_CONTACT_EMAIL_TO=borubin@outlook.jp`
- Service binding: `COURSE_EMAIL_SERVICE` -> `homepage-hatt-course-email`
- Variable: `SHOP_ACCESS_TEAM_DOMAIN=https://acecore.cloudflareaccess.com`
- Variable: `SHOP_ACCESS_AUD=12faf91ff5d66812272272ec869557e4367f7f0a48cb1447f37e4b9e34de9e84`
- Variable: `SHOP_ACCESS_HOSTNAMES=hatt.acecore.net,www.hatt.acecore.net,homepage-hatt.pages.dev,*.homepage-hatt.pages.dev`

Cloudflare Pages の Secret や binding を更新した後は、GitHub連携の `main` デプロイを完了してから本番で確認します。Direct Upload での反映は行いません。
`SHOP_DISCLOSURE_SERVICE_TOKEN` は Pages と専用Workerで同じ値にし、更新時は両方を同じ操作で更新します。

ショップ用 D1/R2 は Preview と Production で同じリソースを使います。D1 schema は `migrations/shop/0001_create_shop.sql` から順に適用します。請求時開示には `migrations/shop/0002_add_seller_disclosure_requests.sql` が必要です。コメント用 D1 とは migration directory を分けています。

所在地を請求時開示にする場合は、CMSで`所在地の表示方法`を`請求時にメールで開示する`にして、`所在地の開示請求URL`を`/shop/legal/disclosure-request/`、`所在地開示プロファイル版`を例えば`v1`に設定します。実住所はPages・CMS・Git・`wrangler.jsonc`に保存せず、専用WorkerのSecretだけに保存します。Workerは公開済みの事業者名、販売責任者、電話番号、プロファイル版と完全に一致しない限り、メールを送信しません。

専用Workerには`DISCLOSURE_SERVICE_TOKEN`と、次の形式の`DISCLOSURE_LEGAL_DETAILS_JSON`をSecretとして設定します。`workers.dev` URLは無効にし、Pagesからの`DISCLOSURE_EMAIL_SERVICE`だけを受け付けます。

```json
{
  "version": 1,
  "profileVersion": "v1",
  "businessName": "公開済みの事業者名",
  "sellerName": "公開済みの販売責任者名",
  "address": "実住所",
  "phone": "公開済みの電話番号"
}
```

開示請求は`/shop/legal/disclosure-request/`で受け付けます。メールアドレスとIPアドレスは平文保存せずHMAC化した識別子だけをD1へ記録し、送信状態とともに90日後に削除します。専用フォームは本番カスタムドメインでのみ有効にし、Previewでは問い合わせ窓口へフォールバックします。

デジタル商品のファイルは非公開 R2 bucket の `r2ObjectKey` に配置します。購入完了後、`/api/shop/order` が短時間有効な download token を発行し、`/api/shop/download` が R2 object をストリーム返却します。BOOTH から移した有料商品の R2 key は `products/<slug>.zip` です。応援版は通常版と同じ内容物として同じ R2 object を参照します。

注文管理画面は `/shop/admin/` です。Cloudflare Access application `Hatt shop admin` が画面と `/api/shop/admin/*` の両方を保護し、Pages Functions でも Access JWT の署名・発行元・audience を再検証します。Allow policy は `default-admin` と `hatt-cms-editors` group を参照します。発送ステータス、追跡番号、手動納品メモ、返金・キャンセルメモを更新でき、更新者の Access メールを監査ログに記録します。商品ZIPの一覧・アップロード・ダウンロードはCMS内から `/admin/api/product-files` を利用し、CMSのAccess audienceと編集者allowlistで保護します。

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
