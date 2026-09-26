#!/usr/bin/env bash
# Lambda 用の zip(dist/lambda.zip)を組み立てる。GitHub Actions の Deploy ワークフローと手元の両方で使う。
#
# infra(pdf-unit.infra の PdfUnitStack)の Lambda 定義との約束事。どちらかを変えたら、もう一方も合わせること。
#   - ランタイム Python 3.13            … PYTHON_VERSION
#   - アーキテクチャ arm64              … PYTHON_PLATFORM(python3.13 ランタイムは Amazon Linux 2023 / glibc 2.34)
#   - ハンドラー run.sh(zip 直下)       … Lambda Web Adapter(レイヤー + AWS_LAMBDA_EXEC_WRAPPER)が起動する
#   - 待ち受けポート ${PORT:-8080}      … infra の環境変数 PORT=8080
#   - 起動確認 GET / が 200             … Lambda Web Adapter の既定の確認先(server.py の GET /)
set -euo pipefail

PYTHON_VERSION=3.13
PYTHON_PLATFORM=aarch64-manylinux_2_34

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
PKG="$OUT/lambda"

rm -rf "$PKG" "$OUT/lambda.zip"
mkdir -p "$PKG"

# ロック済みの依存(開発用を除く)を、arm64 Linux 用のバイナリ wheel だけで入れる
uv export --project "$ROOT" --frozen --no-dev --no-emit-project --no-hashes -q -o "$OUT/requirements.txt"
uv pip install -q -r "$OUT/requirements.txt" --target "$PKG" \
  --python-platform "$PYTHON_PLATFORM" --python-version "$PYTHON_VERSION" --only-binary :all: --no-compile

# アプリ本体と起動スクリプト(静的ファイルは Lambda では配信しないが、GET / の起動確認に index.html を使う)
cp -R "$ROOT/src/pdf_unit" "$PKG/pdf_unit"
find "$PKG/pdf_unit" -name '__pycache__' -type d -prune -exec rm -rf {} +
cat > "$PKG/run.sh" <<'RUN'
#!/bin/bash
exec python -m uvicorn pdf_unit.server:app --host 127.0.0.1 --port "${PORT:-8080}"
RUN
chmod +x "$PKG/run.sh"

# 実行ビット(run.sh)を保ったまま zip にする
(cd "$PKG" && zip -qr9 "$OUT/lambda.zip" .)
echo "built $OUT/lambda.zip ($(du -h "$OUT/lambda.zip" | cut -f1), unzipped $(du -sh "$PKG" | cut -f1))"
