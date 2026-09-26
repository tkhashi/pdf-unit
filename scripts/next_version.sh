#!/usr/bin/env bash
# デプロイする版を決める(ADR 0033)。GitHub Actions の Deploy ワークフローが使う(手元でも確かめられる)。
#
#   scripts/next_version.sh <コミット> [ラベル(カンマ区切り)]
#
# 出力(GITHUB_OUTPUT にそのまま追記できる形式):
#   version=X.Y.Z          … デプロイする版(先頭の v は付けない)
#   create_release=true    … この版のタグとリリースを新しく作るか
#
# 版の正は Git のタグ(vX.Y.Z)。
#   - コミットにすでにタグがあれば(再デプロイなど)、その版をそのまま使い、リリースは作らない
#   - 無ければ最新のタグを起点に、main にマージされたリリース PR のラベルで上げる桁を決める
#       semver:major … 1桁目を上げる(ユーザーが判断したときだけ付ける)
#       semver:patch … 3桁目を上げる(機能の追加・変更がなく、軽微な修正だけのとき)
#       ラベルなし   … 2桁目を上げる(既定)
set -euo pipefail

commit="${1:?usage: next_version.sh <commit> [labels]}"
labels=",${2:-},"
pattern='v[0-9]*.[0-9]*.[0-9]*'

existing="$(git tag --points-at "$commit" -l "$pattern" --sort=-v:refname | head -n 1)"
if [[ -n "$existing" ]]; then
  echo "version=${existing#v}"
  echo "create_release=false"
  exit 0
fi

latest="$(git tag -l "$pattern" --sort=-v:refname | head -n 1)"
if [[ -z "$latest" ]]; then
  echo "起点となるタグ(vX.Y.Z)がありません。最初の版のタグを手で作ってください" >&2
  exit 1
fi

IFS=. read -r major minor patch <<<"${latest#v}"
if [[ "$labels" == *",semver:major,"* ]]; then
  major=$((major + 1)) minor=0 patch=0
elif [[ "$labels" == *",semver:patch,"* ]]; then
  patch=$((patch + 1))
else
  minor=$((minor + 1)) patch=0
fi
echo "version=$major.$minor.$patch"
echo "create_release=true"
