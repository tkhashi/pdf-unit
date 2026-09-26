# PDF Unit

PDF(主に建築図面)を開くと、pdfplumber / PDFium で検出した線・文字・埋め込み画像を種類別に色分けして再描画し、マウスオーバーやクリックで個々の要素や同じ属性を持つ要素群をハイライトできるWebアプリです。ローカルでも、AWS Lambda 上でも(ステートレスなサーバーとして)動作します。

検出結果が元のPDFとどれだけ一致しているかを目視で確かめる用途を想定しており、元のPDFを描画した「原本」画像を薄く下敷きにして重ねて表示します(検出されなかった要素は原本の灰色として見えます)。

設計判断の経緯は [docs/adr/](docs/adr/) を参照してください。

## 起動

```sh
uv sync
uv run pdf-unit
```

ブラウザで http://127.0.0.1:8000 を開き、PDFをドラッグ&ドロップするか「開く」から選択します。`uv run pdf-unit` はサーバーを `127.0.0.1` のみで待ち受けます。

AWS では CloudFront → Lambda 関数URL(OAC)の構成で、AWS Lambda Web Adapter + `uvicorn pdf_unit.server:app` として実行します。静的ファイル(`index.html`・`vendor/`)は S3 から配信します。

## 開発の進め方

ブランチは次の構成で運用します(ADR 0022)。

- `development`(既定ブランチ): 開発中の変更を集めるブランチ。直接コミット・push はせず、PR でのみ変更します
- `main`: 本番。`main` への反映はそのまま AWS へのデプロイになる(「デプロイ」参照)ため、手動で行うか、エージェントには明示的に指示したときのみ行わせます
- 作業ブランチ: `development` から作成し、名前は `feat-`(機能追加)・`fix-`(不具合修正)・`docs-`(文書のみ)に英小文字・数字・ハイフンの説明を続けます(例: `feat-thumbnail-cache`)

作業が終わったら `development` 向けの PR を作り、squash マージします。`development` から `main` への反映は `gh pr create --base main --head development` で PR を作り、merge commit でマージします(squash すると両ブランチの履歴が分かれ、次回の反映で衝突しやすくなるため)。PR のタイトルはコミットと同じ形式(`feat:` 等 + 日本語)、本文は `.github/pull_request_template.md` に沿って日本語で簡潔に書きます。

ルールと、それを守らせる仕組みの置き場所は次のとおりです。

| 置き場所 | 役割 |
| --- | --- |
| GitHub のルールセット・リポジトリ設定 | 既定ブランチ、`main`・`development` への直接 push・force push・削除の禁止、PR 必須。人とエージェントの双方に効く最終的な防衛線 |
| `.github/pull_request_template.md` | PR 本文の型。GitHub の画面から作る場合にも使われる |
| `CLAUDE.md`「ブランチと PR」 | エージェントが常に読むルールの要約 |
| `.claude/skills/pr/SKILL.md` | エージェントが `development` 向け PR を作成・マージする手順(`/pr`) |
| `.claude/settings.json`・`.claude/hooks/guard-git.sh` | エージェントの git/gh 操作を実行前に検査するフック。保護ブランチへの直接コミット・push、`--force`、命名規則違反のブランチ作成は拒否し、`main` 向けの PR 作成・マージと `main` 上での `git merge` はユーザーに確認を求める |

## デプロイ

`main` にマージすると、GitHub Actions(`.github/workflows/deploy.yml`)が AWS へ自動で反映します(ADR 0021)。

1. `scripts/build_lambda.sh` で Lambda 用の zip(`dist/lambda.zip`)を組み立てる
2. OIDC で AWS のロールを引き受ける(長期のアクセスキーは使いません)
3. `aws lambda update-function-code` で Lambda のコードを差し替え、反映を待つ
4. `aws s3 sync` で `src/pdf_unit/static` を S3 に置き、CloudFront のキャッシュを無効化する
5. `scripts/smoke_test.sh` で公開URLの動作を確認する(画面・同梱ライブラリ・API・OAC)

