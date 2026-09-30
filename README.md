# PDF Unit

PDF(主に建築図面)を開くと、PDFium(pypdfium2)で検出した線・文字・埋め込み画像を種類別に色分けして再描画し、マウスオーバーやクリックで個々の要素や同じ属性を持つ要素群をハイライトできるWebアプリです。ローカルでも、AWS Lambda 上でも(ステートレスなサーバーとして)動作します。

検出結果が元のPDFとどれだけ一致しているかを目視で確かめる用途を想定しており、元のPDFを描画した「原本」画像を薄く下敷きにして重ねて表示します(検出されなかった要素は原本の灰色として見えます)。

設計判断の経緯は [docs/adr/](docs/adr/) を参照してください。

## 起動

```sh
uv sync
pnpm --dir web install   # UI の依存(初回と依存の変更時)
pnpm --dir web build     # UI をビルドして src/pdf_unit/static に出力
uv run pdf-unit
```

ブラウザで http://127.0.0.1:8000 を開き、PDFをドラッグ&ドロップするか「開く」から選択します。`uv run pdf-unit` はサーバーを `127.0.0.1` のみで待ち受けます。UI をビルドしていない場合、`GET /` はビルド手順を示す 503 を返します(API は動きます)。

必要なもの: Python 3.13 以上と uv、Node.js 24 以上と pnpm(版は `web/package.json` の `packageManager`)。

AWS では CloudFront → Lambda 関数URL(OAC)の構成で、AWS Lambda Web Adapter + `uvicorn pdf_unit.server:app` として実行します。静的ファイル(`index.html`・`assets/`・`licenses.md`)は S3 から配信します。

## 開発の進め方

ブランチは次の構成で運用します(ADR 0022)。

- `development`(既定ブランチ): 開発中の変更を集めるブランチ。直接コミット・push はせず、PR でのみ変更します
- `main`: 本番。`main` への反映はそのまま AWS へのデプロイになる(「デプロイ」参照)ため、手動で行うか、エージェントには明示的に指示したときのみ行わせます
- 作業ブランチ: `development` から作成し、名前は `feat-`(機能追加)・`fix-`(不具合修正)・`docs-`(文書のみ)に英小文字・数字・ハイフンの説明を続けます(例: `feat-thumbnail-cache`)。作業は `git worktree add ~/.claude/worktrees/pdf-unit-<ブランチ名> -b <ブランチ名> origin/development` で作った専用の作業ディレクトリで行い、主のチェックアウトでブランチを切り替えません

サーバー(Python)の変更は `uv run pytest` で確かめます(`tests/`。合成PDFで抽出結果・座標・エラー応答を検証します)。

作業が終わったら `development` 向けの PR を作り、squash マージします。`development` から `main` への反映は `gh pr create --base main --head development` で PR を作り、merge commit でマージします(squash すると両ブランチの履歴が分かれ、次回の反映で衝突しやすくなるため)。PR のタイトルはコミットと同じ形式(`feat:` 等 + 日本語)、本文は `.github/pull_request_template.md` に沿って日本語で簡潔に書きます。`development` 向けの PR には種別に応じたラベル(`feat` → `enhancement`、`fix` → `bug`、`docs` → `documentation`)を付けます(自動生成のリリースノートの分類に使います)。

### バージョン

版は `vX.Y.Z` 形式で、正は Git のタグです(ADR 0033)。`pyproject.toml`・`web/package.json` の `version` は使いません。

- `main` へのマージ(本番デプロイ)のたびに2桁目を上げます
- 機能の追加・変更がなく、バグ修正や UI のレイアウト調整のような軽微な変更だけのリリースでは、3桁目を上げます
- 1桁目は、よほど大きな変更があるときだけ上げます(判断はリポジトリの管理者が行います)

上げる桁は、リリース PR(`development` → `main`)のラベルで指定します。ラベルなしなら2桁目、`semver:patch` なら3桁目、`semver:major` なら1桁目です。リリース PR には、リリースノートの一覧から除くための `release` ラベルも付けます。

```sh
gh pr create --base main --head development --label release                       # 2桁目を上げる
gh pr create --base main --head development --label release --label semver:patch  # 3桁目を上げる
```

