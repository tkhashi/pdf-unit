# ADR 0030: 本番ビルドの index.html に Content-Security-Policy を付ける

- ステータス: 採用
- 日付: 2026-09-26

## コンテキスト

React への移行の目的の1つは UI のセキュリティ向上です([0027](0027-frontend-react-typescript.md))。React のエスケープで `innerHTML` 由来の XSS の余地は無くなりますが、万一スクリプトが差し込まれた場合の被害を抑える仕組みはありませんでした。CloudFront(infra)は応答ヘッダーのポリシーを持っておらず、ローカルの FastAPI も CSP を付けていません。

移行後の UI は次のものしか使いません。

- 同じオリジンのスクリプト・スタイル(Vite の出力。インラインのスクリプトは無い)
- `data:` の画像(API が返す PNG の base64)
- 同じオリジンへの `fetch`(`/api/*`)

## 決定

Vite のプラグインで、本番ビルドの `index.html` の先頭に次の `<meta http-equiv="Content-Security-Policy">` を入れます。

```
default-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'
```

開発サーバー(`pnpm dev`)には付けません(React Fast Refresh がインラインのスクリプトを使うため)。

## 理由

- `meta` で付ければ、S3 + CloudFront・ローカルの FastAPI のどちらで配信しても同じ制限がかかり、infra を変えずに済む
- `style-src` は `default-src 'self'` に含まれる。React の `style` 属性は CSSOM 経由で設定されるため、`'unsafe-inline'` は要らない

## 影響

- 外部のスクリプト・画像・通信先を使う機能を足すときは、この CSP を見直す必要がある
- `frame-ancestors` は `meta` では効かない(必要になったら CloudFront の応答ヘッダーで付ける)
- E2E(`web/e2e/`)で `securitypolicyviolation` が起きないことを確かめている