AWS のリソース(S3・Lambda・CloudFront・このワークフローが引き受けるロール)は別リポジトリ `pdf-unit.infra` が定義し、そちらは手動でデプロイします。初回の準備(リポジトリ変数の登録など)は `pdf-unit.infra` の README「アプリのデプロイ」を参照してください。

必要なリポジトリ変数(Settings → Secrets and variables → Actions → Variables。値は infra の `cdk deploy` の出力): `AWS_REGION`・`AWS_DEPLOY_ROLE_ARN`・`LAMBDA_FUNCTION_NAME`・`SITE_BUCKET_NAME`・`DISTRIBUTION_ID`・`SITE_URL`。Secrets は不要です。

### infra との約束事

zip の中身と infra の Lambda 定義は次の点で一致している必要があります。どちらかを変える場合は、もう一方も合わせてください。

| 項目 | アプリ側(`scripts/build_lambda.sh`) | infra 側(`PdfUnitStack` の Lambda) |
| --- | --- | --- |
| Python の版 | 3.13 用の wheel を入れる | ランタイム `python3.13` |
| アーキテクチャ | `aarch64-manylinux_2_34` の wheel を入れる | `arm64` |
| 起動 | zip 直下の `run.sh` が `uvicorn pdf_unit.server:app --host 127.0.0.1 --port ${PORT:-8080}` を実行 | ハンドラー `run.sh`、Lambda Web Adapter レイヤー、`AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap`、`PORT=8080` |
| 起動確認 | `GET /` が 200 を返す | Lambda Web Adapter の既定の確認先 `GET /` |

手元での確認:

```sh
scripts/build_lambda.sh                            # dist/lambda.zip を作る
scripts/smoke_test.sh --local http://127.0.0.1:8000  # uv run pdf-unit で起動したサーバーに対して確認
```

## 画面構成

- **ヘッダー(ツールバー)**: カテゴリごとに縦線で区切り、次の順に並びます。画面幅に収まらない場合は折り返します
  - アプリ名 | 「開く」・開いているファイル名・「3 / 108 ページ」 | 表示切替(両方 / ベクター / ラスター のセグメントボタン) | 種類別の凡例(一括チェック、種類ごとの件数・表示切替) | 原本の濃さ | 線幅補正の係数 … `?`(操作説明、右端)
  - 各項目はマウスを乗せると約0.25秒で機能の補足を表示します。`?` はクリック(または Enter)で操作説明の表示を固定でき、もう一度クリックするか Esc で閉じます
  - ページの移動は左のサムネイル一覧から行います
- **左: サムネイル一覧**: 各ページを元PDFのまま縮小表示します。クリックでページを切り替え、現在のページは青枠で強調されます。一覧の右(図面との境目)に隣接する細長いボタン(`◀`/`▶`)で開閉します(閉じてもボタンは残ります)
- **中央: 図面表示領域**: 下から順に、原本画像(初期不透明度20%)、再描画(埋め込み画像・線・文字)、ハイライトを重ねて表示します
- **右下: 属性パネル**: ホバー中の要素(無ければ選択の起点要素)の属性を表示します

### 再描画の色

| 種類 | 色 | 抽出元 |
| --- | --- | --- |
| line | 青 | pdfplumber `page.lines` |
| rect | 緑 | pdfplumber `page.rects` |
| curve | 紫 | pdfplumber `page.curves`(ベジェ曲線を保持) |
| text | 橙 | pdfplumber の文字を単語単位にまとめたもの |
| image | 元画像のまま | PDFium で抽出した埋め込みラスター画像 |

