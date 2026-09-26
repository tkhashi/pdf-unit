---
name: pr
description: 作業ブランチ(feat-/fix-/docs-)の変更から development 向けの PR を日本語で作成し、squash マージする。作業が完了して development に取り込むときに使う。main 向けの PR には使わない。
---

# development 向け PR の作成とマージ

ブランチ運用は README「開発の進め方」と ADR 0022 を参照。この手順は development への取り込み専用で、main(本番デプロイ)向けの PR は作らない。

## 1. 事前確認

- `git branch --show-current` が `feat-`/`fix-`/`docs-` で始まること(main・development 上なら中止してユーザーに伝える)
- `git status --short` が空であること(未コミットの変更があればコミットするか、ユーザーに確認する)
- 設計判断を含む変更なら、ADR の追加と README の更新が含まれていること(CLAUDE.md「設計判断の記録」)

## 2. development の最新を取り込む

```sh
git fetch origin
git rebase origin/development
```

衝突した場合は解消してから続ける。解消方針が自明でなければユーザーに確認する。

テストがあれば実行する(例: `uv run pytest`)。UI・API を変えた場合は CLAUDE.md の手順(ポート 8765、PID 指定で停止)で動作確認する。

## 3. push

```sh
git push -u origin HEAD
```

rebase で既に push 済みの履歴を書き換えた場合は `git push --force-with-lease`(`--force` はフックで拒否される)。

## 4. PR の作成

1. `.github/pull_request_template.md` を読む
2. `git log --oneline origin/development..HEAD` と `git diff --stat origin/development...HEAD` から変更を把握し、テンプレートの各節を日本語で簡潔に埋める
   - タイトルはコミットと同じ形式(`feat:`/`fix:`/`docs:` + 日本語。squash マージのコミットメッセージになる)
   - 概要は1〜3行。変更点は利用者・仕様から見た変化を優先し、ファイルの羅列にしない
   - 確認方法には実際に実行したものだけを書く
   - HTML コメント(`<!-- -->`)は消す
   - 末尾に `🤖 Generated with [Claude Code](https://claude.com/claude-code)` を付ける
3. 本文をスクラッチディレクトリのファイルに書き、作成する

```sh
gh pr create --base development --title "<種別>: <日本語の簡潔なタイトル>" --body-file <本文ファイル>
```

## 5. マージ

```sh
gh pr merge --squash --delete-branch
git switch development
git pull --ff-only
```

マージ後、PR の URL をユーザーに伝える。main への反映(本番デプロイ)はユーザーの指示を待つ。
