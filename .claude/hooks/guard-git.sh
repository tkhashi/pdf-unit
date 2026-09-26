#!/usr/bin/env bash
# Claude Code の PreToolUse(Bash)フック。ブランチ運用(README「開発の進め方」、ADR 0022)に反する
# git / gh 操作を実行前に止める。
#   deny: main・development への直接コミット・push、force push、命名規則に合わないブランチ作成
#   ask : main 向けの PR 作成・マージ、main 上での git merge(= 本番デプロイ。ユーザーの確認を挟む)
# 文字列の簡易判定なので、迂回を防ぐものではない。最終的な防衛線は GitHub のルールセット。
set -euo pipefail

BRANCH_PATTERN='^(feat|fix|docs)-[a-z0-9][a-z0-9-]*$'
PROTECTED='main|development'

input=$(cat)
command=$(jq -r '.tool_input.command // ""' <<<"$input")
cwd=$(jq -r '.cwd // ""' <<<"$input")
project_dir=${CLAUDE_PROJECT_DIR:-$cwd}

# git / gh を含まないコマンドは対象外
grep -qE '(^|[^[:alnum:]_-])(git|gh)[[:space:]]' <<<"$command" || exit 0

decide() {
  jq -n --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: $d, permissionDecisionReason: $r}}'
  exit 0
}

# コマンドが別ディレクトリ(cd / git -C)で動く場合はそこを対象にする。このリポジトリ以外は対象外
target_dir=$cwd
if [[ $command =~ (^|[;&|[:space:]])cd[[:space:]]+([^[:space:];&|]+) ]]; then
  target_dir=${BASH_REMATCH[2]}
elif [[ $command =~ git[[:space:]]+-C[[:space:]]+([^[:space:];&|]+) ]]; then
  target_dir=${BASH_REMATCH[1]}
fi
target_dir=${target_dir/#\~/$HOME}
[[ $target_dir = /* ]] || target_dir="$cwd/$target_dir"
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)
project_top=$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null || true)
[[ -n $target_top && $target_top = "$project_top" ]] || exit 0

current=$(git -C "$target_top" branch --show-current 2>/dev/null || true)
on_protected=false
[[ $current =~ ^($PROTECTED)$ ]] && on_protected=true

# 1. main・development への直接コミット
if $on_protected && grep -qE 'git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?commit' <<<"$command"; then
  decide deny "$current に直接コミットしない。development から feat-/fix-/docs- のブランチを作って作業する(CLAUDE.md「ブランチと PR」)"
fi

# 2. push
if push_args=$(grep -oE 'git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?push[^;&|]*' <<<"$command"); then
  if grep -qE '[[:space:]](--force|-f)([[:space:]]|$)' <<<"$push_args"; then
    decide deny "force push はしない。やむを得ずフィーチャーブランチを書き換えた場合は --force-with-lease を使う"
  fi
  if grep -qE "[[:space:]:+]($PROTECTED)([[:space:]]|$)" <<<"$push_args"; then
    decide deny "main・development に直接 push しない。PR でマージする(development は /pr、main はユーザーの指示時のみ)"
  fi
  # 宛先を省略した push は現在のブランチを送る
  if $on_protected && ! grep -qE 'push[[:space:]]+(-[^[:space:]]+[[:space:]]+)*[^-[:space:]][^[:space:]]*[[:space:]]+[^-[:space:]]' <<<"$push_args"; then
    decide deny "$current 上での push は $current への直接 push になる。フィーチャーブランチから PR を作る"
  fi
fi

# 3. ブランチ名
if [[ $command =~ git[[:space:]]+(checkout[[:space:]]+-[bB]|switch[[:space:]]+-[cC]|switch[[:space:]]+--create)[[:space:]]+([^[:space:];&|]+) ]]; then
  name=${BASH_REMATCH[2]}
  if [[ ! $name =~ $BRANCH_PATTERN ]]; then
    decide deny "ブランチ名 '$name' が命名規則に合わない。feat-/fix-/docs- + 英小文字・数字・ハイフンにする(例: feat-thumbnail-cache)"
  fi
fi

# 4. main 向けの PR 作成・マージ(本番デプロイになる)
if grep -qE 'gh[[:space:]]+pr[[:space:]]+create' <<<"$command" &&
  grep -qE "(--base|-B)[[:space:]=]+main([[:space:]]|$)" <<<"$command"; then
  decide ask "main 向けの PR を作成する。main へのマージは本番デプロイになるため、ユーザーの指示があるときのみ行う"
fi
if [[ $command =~ gh[[:space:]]+pr[[:space:]]+merge([[:space:]]+([^-[:space:];&|][^[:space:];&|]*))? ]]; then
  pr=${BASH_REMATCH[2]:-}
  base=$(cd "$target_top" && gh pr view ${pr:+"$pr"} --json baseRefName -q .baseRefName 2>/dev/null || echo unknown)
  if [[ $base != development ]]; then
    decide ask "PR の base が '$base'。main へのマージは本番デプロイになるため、ユーザーの指示があるときのみ行う"
  fi
fi
if [[ $current = main ]] && grep -qE 'git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?merge' <<<"$command"; then
  decide ask "main 上で git merge する。main への反映は本番デプロイになるため、ユーザーの指示があるときのみ行う"
fi

exit 0