ヘッダーの表示切替(セグメントボタン)で、両方 / ベクター(線・文字のみ) / ラスター(埋め込み画像のみ) のどれか1つを選べます。凡例のチェックボックスで種類ごとの表示/非表示も切り替えられ、凡例先頭の一括チェックで5種類をまとめて切り替えられます(全部表示中はチェック、一部だけ表示中は「−」、全部非表示は空。押すと、全部表示中なら全部非表示、それ以外なら全部表示)。非表示の要素はホバー・クリックの対象外です。

## 操作

- **ホイール**: カーソル位置を中心にズーム(0.1〜400倍)。ページ表示時とウィンドウサイズ変更時は自動で全体表示になります。拡大に応じて原本画像を高解像度(100/200/400dpi)で取り直します
- **ドラッグ**: 表示位置の移動
- **ホバー**: カーソルに最も近い線・文字・画像を赤でハイライトし、属性を右下に表示します
  - 線は「線の縁が画面上8px以内」のものを候補とし、その中で中心線が最もカーソルに近いものを選びます。0.06pt間隔の極細の格子のように、描画上は重なって見える線も拡大すれば1本ずつ選べます
  - 文字・画像は枠内でも線より優先度を下げています(文字や画像に重なる線を優先)
- **クリック**: クリックした要素と同じ属性を持つ要素をすべて黄色の縁取りでハイライトし、他の要素を薄く表示します。同じ要素を続けてクリックすると、判定に使う属性が次へ切り替わります
  - 線: 種類 → 線幅 → 長さ(lineのみ) / 形状(curveのみ) → 描画太さ → 色 → 濃淡 → 解除
  - 文字: 種類 → フォント → サイズ → 色 → 濃淡 → 解除
  - 画像: 種類 → 画素数 → 解像度 → 圧縮形式 → 解除
  - それまでに表示した集合と同じ結果になる属性は飛ばします
  - 現在の属性は属性パネルの該当行が黄色になり、件数が表示されます
- **Esc** または何もない所をクリック: 選択解除

### 属性の定義

- **線幅**: PDF が報告する線幅(linewidth)の値そのもの
- **描画太さ**: 実際に描画される太さ(線幅 × 線幅補正係数)。補正係数は原本画像から孤立した直線の太さを実測して自動算出します
- **長さ**: line の長さ(pt、0.01pt単位で一致判定)
- **形状**: 回転・反転・一様な拡大縮小・平行移動を許容した同一形状(相似形)。X/Yで倍率が異なる変形は別形状として扱います
- **色**: 線は描画色、文字は塗り色(CSS の `rgb()` 表記で完全一致)
- **濃淡**: 色の輝度から求めた濃度(0%=白〜100%=黒)を5%刻みで一致判定
- **フォント / サイズ**: pdfplumber のフォント名 / 文字の高さ(pt)
- **画素数 / 解像度 / 圧縮形式**: 埋め込み画像の元の画素数 / ページ上での実効dpi / PDFのフィルタ(`DCTDecode` 等)

## 抽出処理の仕様

- **座標系**: pdfplumber の表示座標(左上原点、pt、ページ回転 `/Rotate` 反映後)に統一しています。PDFium から得た座標(埋め込み画像)は `FPDF_PageToDevice` でこの座標系に変換します
- **線幅補正**: pdfplumber の報告する線幅(linewidth)は CAD のペン幅がそのまま入っている等で実際の描画太さと一致しないことがあるため、原本画像での実測値との比を補正係数として使います(ClassifierArchDrawingByJev の `calibration.py` を移植)。実測に使うのはほかの図形と重ならない孤立した直線で、孤立の判定は格子状の空間索引で近くの図形だけを調べます(結果は総当たりと同じ。[ADR 0025](docs/adr/0025-calibration-spatial-index.md))。ヘッダーには「線幅補正 ×0.18」のように係数を表示し、算出できなかった場合(補正なし)は「線幅補正 -」と表示します。算出方法はマウスオーバーで補足します
- **文字**:
  - 単語単位にまとめ、フォント・サイズ・色が変わる箇所で区切ります
  - 描画位置・回転は文字の変換行列から、描画サイズはフォントサイズ(外接矩形・送り幅・行列から逆算)と行列の縦倍率から求めます
  - ToUnicode 情報を持たないフォントで pdfminer が `(cid:N)` と出す文字は、次の順で補完します([ADR 0018](docs/adr/0018-cid-restoration-rotation-and-validation.md))
    1. PDFium の文字解釈を文字位置(ページ回転を反映した表示座標)で突き合わせ、PDFium が実際に対応を見つけた文字を使う
    2. CID の値そのものが Unicode であるフォント(フォント内の文字の9割以上がよく使われる文字の範囲に収まる)は、CID をそのまま文字として使う
    3. どちらでも決まらない文字は「□」で表示し、属性パネルに「読めない文字: N字」と表示する
  - 本文の文字コード(Shift_JIS・UTF-16・UTF-8 等)はフォントの Encoding(CMap。`90ms-RKSJ-H`、`UniJIS-UTF16-H`、`UniJIS-UTF8-H` 等)と ToUnicode に従って pdfminer が解釈します。文字コードの推測は行いません
