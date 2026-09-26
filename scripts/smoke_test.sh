#!/usr/bin/env bash
# デプロイ後の動作確認。GitHub Actions の Deploy ワークフローの最後に実行する(手元からも実行できる)。
#
#   scripts/smoke_test.sh https://xxxx.cloudfront.net      # 本番(CloudFront 経由)
#   scripts/smoke_test.sh --local http://127.0.0.1:8000    # ローカルのサーバー(OAC が無いので 403 の確認は省く)
#
# 確認内容:
#   1. GET / と GET /vendor/pdf-lib.min.js が 200(S3 の静的ファイル)
#   2. 1ページのPDFを x-amz-content-sha256 付きで POST /api/page/lines すると 200 で、線が検出される(Lambda)
#   3. x-amz-content-sha256 が無い POST は 403(CloudFront OAC。--local では省略)
set -euo pipefail

LOCAL=0
if [[ "${1:-}" == "--local" ]]; then LOCAL=1; shift; fi
BASE="${1:?usage: smoke_test.sh [--local] <SITE_URL>}"
BASE="${BASE%/}"
# SITE_URL をスキーム無し(xxxx.cloudfront.net)で登録しても動くよう https を補う
# (http だと CloudFront が https への 301 を返して判定に失敗する)
[[ "$BASE" == http://* || "$BASE" == https://* ]] || BASE="https://$BASE"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "NG: $*" >&2; exit 1; }

# 線を1本だけ含む1ページのPDF(標準ライブラリだけで作る)
python3 - "$WORK/page.pdf" <<'PY'
import sys
content = b"1 w 10 10 m 190 190 l S"
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>",
    b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
]
out, offsets = bytearray(b"%PDF-1.4\n"), []
for i, body in enumerate(objs, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
open(sys.argv[1], "wb").write(out)
PY
SHA="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$WORK/page.pdf")"

status() { curl -sS -o "$WORK/body" -w '%{http_code}' "$@"; }

for path in / /vendor/pdf-lib.min.js; do
  code="$(status "$BASE$path")"
  [[ "$code" == 200 ]] || fail "GET $path -> $code"
  if [[ "$path" == / ]]; then grep -q "<title>PDF Unit</title>" "$WORK/body" || fail "GET / が PDF Unit の画面ではない"; fi
  echo "OK: GET $path -> 200"
done

# 反映直後の一時的な失敗(コールドスタート等)に備えて数回試す
for attempt in 1 2 3 4 5; do
  code="$(status -X POST "$BASE/api/page/lines" -H 'Content-Type: application/pdf' \
    -H "x-amz-content-sha256: $SHA" --data-binary @"$WORK/page.pdf")" || code=000
  [[ "$code" == 200 ]] && break
  echo "retry: POST /api/page/lines -> $code ($attempt)"; sleep 5
done
[[ "$code" == 200 ]] || fail "POST /api/page/lines -> $code: $(head -c 300 "$WORK/body")"
python3 - "$WORK/body" <<'PY' || fail "POST /api/page/lines の応答が想定と違う"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["page"] == {"width": 200, "height": 200}, d["page"]
assert len(d["lines"]) == 1, len(d["lines"])
PY
echo "OK: POST /api/page/lines -> 200 (線1本を検出)"

if [[ "$LOCAL" == 0 ]]; then
  code="$(status -X POST "$BASE/api/page/lines" -H 'Content-Type: application/pdf' --data-binary @"$WORK/page.pdf")"
  [[ "$code" == 403 ]] || fail "x-amz-content-sha256 無しの POST -> $code (403 のはず)"
  echo "OK: x-amz-content-sha256 無しの POST -> 403"
fi
echo "smoke test passed: $BASE"
