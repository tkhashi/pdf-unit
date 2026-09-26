# ADR 0001: FastAPI + 単一HTML、PDF読み取りは pdfplumber と PDFium を採用する

- ステータス: 採用(PDFを一時ディレクトリに保存し文書IDで参照する方式は [0019](0019-aws-deployment.md) で廃止し、毎回PDFを送るステートレス方式に置き換え。UI を単一HTML・ビルド不要とする方針は [0027](0027-frontend-react-typescript.md) で React + TypeScript に置き換え)
- 日付: 2026-09-23

## コンテキスト

PDFを渡すとUI上にPDFを再表示し、検出した線にマウスオーバーするとその線の周りがハイライトされるアプリを、ローカル環境で動かす前提で新規に作る必要があった。参考実装として `../Agent.Sandbox/ClassifierArchDrawingByJev`(pdfplumber で建築図面のベクター情報を抽出するCLI)がある。

## 決定

- Python のパッケージ管理は `uv`(`uv init --package`)、`pyproject.toml` の `[tool.uv]` に `exclude-newer = "7 days"` を設定する
- サーバーは FastAPI + uvicorn。`127.0.0.1:8000` で待ち受け、`uv run pdf-unit` で起動する
- UI は `static/index.html` の1ファイル(HTML/CSS/素のJavaScript)とし、ビルド工程を持たない
- PDF のベクター情報(線・矩形・曲線・文字)は pdfplumber、描画・画像抽出・文字補完は pdfplumber が内部で使っている PDFium(pypdfium2)を直接使う
- アップロードされたPDFは起動時の一時ディレクトリに保存し、文書IDとの対応はメモリで保持する(DBは持たない)

## 理由

- 参考実装が pdfplumber ベースで、抽出処理・色変換・線幅補正をそのまま流用できる
- UI構成はユーザーが「FastAPI + 素のHTML/JS単一ファイル」を選択した(ユーザーの全体方針ではJSは TypeScript 推奨だが、ビルド不要で `uv run` 1コマンドで起動できることを優先)
- PDFium は pdfplumber の依存として既に入っており、追加依存なしで原本描画・埋め込み画像のデコード・文字解釈が使える
- ローカル専用・単一ユーザーなので永続化や認証は不要

## 影響

- 依存は `fastapi`, `uvicorn`, `pdfplumber`, `python-multipart` のみ
- サーバーを再起動するとアップロード済み文書は失われる(一時ディレクトリのファイルは残る)
- PDFium はスレッドセーフではないため、並行リクエストの扱いに注意が必要になった([0011](0011-pdfium-thread-safety.md))
