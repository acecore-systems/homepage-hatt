# Seller disclosure email service

販売者情報の請求時開示だけを処理する内部Cloudflare Workerです。実住所を
Cloudflare Pages FunctionやCMSへ渡さず、このWorkerがSecrets Storeから取得してメール本文を
作成します。

`workers.dev` URLは無効で、Pagesの`DISCLOSURE_EMAIL_SERVICE` service binding
から、共有の`DISCLOSURE_SERVICE_TOKEN`を使って呼び出します。

## Required configuration

- Store binding: `DISCLOSURE_SERVICE_TOKEN_STORE` -> `homepage-hatt-production-disclosure-token`
- Store binding: `DISCLOSURE_LEGAL_DETAILS_JSON_STORE` -> `homepage-hatt-production-disclosure-legal-details`
- 本番の旧Worker Secret 2項目は不要です。`secrets.required` は空にし、再配信時も旧コピーを投入しません。
- Worker variable: `DISCLOSURE_FROM_ADDRESS=noreply@hatt.acecore.net`
- Pages Secret: `SHOP_DISCLOSURE_SERVICE_TOKEN`（Workerと同じ値）
- Pages service binding: `DISCLOSURE_EMAIL_SERVICE` -> `homepage-hatt-disclosure-email`

`DISCLOSURE_LEGAL_DETAILS_JSON`は次の形式です。公開CMSの事業者名、販売責任者、
電話番号、所在地開示プロファイル版と完全に一致しない限り、メール送信しません。

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

2026-09-12の移行では、既存Workerの値を変更せず、同一アカウントの既存Store
`f59c889c0fcc405794a34401fb09240c`へ暗号化転送でコピーしています。
Pagesの共有キーは同じ値のまま維持します。Store未設定の開発環境は従来Secretを利用し、
Storeを設定した環境で取得が失敗した場合は503で拒否します。
開示情報は認証通過後に必要な経路で取得し、取得値はリクエストをまたいでキャッシュしません。

検証では保護されたremote previewから本番service bindingの`POST /v1/ready`だけを呼び、
正しい認証とプロファイルで200、未認証・不正キーで401を確認します。
住所やキーは出力せず、メール送信はローカルのmockで検証します。

デプロイは、mainへ入ったソースと同じcommitから実行します。

```bash
npx wrangler deploy --config workers/disclosure-email-service/wrangler.jsonc
```

旧コピーの削除後は、復旧時にもStore binding対応版を使います。Store未対応の旧版をそのまま再配信する手順は使用しません。Pagesの共有キーとStore本体は保持します。
