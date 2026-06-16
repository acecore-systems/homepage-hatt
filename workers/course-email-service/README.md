# Course email service

Cloudflare Email Sending bindingを持つ、講座申し込み通知用の内部Workerです。

Pages Functionsは`send_email` bindingを直接使えないため、`COURSE_EMAIL_SERVICE`
service bindingでこのWorkerを呼び出します。

```bash
npx wrangler deploy --config workers/course-email-service/wrangler.jsonc
```

このWorkerの`workers.dev` subdomainは無効にし、Pages service bindingからのみ呼び出します。
