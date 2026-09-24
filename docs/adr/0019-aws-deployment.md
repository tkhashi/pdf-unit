# ADR 0019: AWS Lambda で動かすため、サーバーをステートレスにし、PDFを毎回リクエストで送る

- ステータス: 採用([0001](0001-tech-stack.md) のPDF保存方式と、[0013](0013-page-thumbnails.md) のサムネイルAPI・キャッシュを置き換え。PDF全体の送信と4MBの全体上限は [0020](0020-send-only-needed-pages.md) で変更)
- 日付: 2026-09-25

## コンテキスト

ローカル専用だったアプリを AWS 上でも使えるようにする。構成は CloudFront → Lambda 関数URL(OAC で保護)とし、Lambda では AWS Lambda Web Adapter で `uvicorn pdf_unit.server:app` を動かす(インフラ定義は別リポジトリ)。

従来のサーバーには次の状態があり、Lambda ではそのままでは動かなかった。

- アップロードしたPDFを起動時の一時ディレクトリ(`mkdtemp`)に保存し、文書ID→パスの対応をメモリ(`_documents`)に持っていた。Lambda は要求ごとに別の実行環境へ振り分けられることがあり、アップロード時と別の環境に届いた要求は「文書が見つからない」になる
- 抽出結果・画像を `lru_cache` でキャッシュしていた。実行環境ごとにばらばらで、メモリを圧迫するだけで効果が当てにならない
- 画像を `image/png` のバイナリ応答で返していた

また、Lambda と CloudFront OAC には次の制約がある。

- Lambda の同期呼び出しは、リクエスト・レスポンスともペイロードが 6MB まで。関数URLはバイナリのボディを base64 化してイベントに入れるため、生バイト列は約 4.5MB(6MB × 3/4)までしか送れない
- CloudFront の OAC で Lambda 関数URLへ POST / PUT する場合、クライアントがボディの SHA-256 を `x-amz-content-sha256` ヘッダーで付けなければならない(CloudFront は署名時にボディのハッシュを計算しない)

S3 に一時保存して文書IDで参照する方式も考えられるが、今回はバケットや権限・後片付け(ライフサイクル)の管理を増やさないことを優先した。

## 決定

- サーバーを完全にステートレスにする。一時ディレクトリ・`_documents`・`lru_cache`・文書IDの概念を削除し、`/tmp` への書き込みもメモリ上のキャッシュも持たない。S3 も使わない
- UI は選択したPDFを `ArrayBuffer` のまま保持し、API を呼ぶたびにPDFの生バイト列を POST のボディ(`Content-Type: application/pdf`)として送る
  - `x-amz-content-sha256` にボディの SHA-256(16進)を付ける。PDFを開いたときに `crypto.subtle.digest` で1度だけ計算し、以後の要求で使い回す
  - 送信は共通の `apiPost(path)` で行う
- サーバーはPDFをメモリ上のバイト列のまま処理する(`pypdfium2.PdfDocument(bytes)`、`pdfplumber.open(io.BytesIO(...))`)。`extract.py`・`raster.py` の関数はパスではなくバイト列を受け取るようにした
- 入力の検証は共通の FastAPI 依存関係(`pdf_body`、`await request.body()`)で行う
  - 4MB(4 × 1024 × 1024 バイト)を超えたら 413。UI も同じ値で送信前にエラーを表示する
  - ボディが `%PDF` で始まらなければ 400
- API はすべて POST にし、画像は PNG の base64 文字列を JSON で返す
  - `POST /api/documents/info` → `{pages}`(従来の `POST /api/documents` から `doc_id` と `filename` を除いたもの。ファイル名はUIが持っている)
  - `POST /api/thumbs?start=&count=&width=` → `{thumbs: [{page, png_base64}]}`。`count` は最大10、`width` は 60〜400px
  - `POST /api/pages/{n}/lines` → 従来と同じ抽出結果
  - `POST /api/pages/{n}/image?resolution=` → `{resolution, png_base64}`。`resolution` は 36〜600dpi
  - `POST /api/pages/{n}/images/{k}` → `{png_base64}`
  - 従来の GET の画像API(`image.png`・`thumb.png`・`images/{k}.png`)は削除した。`GET /` はローカル利用のため残す
- 応答が 6MB を超えないよう、base64 が 5.5MB を超えた場合は縮小する
  - 原本画像は、base64 の長さの比の平方根(PNGの大きさは画素数にほぼ比例するため)に1割の余裕を掛けて解像度を下げ、収まるまで描き直す。実際の解像度を `resolution` で返す
  - 埋め込み画像は Pillow で同じ比率ずつ縮小する
- UI の画像は `<img src>` のURLではなく、`apiPost` で得た base64 を `data:image/png;base64,...` にして表示する
  - 原本画像は、要求した解像度の段階を記録し、サーバーが解像度を下げて返しても同じ段階を再要求しない。受け取った実際の解像度より低い応答では上書きしない(画像はCSSでページ枠いっぱいに表示するので、解像度が変わっても位置はずれない)
  - サムネイルは `IntersectionObserver` で表示範囲に入ったページを含む10ページ単位のバッチを要求する。同じバッチを重複して要求せず、同時に読み込むのは1バッチまでとし、本体ページの線データ取得中は控える([0013](0013-page-thumbnails.md) の方針を引き継ぐ)
- PDFium の呼び出しは従来どおりすべて `_pdfium_lock` の中で行う([0011](0011-pdfium-thread-safety.md))

## 理由

- PDFを毎回送れば、どの実行環境に届いても同じ結果を返せる。状態を持たないので、スケールや実行環境の入れ替わりを気にしなくてよい
- 外部ストレージを使わないため、インフラが CloudFront・Lambda だけで済み、アップロードしたPDFがサーバー側に残ることもない
- 画像を JSON(base64)で返すのは、全APIが PDF を POST するため `<img src>` の GET では送れないことと、応答の形式をそろえて `resolution` のような付加情報を返せるようにするため
- サムネイルをバッチにするのは、1ページずつ要求するとPDFを送る回数と Lambda の呼び出し回数がページ数分に増えるため

## 影響

- PDFを毎回送るため、通信量と Lambda の呼び出しごとの処理(PDFの解析)が増える。キャッシュも無いので、同じページを開き直すたびに抽出・描画をやり直す(大判図面では1ページ数秒〜十数秒)。ブラウザ側のキャッシュも効かない
- base64 化により、画像の転送量は約4/3倍になる
- 4MB を超えるPDFは扱えない。6MB の上限はイベント全体(ヘッダー等を含む)にかかるため、理論上限の約 4.5MB ではなく 4MB に制限し、base64 後(約 5.3MB)にヘッダー等の余裕を残す
- 原本画像は、大判図面の高倍率表示で要求より低い解像度になることがある
- ローカル(`uv run pdf-unit`)でも同じ API で動く。ローカルのサーバーは `x-amz-content-sha256` を検証しない
- 依存から `python-multipart` を外した(multipart のアップロードを使わなくなったため)