デプロイが成功すると、ワークフローがタグ `vX.Y.Z` と GitHub のリリースを作ります。リリースノートは GitHub の自動生成で、`.github/release.yml` の設定に従って PR のラベルごとに分類されます。画面のツールバーには、アプリ名の横に版が表示されます。手元のビルドでは `git describe --tags --always --dirty` の値になります。タグは `main` のマージコミットに付き、`development` 系のブランチからは辿れないため、通常はコミットのハッシュ(例: `va202736-dirty`)が表示されます。

### UI の開発

UI は `web/` 配下の React + TypeScript です(ADR 0027〜0031)。パッケージ管理は pnpm、バンドルは Vite、lint / format は Biome(ultracite のプリセット)、スタイルは Tailwind CSS + daisyUI です。

```sh
.venv/bin/uvicorn pdf_unit.server:app --port 8765   # API サーバー(開発サーバーの中継先。PDF_UNIT_API で変更可)
pnpm --dir web dev      # Vite の開発サーバー(/api を 127.0.0.1:8765 へ中継)
pnpm --dir web check    # 型検査(tsc)・lint(ultracite check)・単体テスト(Vitest)
pnpm --dir web fix      # 整形と自動修正(ultracite fix)
```

- 依存は `pnpm-workspace.yaml` の `minimumReleaseAge` により、公開から7日未満の版を入れません。依存を足すときは `--save-exact` で版を固定します
- 構成: `domain/`(純粋関数のロジック)・`state/`(Zustand の store と reducer)・`controllers/`(非同期処理と入力)・`render/`(Canvas の描画)・`services/`(API・pdf-lib)・`containers/`(store の購読)・`components/`(props だけの表示部品)。依存の向きと各層の役割は ADR 0028 を参照してください
- E2E(Playwright。事前に `pnpm --dir web e2e:build` と、上の API サーバーの起動が必要。初回は `pnpm --dir web exec playwright install chromium`):
  - `pnpm --dir web e2e` … 新UIの基本動作
  - `pnpm --dir web e2e:parity` … 旧UI(`BASE_REF`、既定 `7acb834`)との並走比較(ADR 0031)

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

