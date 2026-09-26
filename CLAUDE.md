# プロジェクト固有の進め方

## 設計判断の記録

実装に影響する設計判断(技術選定、アルゴリズムの選択、表示方式の変更、不具合の根本原因に対する対処方針など)を行うたびに、ユーザーから明示的に依頼されなくても以下の2つを必ず更新する。

1. **ADR追加**: `docs/adr/` 配下に、設計判断ごとに1ファイル(`NNNN-短い説明.md`、連番は既存ファイルの続き)を新規作成する
   - 各ADRには最低限「ステータス」「日付」「コンテキスト(なぜこの判断が必要だったか。ぶつかった障壁や原因調査の結果を含む)」「決定」「理由」「影響」を書く
   - 既存のADRを上書き・削除しない。決定が覆った場合は新しいADRを追加し、新旧双方にその旨を記載する(過去の決定が「なぜそうしたか」を追える状態を保つ)
   - 実装していない提案は「ステータス: 提案」として記録してよい。実装したら新しいADRで採用を記録する
2. **README更新**: `README.md` は仕様書を兼ねる。その時点の実装の実態(画面・操作・属性の定義・API・既知の制約)に合わせて更新する

## ドキュメントの文体

`README.md` と `docs/` 配下のMarkdownは通常の丁寧な日本語で記述する(原始人モード等の圧縮口調は適用しない)。

## ブランチと PR

- 作業を始めるときは `development` から `feat-`/`fix-`/`docs-` + 英小文字・数字・ハイフンの名前でブランチを作る(例: `feat-thumbnail-cache`)。`main`・`development` に直接コミット・push しない
- 作業が終わったら `/pr` skill(`.claude/skills/pr/SKILL.md`)で `development` 向けの PR を作成し、squash マージする
- `main` へのマージは本番デプロイになる。ユーザーが明示的に指示したときのみ、`gh pr create --base main --head development` → `gh pr merge --merge` で行う
- PR のタイトルはコミットと同じ形式(`feat:` 等 + 日本語)、本文は `.github/pull_request_template.md` に沿って日本語で簡潔に書く
- `.claude/hooks/guard-git.sh` がこれらに反する操作を拒否・確認する。フックに止められたら迂回せず、ルールに沿ったやり方に直す(README「開発の進め方」、ADR 0022)

## 開発時の注意

- PDFium(pypdfium2、pdfplumber の `page.to_image` を含む)はスレッドセーフではない。PDFium を使う処理を追加する場合は必ず `server.py` の `_pdfium_lock` の中で行う(ADR 0011)
- 高速化は精度より優先しない。座標の丸め・非可逆な画像形式・結果が変わりうるキャッシュなど出力が変わる手段は採らず、`scripts/profile_pages.py` で計測してから着手し、`--dump` で変更前後の応答ボディが一致することを確かめる(ADR 0023)
- 座標は pdfplumber の表示座標(左上原点、pt、ページ回転反映後)に統一する。PDFium から得た座標は `FPDF_PageToDevice` で変換する(ADR 0010)
- Lambda の実行環境に関わる値(Python の版・アーキテクチャ・zip 直下の `run.sh`・待ち受けポート・`GET /` の起動確認)は `pdf-unit.infra` の Lambda 定義との約束事。`scripts/build_lambda.sh` でこれらを変える場合は、infra 側も合わせて変更する(README「infra との約束事」、ADR 0021)
- 動作確認でサーバーを起動するときは、ユーザーが使っている `127.0.0.1:8000` と衝突しないよう別ポート(例: `.venv/bin/uvicorn pdf_unit.server:app --port 8765`)を使い、停止は自分が起動したプロセスの PID を指定して行う(`pkill -f` で名前一致させると、ユーザーのサーバーまで止めてしまう)
