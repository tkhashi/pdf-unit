# ADR 0027: UI を React + TypeScript へ移行し、ツールチェーンを pnpm・Vite・Biome(ultracite)・Tailwind CSS・daisyUI にする

- ステータス: 採用([0001](0001-tech-stack.md) の「UI は `static/index.html` の1ファイル(HTML/CSS/素のJavaScript)とし、ビルド工程を持たない」と、[0020](0020-send-only-needed-pages.md) の pdf-lib を `static/vendor/` に同梱する方式を置き換え)
- 日付: 2026-09-26

## コンテキスト

UI は `src/pdf_unit/static/index.html` の1ファイル(約1250行)で、ビルド不要で `uv run pdf-unit` だけで起動できることを優先して素の JavaScript で書いていました([0001](0001-tech-stack.md))。機能が増えるにつれて、次の問題が目立つようになりました。

- 画面の状態(表示中のページ、選択、ホバー、表示倍率、サムネイルの取得状況など)が約30個のトップレベルの可変変数に分散し、どの関数がどの変数を書き換えるかをコードを通読しないと追えない
- 属性パネルや凡例を `innerHTML` の文字列連結で組み立てており、エスケープ漏れがそのまま XSS になりうる(色の値を `style` 属性へ埋め込む箇所など)
- API の応答やページのモデルに型が無く、サーバー側(`extract.py` 等の TypedDict)の変更に UI が追随できているかを機械的に確かめられない

## 決定

- UI を `web/` 配下の React 19 + TypeScript(strict、`noUncheckedIndexedAccess`・`exactOptionalPropertyTypes` を含む)で書き直す。バンドルは Vite
- パッケージ管理は pnpm(`web/package.json` の `packageManager` で版を固定)。`web/pnpm-workspace.yaml` の `minimumReleaseAge: 10080` で公開から7日未満の版を入れない(Python 側の `exclude-newer = "7 days"` と揃える)。依存の版は `--save-exact` で固定する
- 開発者の環境には Aikido Safe Chain(`pnpm` をラップしてマルウェア・公開直後の版を止める)が入っている。止められたときに迂回はせず、別の版を検討する
- lint / format は Biome に ultracite のプリセット(`ultracite/biome/core`・`react`・`vitest`)を重ねて使う(`pnpm lint` = `ultracite check`、`pnpm fix` = `ultracite fix`)。ESLint・Prettier は使わない
- スタイルは Tailwind CSS v4 + daisyUI 5(独自のライトテーマ `pdfunit`、使う部品 `button`・`join`・`checkbox`・`range` だけを取り込む)。ツールチップは daisyUI の `.tooltip` を使わず自前のまま([0017](0017-custom-tooltip-and-toolbar.md) の理由: 遅延表示・画面端での位置補正・固定表示が必要)
- pdf-lib は npm の依存(1.17.1 に固定。旧UIが同梱していた版と同じ)にしてバンドルに含める。同梱ライブラリのライセンスは Vite の `build.license` で `licenses.md` に出力する
- 単体テストは Vitest、E2E は Playwright

## 理由

- React は描画する文字列を既定でエスケープするため、`innerHTML` を無くせば UI 側の XSS の余地を構造的に減らせる
- TypeScript の strict により、API 応答の型・状態の遷移・コンポーネントの props を型で検査できる
- ユーザーの指定(pnpm・Biome/ultracite・Tailwind・daisyUI)に従った。Biome は lint と format を1つの道具で賄え、ultracite のプリセットで規則を一から決めずに済む
- pdf-lib を npm から入れると版がロックファイルで管理され、`scripts/profile_pages.py` も同じものを使える

## 影響

- `uv run pdf-unit` の前に UI のビルド(`pnpm --dir web install && pnpm --dir web build`)が必要になった。ビルド成果物の置き場所とデプロイは [0029](0029-build-artifacts-and-deploy.md)
- 状態管理と描画の構成は [0028](0028-state-and-rendering-architecture.md)、CSP は [0030](0030-content-security-policy.md)、機能が変わっていないことの確かめ方は [0031](0031-migration-parity-verification.md)
- 見た目はピクセル単位では旧UIと一致しない(ヘッダーの詰め方・ボタン・チェックボックスの見た目が daisyUI のものになった)。操作・表示内容・通信は変えていない