- **フォント名の文字コード**: PDF のフォント名は文字コードの宣言を持たないバイト列のため、ページ単位で自動判定します([ADR 0021](docs/adr/0021-font-name-encoding-per-page.md))。1ページの中で使われる文字コードは1種類と仮定しています
  1. ASCII だけの名前はそのまま表示する
  2. BOM(UTF-8 / UTF-16BE / UTF-16LE)がある名前はそれに従う
  3. それ以外の名前は、ページ内のすべてを UTF-8 → BOM無し UTF-16(0x00 を含む偶数長の名前ばかりの場合)→ Shift_JIS(cp932)の順に試し、すべてを読める最初の文字コードを使う。制御文字・私用領域の文字が出る場合は読めなかったとみなす
  4. どれでも読めない場合は推測せず、PDF の名前表記(`#82l#82r…`)で表示する
- **埋め込み画像**:
  - Form XObject 内の画像も含めて抽出します
  - 回転なしで置かれた画像は透過マスク適用済みの見た目を、回転・せん断された画像は生の画素を四隅に合わせて変形して描画します
- **サムネイル**: 線検出を行わず、PDFium で元PDFを出力幅160px前後に縮小描画したものです。一覧の表示範囲に入ったページを含む10ページ単位のバッチで、1バッチずつ、本体ページの読み込みが終わってから取得します(同じバッチは重複して要求しません)。バッチを切り出したPDFが送信上限を超える場合は半分ずつに分けて送り、1ページでも超える場合はそのサムネイルを斜線の「表示できません」表示にします