1. `scripts/next_version.sh` で版を決める(最新のタグと、リリース PR のラベルから。コミットにすでにタグがあればその版)
2. pnpm と Node.js を用意し、`scripts/build_lambda.sh` で UI をビルドして(`src/pdf_unit/static`。版は環境変数 `APP_VERSION` で埋め込む)、Lambda 用の zip(`dist/lambda.zip`)を組み立てる
3. OIDC で AWS のロールを引き受ける(長期のアクセスキーは使いません)
4. `aws lambda update-function-code` で Lambda のコードを差し替え、反映を待つ
5. `aws s3 sync` で `src/pdf_unit/static` を S3 に置き、CloudFront のキャッシュを無効化する
6. `scripts/smoke_test.sh` で公開URLの動作を確認する(画面・画面が参照する `assets/`・API・リクエストと応答の gzip 圧縮・OAC)
7. 新しい版なら、タグ `vX.Y.Z` と GitHub のリリース(自動生成のリリースノート)を作る。デプロイに失敗した場合は作らないので、再実行すれば同じ版になります

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
scripts/build_lambda.sh                            # UI をビルドし、dist/lambda.zip を作る
scripts/smoke_test.sh --local http://127.0.0.1:8000  # uv run pdf-unit で起動したサーバーに対して確認
```

## 画面構成

- **ヘッダー(ツールバー)**: カテゴリごとに縦線で区切り、次の順に並びます。画面幅に収まらない場合は折り返します
  - アプリ名と版(例: `v0.2.0`、小さく表示) | 「開く」・開いているファイル名・「3 / 108 ページ」 | 表示切替(両方 / ベクター / ラスター のセグメントボタン) | 種類別の凡例(一括チェック、種類ごとの件数・表示切替) | 原本の濃さ | 線幅補正の係数 … `?`(操作説明、右端)
  - 各項目はマウスを乗せると約0.25秒で機能の補足を表示します。`?` はクリック(または Enter)で操作説明の表示を固定でき、もう一度クリックするか Esc で閉じます
  - ページの移動は左のサムネイル一覧から行います
- **左: サムネイル一覧**: 各ページを元PDFのまま縮小表示します。クリックでページを切り替え、現在のページは青枠で強調されます。一覧の右(図面との境目)に隣接する細長いボタン(`◀`/`▶`)で開閉します(閉じてもボタンは残ります)。描画がまだできていないページは、できるまでスピナーを表示します
- **中央: 図面表示領域**: 下から順に、原本画像(初期不透明度20%)、再描画(埋め込み画像・塗りつぶし・線・文字)、ハイライトを重ねて表示します。ページの解析中(切替直後〜応答を受け取るまで)は、上部に表示領域の横幅80%のプログレスバーを表示します。`raster → text → fill → line → curve → rect → 解析結果まとめ` の順に進む見た目上の演出で、実際の処理段階とは連動しません。進む速さは直近のページの実測解析時間をもとに見積もり、通信のオーバーヘッド分は最後の「解析結果まとめ」の見積もりにまとめて乗せます。見積もりを超えてもなかなか終わらない場合は最後の段階のまま進捗99%で足踏みし、実際の応答が届いたら一瞬100%まで進めてから消えます。各段階のセグメント幅は見た目だけの調整で、`raster`は短め、`fill`は`text`と同じ、`line`/`curve`/`rect`は長め、`解析結果まとめ`は最も短く表示します([ADR 0043](docs/adr/0043-loading-feedback-thumbnail-spinner-and-fake-progress.md)、[ADR 0045](docs/adr/0045-progress-fill-stage.md))
- **右下: 属性パネル**: ホバー中の要素(無ければ選択の起点要素)の属性を表示します

### 再描画の色

| 種類 | 色 | 抽出元 |
| --- | --- | --- |
| line | 青 | 1本の線分のパス |
| rect | 緑 | 軸に平行な閉じた四角形のパス |
| curve | 紫 | それ以外のパス(ベジェ曲線を保持) |
| fill | シアン(半透明。不透明度30%) | パスの塗りの範囲(本来の塗り色によらず種類の色で塗ります) |
| text | 橙 | 文字を単語単位にまとめたもの |
| image | 灰色の枠(中は原本画像を不透明で表示) | PDF に埋め込まれたラスター画像の配置範囲 |

ヘッダーの表示切替(セグメントボタン)で、両方 / ベクター(線・文字のみ) / ラスター(埋め込み画像のみ) のどれか1つを選べます。凡例のチェックボックスで種類ごとの表示/非表示も切り替えられ、凡例先頭の一括チェックで6種類をまとめて切り替えられます(全部表示中はチェック、一部だけ表示中は「−」、全部非表示は空。押すと、全部表示中なら全部非表示、それ以外なら全部表示)。非表示の要素はホバー・クリックの対象外です。

## 操作

- **ホイール**: カーソル位置を中心にズーム(0.1〜400倍)。ページ表示時とウィンドウサイズ変更時は自動で全体表示になります。拡大に応じて原本画像を高解像度(100/200/400dpi)で取り直します
- **ドラッグ**: 表示位置の移動
- **ホバー**: カーソルに最も近い線・塗りつぶし・文字・画像を赤でハイライトし、属性を右下に表示します
  - 線は「線の縁が画面上8px以内」のものを候補とし、その中で中心線が最もカーソルに近いものを選びます。0.06pt間隔の極細の格子のように、描画上は重なって見える線も拡大すれば1本ずつ選べます
  - 文字・画像は枠内でも線より優先度を下げています(文字や画像に重なる線を優先)
  - 塗りつぶしは塗りの範囲の内側(塗りの規則で穴になる部分は除く)と縁の近くで選ばれます。文字より優先度を下げているため、字の背景を白く塗った範囲では文字が選ばれます
- **クリック**: クリックした要素と同じ属性を持つ要素をすべて黄色の縁取りでハイライトし、他の要素を薄く表示します。同じ要素を続けてクリックすると、判定に使う属性が次へ切り替わります
  - 線: 種類 → 線幅 → 長さ(lineのみ) / 形状(curveのみ) → 描画太さ → 色 → 濃淡 → 解除
  - 塗りつぶし: 種類 → 線幅 → 色 → 濃淡 → 解除
  - 文字: 種類 → フォント → サイズ → 色 → 濃淡 → 解除
  - 画像: 種類 → 画素数 → 解像度 → 圧縮形式 → 解除
  - それまでに表示した集合と同じ結果になる属性は飛ばします
  - 現在の属性は属性パネルの該当行が黄色になり、件数が表示されます
- **Esc** または何もない所をクリック: 選択解除

### 属性の定義

- **線幅**: PDF の線幅(`w`)に描画時の座標変換の拡大率を掛けた、ページ上の太さ(pt)。塗りつぶしでは、塗るときに設定されていた線幅を同じ方法で換算した値です。塗りつぶしは線を描かないので、この太さの線は描かれません
- **描画太さ**: 実際に描画される太さ(線幅 × 線幅補正係数)。補正係数は原本画像から孤立した直線の太さを実測して自動算出します。塗りつぶしにはありません
- **長さ**: line の長さ(pt、0.01pt単位で一致判定)
- **形状**: 回転・反転・一様な拡大縮小・平行移動を許容した同一形状(相似形)。X/Yで倍率が異なる変形は別形状として扱います
- **色**: 線は描画色、塗りつぶしと文字は塗り色(CSS の `rgb()` 表記で完全一致)
- **濃淡**: 色の輝度から求めた濃度(0%=白〜100%=黒)を5%刻みで一致判定
- **フォント / サイズ**: フォント名(BaseFont) / 文字の高さ(pt)
- **画素数 / 解像度 / 圧縮形式**: 埋め込み画像の元の画素数 / ページ上での実効dpi / PDFのフィルタ(`DCTDecode` 等)

## 抽出処理の仕様

PDF の読み取りは PDFium(pypdfium2)で行います。抽出処理は、PDFium から pdfplumber の Page と同じ形に組み立てたデータ(`src/pdf_unit/pdfium_page.py`)を読みます(ADR 0038)。

- **座標系**: ページの表示範囲(CropBox と MediaBox の交わり。PDFium の描画範囲と同じ)の左上を原点とし、ページ回転 `/Rotate` を反映した pt に統一しています。線・文字・埋め込み画像・原本画像はすべてこの座標系で一致します。PDFium の API が返す float32 の値は「float32 として同じ値になる最短の10進数」に戻してから計算し、PDF に書かれた数値(有効数字7桁まで)を再現します
- **図形**: パスをサブパスごとに分け、線分1本(`m l`)は line、軸に平行な閉じた四角形は rect、それ以外は curve とします(pdfminer.six と同じ規則)。`v`/`y` 演算子の曲線もベジェとして保持します。線幅は描画時の座標変換の拡大率を掛けた太さ、色は PDFium が色空間(Separation・ICC 等を含む)を RGB に変換した値です
- **塗りつぶし**: 塗るパス(`f`・`f*`・`B`・`b` 等)の塗りの範囲を、パスごとに1件の fill とします。塗りの規則(非ゼロ回転数 / 偶奇)はパス全体にかかるので、サブパスには分けません。塗るだけで線を描かないパス(`f`・`f*`)は line・rect・curve にせず、線幅補正の実測にも使いません。線と塗りの両方を行うパス(`B` 等)は、線(line・rect・curve)と fill の両方になります([ADR 0044](docs/adr/0044-fill-regions.md))。塗りにクリップパス(`W`・`W*`。外側の Form XObject に掛かるものを含む)が掛かっている場合は、原本と同じくクリップの内側だけを塗り、ホバーもクリップの内側だけで選ばれます。属性パネルには「クリップ: あり」と表示します。bbox はクリップする前の範囲です([ADR 0046](docs/adr/0046-fill-clip-paths.md))
- **線幅補正**: 線幅が実際の描画太さと一致しないPDFに備え、原本画像での実測値との比を補正係数として使います(ClassifierArchDrawingByJev の `calibration.py` を移植)。実測に使うのはほかの図形と重ならない孤立した直線で、孤立の判定は格子状の空間索引で近くの図形だけを調べます(結果は総当たりと同じ。[ADR 0025](docs/adr/0025-calibration-spatial-index.md))。ヘッダーには「線幅補正 ×0.18」のように係数を表示し、算出できなかった場合(補正なし)は「線幅補正 -」と表示します。算出方法はマウスオーバーで補足します
- **文字**:
  - 単語単位にまとめ、フォント・サイズ・色が変わる箇所で区切ります(pdfplumber の `extract_words` を `src/pdf_unit/_vendor/` に取り込んで使っています)
  - 描画位置・回転は文字の変換行列から、描画サイズはフォントサイズ(外接矩形・送り幅・行列から逆算)と行列の縦倍率から求めます。横倍率(`Tz`)も反映します
  - 本文の文字コードは、フォントの Encoding(CMap)と ToUnicode に従って PDFium が解釈します。文字コードの推測は行いません
  - ToUnicode が無く Unicode に引けない文字は、フォント単位で判定して「□」で表示し、属性パネルに「読めない文字: N字」と表示します。フォント内の文字の9割以上がよく使われる文字(かな・漢字・英数字・記号等)の範囲に収まらない場合、そのフォントの文字をすべて読めないとみなします(ADR 0038)
- **フォント名の文字コード**: PDF のフォント名は文字コードの宣言を持たないバイト列のため、ページ単位で自動判定します([ADR 0021](docs/adr/0021-font-name-encoding-per-page.md))。1ページの中で使われる文字コードは1種類と仮定しています
  1. ASCII だけの名前はそのまま表示する
  2. BOM(UTF-8 / UTF-16BE / UTF-16LE)がある名前はそれに従う
  3. それ以外の名前は、ページ内のすべてを UTF-8 → BOM無し UTF-16(0x00 を含む偶数長の名前ばかりの場合)→ Shift_JIS(cp932)の順に試し、すべてを読める最初の文字コードを使う。制御文字・私用領域の文字が出る場合は読めなかったとみなす
  4. どれでも読めない場合は推測せず、PDF の名前表記(`#82l#82r…`)で表示する
