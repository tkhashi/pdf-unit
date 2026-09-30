# ADR 0041: サムネイルのラスタライズをサーバーからブラウザ側(pdf.js)へ移す

- ステータス: 採用
- 日付: 2026-09-30
- 追記(2026-09-30): [0042](0042-thumbnail-prefetch-all-pages.md) で、表示範囲の要求に加えて全ページを開いた直後から背景で先読みするようにした。

## コンテキスト

PDFを開いた直後、サムネイル一覧の表示が遅くUXが悪いと報告された。原因を調べたところ、次の設計が重なっていた。

- サーバー側の PDFium 呼び出しはプロセス全体で1本のロック(`_pdfium_lock`)により直列化されている([0011](0011-pdfium-thread-safety.md))。並行呼び出しで実際に SIGSEGV が起きた実績があり、直列化は撤回できない
- この直列化のため、サムネイル要求が本体ページの表示と競合するとロック待ちで本体表示自体が遅れる。これを避けるため、フロント側は「本体ページの読み込みが完了するまでサムネイル要求を一切送らない」制御を入れていた([0013](0013-page-thumbnails.md), [0019](0019-aws-deployment.md))
- サムネイルは `THUMB_BATCH=10` ページ単位・`THUMB_CONCURRENCY=1`(直列)でサーバーへ要求していたため、ページ数の多いPDFほど「本体ページ解析完了まで、サムネイルが一切出ない空白時間」が伸びていた

ページ数の多い文書ほどこの空白時間が体感速度として顕著になっていた。

## 決定

サムネイルのラスタライズをサーバー(PDFium/Python)からブラウザ側(pdf.js、専用の Web Worker)へ移す。

- `pdfjs-dist` を新規に依存へ追加する
- `web/src/workers/thumbnail-worker.ts` で pdf.js を動かす。Worker 内には `window` が無く、pdf.js は自身の内部 Worker 生成に失敗して同一スレッド実行(fake worker)に自動でフォールバックするため、`workerSrc` に `pdf.worker.mjs` の URL を指定しておけばこの Worker 1本の中で完結する
- 画像デコード等の内部処理が `document.createElement("canvas")` を呼ぶため(pdf.js既定の `DOMCanvasFactory`)、`document` の無い Worker 内では失敗する。`OffscreenCanvas` ベースの `CanvasFactory` を自前で用意して渡す
- ページ描画は `OffscreenCanvas` に行い、PNG の data URL としてメインスレッドへ返す
- `web/src/controllers/thumbnails.ts` から、サーバーへの `POST /api/thumbs` 呼び出し(`extractPages` によるページ切り出し含む)を撤去し、Worker 呼び出しに置き換える
- 「本体ページの読み込み完了を待ってから要求する」制御・`THUMB_BATCH`・`THUMB_CONCURRENCY` は撤廃する。ブラウザ内で完結するためサーバーの直列ロックと競合しない。IntersectionObserver による可視範囲検知はそのまま残す
- サーバー側 `POST /api/thumbs`・`_render_thumbnails`・`_MAX_THUMBS_PER_REQUEST` は削除する(他クライアントの利用実績・既存テストの依存が無いことを確認済み)。`scripts/profile_pages.py` の thumbs 関連コードも削除する

## 理由

- サムネイルの見た目はサーバー版(pypdfium2)と完全一致しなくてよいことをユーザーと合意した。サムネイルは一覧確認用途であり、pdf.js による描画の微妙な差(フォントレンダリング等)は許容する。本体ページ(座標・線・文字)の精度優先方針(CLAUDE.md)は変更しない、対象はサムネイルのみ
- ブラウザ内で完結させれば、サーバーの直列ロックを経由しなくなるため「本体表示優先の待ち合わせ」自体が不要になり、体感速度が改善する
- Web Worker 内で完結させることで、メインスレッド(本体ページの描画)をブロックしない

## 影響

- 新規依存 `pdfjs-dist` の追加(ライセンス表示にも反映)。ビルド成果物に `pdf.worker.mjs`(動的 import 用)が別チャンクとして追加される
- `web/vite.config.ts` の CSP に `worker-src 'self'` を追加した
- `e2e/parity.spec.ts` の新旧UI比較から、サムネイルの通信内容・同時要求数・読み込みタイミングの厳密一致比較を外した(新UIは待たずに描画するため原理的に一致しない)。見た目の構造(一覧の開閉・件数)だけ比較する
- `e2e/app.spec.ts` に新UI単体の期待値(本体読み込みを待たずに表示範囲だけ表示される)を追加した
- `POST /api/thumbs` 削除により、`scripts/profile_pages.py` の性能計測対象からサムネイルが外れた
