# ADR 0043: サムネイルの読み込み中スピナーと、ページ解析中の擬似プログレスバー

- ステータス: 採用
- 日付: 2026-10-01

## コンテキスト

サムネイル一覧・本体ページの表示のどちらも、画像ができるまでの間は画面上の変化が乏しく、処理が進んでいるのか止まっているのか分かりにくい。

- サムネイル(`web/src/components/thumbnail-button.tsx`)は `<img src>` が `null` の間、何も表示しない空白のままだった([0041](0041-thumbnail-client-side-rendering.md) でブラウザ内ラスタライズに移した後も未対応)。
- 本体ページの解析(`/api/page/lines`、ページ切替のたびに1ページ分だけ送信・応答を受け取る)は、`state/state.ts` の `PageState.loading` が既にあったものの、どのUIからも参照されておらず、ツールバーの `StatusText` に「抽出中...」というテキストが出るだけだった。

このアプリの解析(線・文字・矩形・曲線の検出)はサーバー側で1回のAPI呼び出しの中で完結しており、途中経過(どの種類の検出が終わったか)をサーバーから逐次受け取る仕組みは無い。途中経過をサーバー側からストリーミングで返す設計に変えるのは、[0020](0020-send-only-needed-pages.md) で決めた「必要なページだけを送る」単純なリクエスト・レスポンス構成を崩す変更になり、今回の目的(体感の分かりやすさの改善)に対して割に合わない。

## 決定

- サムネイル: `ThumbEntry` に `loading: boolean` を追加し、ラスタライズ要求開始時(`thumbRequested` action)に立て、応答(`thumbsLoaded`)または失敗(`thumbUnavailable`)で下ろす。`ThumbnailButton` は `src` が `null` かつ `loading` の間だけ画像の上にスピナー(daisyUIの `loading loading-spinner`)を重ねる。
- 本体ページの解析: 実際の処理段階とは連動しない擬似的なプログレスバーを表示する。
  - 段階は `raster → text → line → curve → rect → 解析結果まとめ` の6段階(`domain/progress.ts` の `PROGRESS_STAGES`)。この順に自動で進める。
  - 進める速さの見積もりは、直近に完了したページの実測解析時間(`AppState.lastPageDurationMs`、`pageLoadSettled` で記録)に、インターネット越しの通信を見込んだ固定のオーバーヘッド(`NETWORK_OVERHEAD_MS`)を加えたものを使う。実測が無い初回は既定値(`DEFAULT_ESTIMATE_MS`)を使う。
  - 見積もり時間の90%を最初の5段階に均等に配分し、残り10%を最後の段階(解析結果まとめ)に割り当てる。見積もりを超えて実際の応答がまだ来ない場合は、最後の段階のまま全体比率99%で足踏みし、実際の応答が届いたら(`pageLoadSettled`)進捗表示を消す。
  - 進捗の計算(`computeProgress`)は経過時間と見積もり時間だけを引数に取る純粋関数とし、時刻の取得・タイマーの管理は `controllers/page.ts` の `showPage` が行う(reducerは純粋関数の規約を保つ)。

## 理由

- サーバー側の処理をストリーミング化せずに体感を改善できる。実装・運用コストに対して、途中経過が見えることによる「止まっていないと分かる」効果の方が大きい。
- 見積もりに直近の実測を使うことで、大きい・複雑なPDFほど遅くなるという実際の傾向をある程度反映できる。固定値だけを使うより「なかなか終わらない」と感じる場面が減る。
- 最後の段階で足踏みさせることで、見積もりを外れて実際の処理がそれより長くかかっても、進捗が100%を超えて止まる・逆戻りするような不自然な表示にならない。

## 影響

- `web/src/domain/progress.ts`(新規): `PROGRESS_STAGES`、見積もり時間の算出(`estimateDurationMs`)、経過時間から段階・比率を求める `computeProgress`。単体テスト `progress.test.ts` を追加。
- `web/src/state/state.ts`: `ThumbEntry.loading`、`PageState.progress`、`AppState.lastPageDurationMs` を追加。
- `web/src/state/actions.ts`: `thumbRequested`、`pageProgressTicked` を追加。`pageLoadSettled` に実測時間(`durationMs`)を追加。
- `web/src/state/reducer.ts`: 上記actionのハンドラを追加・変更。`reducer.test.ts` にケースを追加。
- `web/src/controllers/thumbnails.ts`: `loadOne` の開始時に `thumbRequested` をdispatch。
- `web/src/controllers/page.ts`: `showPage` で見積もり時間をもとにタイマーで `pageProgressTicked` をdispatchし、完了時に実測時間を `pageLoadSettled` に含める。
- `web/src/components/thumbnail-button.tsx`、`web/src/components/page-progress-bar.tsx`(新規)、`web/src/containers/page-progress-container.tsx`(新規): 表示側。
- `web/src/index.css`: daisyUIの `include` に `loading`、`progress` を追加(バンドルサイズ削減のため使う部品を明示的に絞る運用のため)。
