# Seller disclosure email service

販売者情報の請求時開示だけを処理する内部Cloudflare Workerです。実住所を
Cloudflare Pages FunctionやCMSへ渡さず、このWorkerのSecretからメール本文を
作成します。

`workers.dev` URLは無効で、Pagesの`DISCLOSURE_EMAIL_SERVICE` service binding
から、共有の`DISCLOSURE_SERVICE_TOKEN`を使って呼び出します。

## Required configuration

- Worker Secret: `DISCLOSURE_SERVICE_TOKEN`
- Worker Secret: `DISCLOSURE_LEGAL_DETAILS_JSON`
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

デプロイは、mainへ入ったソースと同じcommitから実行します。

```bash
npx wrangler deploy --config workers/disclosure-email-service/wrangler.jsonc
```