- **埋め込み画像**:
  - Form XObject 内の画像も含めて抽出します。PDF 内で1枚の絵が複数の画像(帯状など)に分けて保存されている場合は、分かれたまま1つずつ扱います
  - 画像データは取得せず、`/api/page/lines` が返す配置範囲(四隅)に枠を描きます。枠の中は、原本画像の濃さの設定によらず原本画像を不透明で表示するので、絵柄はそのまま見えます([ADR 0039](docs/adr/0039-embedded-images-as-outlines.md))
- **サムネイル**: 線検出を行わず、ブラウザ内([pdf.js](https://mozilla.github.io/pdf.js/)、専用の Web Worker)で元PDFを出力幅140px前後に縮小描画したものです([ADR 0041](docs/adr/0041-thumbnail-client-side-rendering.md))。サーバーへは送らず、本体ページの読み込みも待ちません。文書を開いた直後から全ページを1ページずつ背景で先読みし(Worker内は常に1ページずつ処理し、描き終えたページの pdf.js の資源はすぐに捨てます。[ADR 0047](docs/adr/0047-thumbnail-worker-page-cleanup.md))、`IntersectionObserver` で表示範囲に入ったページは先読みの順番を追い越して先に描画します([ADR 0042](docs/adr/0042-thumbnail-prefetch-all-pages.md))。先読みの途中で別の文書を開くと、前の文書の残りの先読みは取りやめ、前の文書をメモリから解放します([ADR 0048](docs/adr/0048-thumbnail-close-answers-dropped-jobs.md))。描画に失敗したページは「表示できません」表示にします。描画できるまでの間はスピナーを表示します([ADR 0043](docs/adr/0043-loading-feedback-thumbnail-spinner-and-fake-progress.md))

## API

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/` | UI(ビルドした `static/index.html`。未ビルドなら 503) |
| POST | `/api/page/lines` | 抽出結果。`{page: {width, height}, linewidth_scale, calibration, lines, fills, clip_paths, texts, images}`。`fills` の各要素は `{id, type: "fill", d, polylines, fill_rule, linewidth, color, bbox, clip}`(`fill_rule` は `nonzero` / `evenodd`、`color` は塗り色、`clip` は掛かるクリップの `clip_paths` の添字。塗られるのはすべてのクリップとの共通部分)。`clip_paths` の各要素は `{d, polylines}`(表示座標。同じクリップは1つにまとめる) |
| POST | `/api/page/image?resolution=` | 原本画像(36〜600dpi)。`{resolution, png_base64}`(`resolution` は実際の解像度) |
| GET | `/assets/*` | UI のスクリプト・スタイル(`static/assets/` を配信。`index.html` からは相対パス `assets/` で参照。ファイル名にハッシュを含む) |
| GET | `/licenses.md` | UI に同梱したライブラリ(pdf-lib・React 等)のライセンス(ビルド時に生成) |

サーバーはステートレスで、PDFを保存せず、キャッシュも持ちません。`GET` 以外のAPIはすべて POST で、リクエストボディにPDFの生バイト列(`Content-Type: application/pdf`)を送ります。UIは開いたPDFをブラウザ上に保持し、[pdf-lib](https://github.com/Hopding/pdf-lib) で**必要な1ページだけを切り出したPDF**を送ります。サーバーは送られたPDFの先頭ページを処理します(ADR 0019, 0020)。ページの寸法(一覧の枠・図面の枠)は UI が pdf-lib で求め、`/api/page/lines` の `page` で答え合わせします。サムネイルはサーバーへ送らず、ブラウザ内(pdf.js)で描画します(ADR 0041)。

- ボディのSHA-256(16進)を `x-amz-content-sha256` ヘッダーに付けます。CloudFront の OAC 経由で Lambda 関数URLへ POST する場合に必須です(ローカルのサーバーは検証しません)。UIは切り出したPDFごとに計算し、1ページ分の切り出し結果は直近6ページ分を使い回します
- 1回に送るPDF(切り出したページ)の上限は 4MB(4 × 1024 × 1024 バイト)です。PDF全体の大きさには上限がありません。UIは超過するページを送らずにエラーを表示し、サーバーは超過時に 413 を返します。ボディが `%PDF` で始まらない場合は 400 を返します
- ボディは `Content-Encoding: gzip` で圧縮して送ることもできます(ADR 0034)。上限の 4MB は送る(圧縮後の)大きさにかかり、展開後は 64MB まで受け付けます(超えると 413、壊れた gzip は 400、gzip 以外の圧縮形式は 415)。`x-amz-content-sha256` は圧縮後のボディで計算します。応答は圧縮なしで送った場合と同じです。UI はまだ圧縮して送っていません(Issue #8)
- 画像はPNGのbase64文字列としてJSONで返します。base64が 5.5MB を超える場合、原本画像は解像度を下げて描き直します(Lambda のレスポンス上限 6MB に収めるため)
- `Accept-Encoding: gzip` を付けたリクエストには、応答を gzip(圧縮レベル4)で圧縮して返します(ブラウザは自動で付け、自動で展開します)。線数の多いページの抽出結果は JSON で6MBを超えることがありますが、圧縮すると1/6前後になり Lambda の上限に収まります(ADR 0024)。CloudFront を通しても圧縮が効いていることは `scripts/smoke_test.sh` で確かめます
- PDFium で開けないPDF(途中で切れている、ページツリーが壊れている等)は 400、ページ・画像番号が範囲外の場合は 404 を返します
- ページや文書を切り替えると、UI は前のページの線データ・原本画像の要求を取り消します(`AbortController`。ADR 0039)
- `/api/*` の応答には、処理区間ごとの所要時間を示す `Server-Timing` ヘッダーと、件数などを JSON で示す `X-Perf-Metrics` ヘッダーが付きます(「性能の計測」参照)

## 性能の計測

高速化は、計測で支配的と分かった箇所から、出力(応答ボディ)が変わらない範囲で行います([ADR 0023](docs/adr/0023-performance-measurement.md))。pdfplumber から PDFium への移行は、出力の変化を受け入れた例外です([ADR 0038](docs/adr/0038-migrate-to-pypdfium2.md))。計測の仕組みは次の4つです。

- **`Server-Timing` / `X-Perf-Metrics` ヘッダー**: 区間の所要時間(ミリ秒)と件数です。区間名の `.` は内訳を表し(`calib.render` は `calib` の内訳)、`.` を含まない区間の合計がその API の処理時間の目安になります。`lock_wait` は PDFium のロック待ちの時間です
  - `/api/page/lines`: `open`(PDFを開く)・`parse`(PDFium による図形・文字の読み取り。内訳 `parse.paths`・`parse.chars`)・`vectors`(線のレコード作成)・`calib`(線幅補正。内訳 `calib.select`・`calib.render`・`calib.measure`)・`texts`(文字。内訳 `texts.unreadable`・`texts.words`・`texts.fonts`・`texts.records`)・`images`(埋め込み画像の配置。内訳 `images.decode`)。すべて PDFium のロック内で処理します
  - `/api/page/image`: `open`・`render`・`png`・`b64`
- **サーバーのログ**: API リクエストごとに1行の JSON を標準出力に書きます。項目は `perf`(パス)・`query`・`status`・`cold`(プロセス最初のリクエストか)・`total_ms`(ボディ受信・JSON 直列化を含む全体)・`req_bytes`・`resp_bytes`(圧縮後の転送される大きさ)・`stages_ms`・`metrics`・`maxrss_mb`(プロセス開始以来の最大メモリ)・`rss_mb`(現在のメモリ。Linux のみ)です。Lambda では CloudWatch Logs Insights で集計できます
- **ブラウザのコンソール**: `console.debug`(DevTools の Console で Verbose を有効にすると表示)に、API 呼び出しごとの所要時間・送受信サイズ・`Server-Timing`、ページ切り出しの時間、ページ切替からの経過(線データ受信・描画準備完了・初回描画完了・原本画像表示)を出します
- **`scripts/profile_pages.py`**: PDF のページごとに各 API を計測し、呼び出しごと・区間ごとの集計、応答サイズとピークメモリの最大を表示します。ブラウザと同じく `Accept-Encoding: gzip` を付けて送り、応答の大きさは展開後(`resp_bytes`)・転送される大きさ(`wire_bytes`)・Lambda の上限と比べる大きさの推定(`lambda_bytes`。圧縮した応答は Lambda Web Adapter が base64 化するため4/3倍)を記録します

```sh
uv run python scripts/profile_pages.py 図面.pdf --pages 1-5 --out result.jsonl
uv run python scripts/profile_pages.py 図面.pdf --pages 3 --dump out/after   # 応答ボディを保存(変更前後を cmp で比較)
uv run python scripts/profile_pages.py 図面.pdf --pages 3 --cprofile prof   # cProfile を保存(時間の計測とは別に実行)
```

- 1回の API 呼び出しごとに子プロセスを起動し、ASGI アプリに直接 POST します(Depends・JSON 直列化・ミドルウェアを含む実際の経路)。子プロセスの最大メモリを、その呼び出しのピークメモリとみなします
- ページの切り出しは UI と同じ pdf-lib(`web/node_modules/pdf-lib`。`pnpm --dir web install` で入ります)を Node.js で動かして行います。Node.js か pdf-lib が無い場合は pypdfium2 で切り出しますが、UI が送るバイト列とは異なるため、計測値の比較には注意してください
- 計測する API は `--endpoints`(既定 `lines,image`)、原本画像の解像度は `--resolutions`(既定 `100,200,400`、UI と同じ)で指定します
- 手元(Apple Silicon)の計測値は Lambda(arm64、2048MB で約1.2 vCPU 相当)より速く出ます。区間の比率や、画素数・件数に対する伸び方を見る用途に使ってください

### 変更前後の応答の比較

`scripts/compare_dumps.py` は、`profile_pages.py --dump` で保存した2つのディレクトリを突き合わせます。原本画像・埋め込み画像はバイト単位で、線データは要素ごとのキー単位の不一致件数と数値の最大差で比べます。テキストは並び順や単語の分割の違いに影響されないよう、文字は原点の位置、単語は文字列と先頭の文字の原点で対応づけます。

```sh
uv run python scripts/profile_pages.py 図面.pdf --pages 1-5 --splitter pdflib --dump out/before --out out/before.jsonl
# (変更後に同じ条件で out/after を取る)
uv run python scripts/compare_dumps.py out/before out/after --jsonl out/before.jsonl out/after.jsonl
```

## ファイル構成

```
src/pdf_unit/
  server.py        FastAPIアプリ(ステートレス)、API、PDF検証、応答サイズ調整、PDFium直列化ロック
  pdfium_page.py   PDFium から図形・文字を読み、pdfplumber と同じ形の dict にする。ページの描画
  extract.py       線・文字のレコード作成、読めないフォントの判定、フォント名の文字コード判定、フォントサイズ逆算
  raster.py        埋め込み画像の抽出(PDFium)、座標変換
  calibration.py   線幅補正(ClassifierArchDrawingByJev から移植)
  timing.py        性能計測(処理区間の所要時間・件数の収集)
  _vendor/pdfplumber/  pdfplumber 0.11.10 の extract_words と依存部分(MIT、LICENSE.txt。変更せずに取り込み)
  static/          UI のビルド成果物(pnpm --dir web build が出力。リポジトリには含めない)
web/               UI(React + TypeScript、pnpm・Vite・Biome/ultracite・Tailwind CSS・daisyUI)
  src/domain/      純粋関数のロジック(ヒット判定・形状比較・選択・属性パネル・表示変換・文言)
  src/state/       状態(Zustand の store と純粋関数の reducer)
  src/controllers/ 非同期処理と入力(文書・ページ・原本画像・サムネイル・表示領域の操作・ツールチップ)
  src/render/      Canvas の描画(store を購読して1フレームに1回描く)
  src/services/    API 呼び出し・pdf-lib(ページの切り出し)・サムネイル描画(pdf.js の Worker ラッパー)・計測ログ・表示設定の保存
  src/workers/     サムネイルのラスタライズ(pdf.js を動かす専用 Web Worker。ADR 0041)
  src/containers/  store を購読して components へ props を渡す
  src/components/  props だけを受け取る表示部品
  e2e/             Playwright(合成PDFの生成、新UIの基本動作、旧UIとの並走比較)
scripts/
  build_lambda.sh  Lambda 用 zip の組み立て(CI と手元で共用)
  smoke_test.sh    デプロイ後の動作確認
  profile_pages.py ページごとの API の性能計測
  compare_dumps.py profile_pages.py で保存した変更前後の応答の比較
  next_version.sh  デプロイする版の決定(タグとリリース PR のラベルから)
.github/workflows/deploy.yml  main へのマージで AWS へ反映し、版のタグとリリースを作る
.github/release.yml  自動生成のリリースノートの分類
.github/pull_request_template.md  PR 本文のテンプレート
.claude/settings.json  Claude Code のフック設定(ブランチ運用の検査)
.claude/hooks/guard-git.sh  git/gh 操作を検査するフック
.claude/skills/pr/   development 向け PR の作成・マージ手順(エージェント用)
tests/             サーバーのテスト(pytest。合成PDFは tests/fixtures.py)
docs/adr/          設計判断の記録
```

## 既知の制約

- 再描画の文字は sans-serif で描くため、元のフォントとは字形・字幅が異なります
- フォント名の文字コードは UTF-8(BOM付きを含む)・UTF-16・Shift_JIS(cp932)・ASCII のみ判定します。1ページ内に異なる文字コードのフォント名が混在する場合や、GBK・Big5 等で書かれている場合は、誤った文字や `#82` 形式の表記になることがあります(ADR 0021)
- 部分埋め込みフォントで文字の対応情報(ToUnicode・フォント内の cmap)が削られている場合、何の文字かを復元できず「□」で表示されます(CID が元フォントのグリフ番号のため。元フォントがあれば復元できる見込みがあります: ADR 0018)
- 線数の多い大判図面では、ページの読み込みに1秒以上かかることがあります(A1 判・線約4.7万本のページで、手元の計測で約1.6秒。PDFium による図形の読み取りと、線のレコード作成が大半です)。キャッシュを持たないため、同じページを開き直すたびに抽出します
- UTF-8 の CMap(`UniJIS-UTF8-H` 等)で符号化された本文は PDFium が解釈できず、「□」(読めない文字)として表示されます。UTF-32 の CMap(`UniJIS-UTF32-H`)の本文は文字は正しいものの、1文字ずつ別の単語になります(ADR 0038)
- ToUnicode の無いフォントの判定は、フォント内の文字の分布による近似です。ToUnicode があっても珍しい文字ばかりのフォントは、読めない文字(「□」)と判定されることがあります(ADR 0038)
- 同じ文字を少しずらして2回描く太字表現は、PDFium が1文字にまとめます
- 有効数字8桁以上で書かれた座標は、PDFium の API が float32 のため元の値を復元できず、10万分の1pt 程度ずれることがあります
- 1ページだけで 4MB を超えるページ(大きな埋め込み画像や、小さな画像を大量に含むページなど)は処理できません(Lambda のリクエスト上限による)。PDF全体の大きさは問いません。サーバーは gzip で圧縮したリクエストを受け付けるので、UI が圧縮して送るようになれば、圧縮後に 4MB に収まるページは処理できるようになります(Issue #8)
- 暗号化されたPDFは開けません(pdf-lib が読み込めないため)。エラーは「暗号化されたPDFは開けません」ではなく「PDFを読み込めません(…encrypted…)」と表示されます(pdf-lib のエラーの種類を判定できないため。ADR 0031)
- 最初に文書を開くとき、ステータス欄は文書を開くまで表示されないため、「読み込み中...」や読み込みエラーは画面に出ません(2つ目以降の文書では表示されます)
- 同じファイルを続けて「開く」から選び直しても反応しません。図面表示領域の外へPDFをドロップすると、ブラウザがそのPDFを開きます
- 原本画像は、応答サイズの上限により要求より低い解像度になる場合があります(拡大時に粗く見えることがあります)
- クリップを考慮するのは塗りつぶし(fill)だけです。線(line・rect・curve)は、クリップの外にはみ出す部分も表示します。また、PDFium はクリップの塗りの規則(`W` と `W*`)を返さないため、すべて非ゼロ回転数とみなします。文字によるクリップ(文字の描画モード 4〜7)は考慮しません(ADR 0046)
- グラデーションを多数の塗りの重ね塗りで表したPDFでは、半透明の塗りが重なって濃く表示されます
