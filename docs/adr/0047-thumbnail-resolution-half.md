# ADR 0047: サムネイルのラスタライズ解像度を半分にする

- ステータス: 採用
- 日付: 2026-10-01

## コンテキスト

サムネイルは[0041](0041-thumbnail-client-side-rendering.md)でブラウザ内(pdf.js、専用Web Worker)でラスタライズするようにした。実際に描画するピクセル幅は、表示幅の定数 `THUMB_WIDTH=140px` に `devicePixelRatio()` を掛け、`THUMB_MAX_WIDTH=400px` を上限としたものを使っている(`web/src/controllers/thumbnails.ts`)。

高DPI環境(`devicePixelRatio` が2以上)では、この式により表示幅の2倍以上のピクセル幅でラスタライズすることになり、Workerでの描画・PNG化にかかる負荷や、生成されるbase64 PNGのデータ量(メモリ・IPC)が大きくなる。ユーザーから、サムネイルの生成サイズを半分にしたいという依頼があり、確認の結果、CSS上の表示サイズ(140px)は変えず、実際にラスタライズする解像度だけを下げる意図と分かった。

## 決定

`web/src/domain/constants.ts` に `THUMB_RESOLUTION_SCALE = 0.5` を追加し、`thumbnails.ts` の `thumbWidth()` で、既存の上限処理(`Math.min(THUMB_MAX_WIDTH, THUMB_WIDTH * devicePixelRatio())`)の結果に対してこの係数を掛ける。表示側(`thumbnail-button.tsx` の `w-[140px]` や `<img>` のwidth/height算出に使う `THUMB_WIDTH`)は変更しない。

## 理由

- 表示サイズ(CSS)は140px固定のままなので、解像度を下げても画面上の見た目への影響は小さい。
- 既存の上限(`THUMB_MAX_WIDTH`)のロジックはそのまま活かし、最終結果にだけ係数を掛けることで、「解像度だけを一律に半分にする」という意図をコードにそのまま表現できる。上限を直接半分にする(`THUMB_MAX_WIDTH`を200にする)案もあったが、それだと低DPI環境(元々上限に達しない環境)には効果が及ばず、意図(生成解像度全体を半分にする)とずれる。

## 影響

- 高DPI環境では、これまでよりわずかに粗いサムネイルになる(実質的に `devicePixelRatio` がこれまでの半分程度の解像度に近づく)。
- Worker側の描画負荷・生成するPNGのデータ量は、面積比でおおよそ1/4になる(幅・高さそれぞれ半分のため)。