## API

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/` | UI(`static/index.html`) |
| POST | `/api/thumbs?width=` | サムネイル。ボディのPDFの全ページ(最大10)、幅60〜400px。`{thumbs: [{page, png_base64}]}`(`page` は送ったPDF内でのページ番号) |
| POST | `/api/page/lines` | 抽出結果。`{page: {width, height}, linewidth_scale, calibration, lines, texts, images}` |
| POST | `/api/page/image?resolution=` | 原本画像(36〜600dpi)。`{resolution, png_base64}`(`resolution` は実際の解像度) |
| POST | `/api/page/images/{k}` | 埋め込み画像 k の画像データ。`{png_base64}` |
| GET | `/vendor/pdf-lib.min.js` | UIが使う同梱ライブラリ(`static/vendor/` を配信。`index.html` からは相対パス `vendor/` で参照) |

サーバーはステートレスで、PDFを保存せず、キャッシュも持ちません。`GET` 以外のAPIはすべて POST で、リクエストボディにPDFの生バイト列(`Content-Type: application/pdf`)を送ります。UIは開いたPDFをブラウザ上に保持し、[pdf-lib](https://github.com/Hopding/pdf-lib) で**必要なページだけを切り出したPDF**(`/api/page/*` は1ページ、`/api/thumbs` は最大10ページ)を送ります。`/api/page/*` のサーバーは送られたPDFの先頭ページを処理します(ADR 0019, 0020)。ページの寸法(一覧の枠・図面の枠)は UI が pdf-lib で求め、`/api/page/lines` の `page` で答え合わせします。

- ボディのSHA-256(16進)を `x-amz-content-sha256` ヘッダーに付けます。CloudFront の OAC 経由で Lambda 関数URLへ POST する場合に必須です(ローカルのサーバーは検証しません)。UIは切り出したPDFごとに計算し、1ページ分の切り出し結果は直近6ページ分を使い回します
- 1回に送るPDF(切り出したページ)の上限は 4MB(4 × 1024 × 1024 バイト)です。PDF全体の大きさには上限がありません。UIは超過するページを送らずにエラーを表示し、サーバーは超過時に 413 を返します。ボディが `%PDF` で始まらない場合は 400 を返します
- 画像はPNGのbase64文字列としてJSONで返します。base64が 5.5MB を超える場合、原本画像は解像度を下げて描き直し、埋め込み画像は縮小して返します(Lambda のレスポンス上限 6MB に収めるため)
- ページ・画像番号が範囲外の場合は 404 を返します
- `/api/*` の応答には、処理区間ごとの所要時間を示す `Server-Timing` ヘッダーと、件数などを JSON で示す `X-Perf-Metrics` ヘッダーが付きます(「性能の計測」参照)

## 性能の計測

高速化は、計測で支配的と分かった箇所から、出力(応答ボディ)が変わらない範囲で行います([ADR 0023](docs/adr/0023-performance-measurement.md))。計測の仕組みは次の4つです。

- **`Server-Timing` / `X-Perf-Metrics` ヘッダー**: 区間の所要時間(ミリ秒)と件数です。区間名の `.` は内訳を表し(`calib.render` は `calib` の内訳)、`.` を含まない区間の合計がその API の処理時間の目安になります。`lock_wait` は PDFium のロック待ちの時間です
  - `/api/page/lines`: `open`(PDFを開く)・`parse`(pdfminer によるページの解析)・`vectors`(線の抽出)・`calib`(線幅補正。内訳 `calib.select`・`calib.render`・`calib.measure`)・`texts`(文字。内訳 `texts.cid`・`texts.words`・`texts.fonts`・`texts.records`)・`images`(埋め込み画像。内訳 `images.decode`・`images.png`)
  - `/api/page/image`・`/api/thumbs`: `open`・`render`・`png`・`b64`
  - `/api/page/images/{k}`: `open`・`images`・`downscale`
- **サーバーのログ**: API リクエストごとに1行の JSON を標準出力に書きます。項目は `perf`(パス)・`query`・`status`・`cold`(プロセス最初のリクエストか)・`total_ms`(ボディ受信・JSON 直列化を含む全体)・`req_bytes`・`resp_bytes`・`stages_ms`・`metrics`・`maxrss_mb`(プロセス開始以来の最大メモリ)・`rss_mb`(現在のメモリ。Linux のみ)です。Lambda では CloudWatch Logs Insights で集計できます
- **ブラウザのコンソール**: `console.debug`(DevTools の Console で Verbose を有効にすると表示)に、API 呼び出しごとの所要時間・送受信サイズ・`Server-Timing`、ページ切り出しの時間、ページ切替からの経過(線データ受信・描画準備完了・初回描画完了・原本画像表示)を出します
- **`scripts/profile_pages.py`**: PDF のページごとに各 API を計測し、呼び出しごと・区間ごとの集計、応答サイズとピークメモリの最大を表示します

```sh
uv run python scripts/profile_pages.py 図面.pdf --pages 1-5 --out result.jsonl
uv run python scripts/profile_pages.py 図面.pdf --pages 3 --dump out/after   # 応答ボディを保存(変更前後を cmp で比較)
uv run python scripts/profile_pages.py 図面.pdf --pages 3 --cprofile prof   # cProfile を保存(時間の計測とは別に実行)
```

- 1回の API 呼び出しごとに子プロセスを起動し、ASGI アプリに直接 POST します(Depends・JSON 直列化・ミドルウェアを含む実際の経路)。子プロセスの最大メモリを、その呼び出しのピークメモリとみなします
- ページの切り出しは UI と同じく同梱の pdf-lib を Node.js で動かして行います。Node.js が無い場合は pypdfium2 で切り出しますが、UI が送るバイト列とは異なるため、計測値の比較には注意してください
- 計測する API は `--endpoints`(既定 `lines,image,images,thumbs`)、原本画像の解像度は `--resolutions`(既定 `100,200,400`、UI と同じ)、1ページで計測する埋め込み画像の数は `--max-images`(既定3、0で全件)で指定します
- 手元(Apple Silicon)の計測値は Lambda(arm64、2048MB で約1.2 vCPU 相当)より速く出ます。区間の比率や、画素数・件数に対する伸び方を見る用途に使ってください

## ファイル構成

```
src/pdf_unit/
  server.py        FastAPIアプリ(ステートレス)、API、PDF検証、応答サイズ調整、PDFium直列化ロック
  extract.py       線・文字の抽出(pdfplumber)、cid文字補完、フォントサイズ逆算
  raster.py        埋め込み画像の抽出(PDFium)、座標変換
  calibration.py   線幅補正(ClassifierArchDrawingByJev から移植)
  timing.py        性能計測(処理区間の所要時間・件数の収集)
  static/index.html  UI(HTML/CSS/JS 1ファイル、ビルド不要)
  static/vendor/     同梱ライブラリ(pdf-lib 1.17.1、MIT)
scripts/
  build_lambda.sh  Lambda 用 zip の組み立て(CI と手元で共用)
  smoke_test.sh    デプロイ後の動作確認
  profile_pages.py ページごとの API の性能計測
.github/workflows/deploy.yml  main へのマージで AWS へ反映
.github/pull_request_template.md  PR 本文のテンプレート
.claude/settings.json  Claude Code のフック設定(ブランチ運用の検査)
.claude/hooks/guard-git.sh  git/gh 操作を検査するフック
.claude/skills/pr/   development 向け PR の作成・マージ手順(エージェント用)
docs/adr/          設計判断の記録
```

## 既知の制約

- 回転・せん断された埋め込み画像は透過マスク(SMask)が適用されません
- 入れ子の Form XObject 自体が回転している場合、画像の位置は正しいものの絵柄はフォームの回転を反映しません
- 再描画の文字は sans-serif で描くため、元のフォントとは字形・字幅が異なります
- フォント名の文字コードは UTF-8(BOM付きを含む)・UTF-16・Shift_JIS(cp932)・ASCII のみ判定します。1ページ内に異なる文字コードのフォント名が混在する場合や、GBK・Big5 等で書かれている場合は、誤った文字や `#82` 形式の表記になることがあります(ADR 0021)
- 部分埋め込みフォントで文字の対応情報(ToUnicode・フォント内の cmap)が削られている場合、何の文字かを復元できず「□」で表示されます(CID が元フォントのグリフ番号のため。元フォントがあれば復元できる見込みがあります: ADR 0018)
- 線数の多い大判図面では、ページの読み込みに数秒かかることがあります(A1 判・線約4.7万本のページで、手元の計測で約5秒。大半は pdfminer によるページの解析です)。キャッシュを持たないため、同じページを開き直すたびに抽出します
- 1ページだけで 4MB を超えるページ(大きな埋め込み画像を含むページなど)は処理できません(Lambda のリクエスト上限による)。PDF全体の大きさは問いません
- 暗号化されたPDFは開けません(pdf-lib が読み込めないため)
- 原本画像は、応答サイズの上限により要求より低い解像度になる場合があります(拡大時に粗く見えることがあります)
