# ADR 0029: UI のビルド成果物はリポジトリに含めず、CI と Lambda 用 zip の組み立てでビルドする

- ステータス: 採用([0020](0020-send-only-needed-pages.md) の `static/vendor/` の同梱と `/vendor` の配信、[0021](0021-app-ci-deploys-code.md) の動作確認の `GET /vendor/pdf-lib.min.js` を置き換え)
- 日付: 2026-09-26

## コンテキスト

UI をビルドが必要な構成にした([0027](0027-frontend-react-typescript.md))ため、ビルド成果物の置き場所と、ローカル・Lambda・S3 の各配信先への届け方を決める必要がありました。旧構成では次の点が静的ファイルの配置に依存していました。

- FastAPI が `GET /` で `static/index.html` を返し、`static/vendor/` を `/vendor` にマウントしていた(`StaticFiles` は起動時にディレクトリの存在を確かめる)
- Lambda Web Adapter の起動確認が `GET /` の 200 で、zip に `index.html` が入っている必要がある(infra との約束事)
- デプロイは `aws s3 sync src/pdf_unit/static` で S3 に置き、動作確認で `GET /vendor/pdf-lib.min.js` を確かめていた
- `scripts/profile_pages.py` が `static/vendor/pdf-lib.min.js` を Node.js で読み込んでページを切り出していた

## 決定

- Vite の出力先は `src/pdf_unit/static/`(`index.html`・`assets/`(ファイル名にハッシュを含む)・`licenses.md`)とし、ディレクトリごと `.gitignore` に入れる。`base: "./"` で相対パス参照にし、`index.html` と `assets/` を並べればどこでも動くようにする
- サーバーは `/vendor` の代わりに `static/assets/` を `/assets` にマウントする(`check_dir=False`。ビルド前でも API は起動できる)。`GET /` は `index.html` が無ければ 503 とビルド手順を返す
- `scripts/build_lambda.sh` の先頭で `pnpm --dir web install --frozen-lockfile` と `pnpm --dir web build` を実行する。GitHub Actions の Deploy は pnpm(`web/package.json` の `packageManager`)と Node.js 24 を用意してからこのスクリプトを呼ぶ。S3 へ同期する場所は `src/pdf_unit/static` のままとする
- `scripts/smoke_test.sh` は `GET /` の `index.html` が参照する `assets/*.js`・`assets/*.css` を取り出して 200 を確かめる
- `scripts/profile_pages.py` は `web/node_modules/pdf-lib/dist/pdf-lib.min.js`(UI と同じ版)で切り出す。無ければ従来どおり pypdfium2 で切り出す
- 開発時は `pnpm --dir web dev`(Vite)を使い、`/api` を API サーバー(既定 `127.0.0.1:8765`、環境変数 `PDF_UNIT_API` で変更)へ中継する

## 理由

- 成果物をコミットすると差分が読めなくなり、ソースとの食い違いも起こりうる
- 出力先と S3 への同期元を変えなければ、infra(`pdf-unit.infra`)の変更は要らない。Lambda の約束事(Python の版・アーキテクチャ・`run.sh`・ポート・`GET /` の 200)も変わらない
- 開発サーバーの中継先の既定をユーザーが普段使う `127.0.0.1:8000` からずらし、動作確認で衝突しないようにした

## 影響

- 新しく clone した環境では、`uv run pdf-unit` の前に `pnpm --dir web install && pnpm --dir web build` が必要
- `aws s3 sync --delete` により、デプロイのたびに古いハッシュ名のファイルは消える。CloudFront の無効化の後に開いた画面は新しいファイルを参照する
- 動作確認の対象が `/vendor/pdf-lib.min.js` から `assets/` に変わった
