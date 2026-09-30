# ADR 0043: サムネイルの読み込み中スピナーと、ページ解析中の擬似プログレスバー

- ステータス: 採用
- 日付: 2026-10-01

## コンテキスト

サムネイル一覧・本体ページの表示のどちらも、画像ができるまでの間は画面上の変化が乏しく、処理が進んでいるのか止まっているのか分かりにくい。

- サムネイル(`web/src/components/thumbnail-button.tsx`)は `<img src>` が `null` の間、何も表示しない空白のままだった([0041](0041-thumbnail-client-side-rendering.md) でブラウザ内ラスタライズに移した後も未対応)。
- 本体ページの解析(`/api/page/lines`、ページ切替のたびに1ページ分だけ送信・応答を受け取る)は、`state/state.ts` の `PageState.loading` が既にあったものの、どのUIからも参照されておらず、ツールバーの `StatusText` に「抽出中...」というテキストが出るだけだった。

このアプリの解析(線・文字・矩形・曲線の検出)はサーバー側で1回のAPI呼び出しの中で完結しており、途中経過(どの種類の検出が終わったか)をサーバーから逐次受け取る仕組みは無い。途中経過をサーバー側からストリーミングで返す設計に変えるのは、[0020](0020-send-only-needed-pages.md) で決めた「必要なページだけを送る」単純なリクエスト・レスポンス構成を崩す変更になり、今回の目的(体感の分かりやすさの改善)に対して割に合わない。

最初にサムネイルのスピナーを「読み込み要求中(`thumbRequested`action)だけ立てる」形で実装したが、動作確認したところ、ローカルの小さいPDFではブラウザ内ラスタライズ(Web Workerとの往復)が1フレーム(~16ms)以内に終わることがあり、Reactが「読み込み中→完了」の2回の状態変化を同一フレームでコミットしてしまい、スピナーが一度も画面に描画されないことが分かった。同様に、最初のプログレスバー実装は、API応答受信直後の`pageLoadSettled`で進捗表示を即座に消してしまい、かつ進捗の仕様上100%まで到達しない設計だったため、「バーが途中で消える」という指摘を受けた。

## 決定

- サムネイル: 読み込み中を表す専用のフラグ・actionは持たない。`ThumbEntry.src` は文書を開いた時点で全ページ `null` に初期化されるため、コンポーネントは必ず一度はこの初期状態でマウント・ペイントされる。`ThumbnailButton` は `src === null && !unavailableTip` の間、画像の上にスピナー(daisyUIの `loading loading-spinner`)を重ねる。読み込みが速すぎて中間状態が見えない、という問題が構造的に起きない。
- 本体ページの解析: 実際の処理段階とは連動しない擬似的なプログレスバーを表示する。
  - 段階は `raster → text → line → curve → rect → 解析結果まとめ` の6段階(`domain/progress.ts` の `PROGRESS_STAGES`)。この順に自動で進める。
  - 見積もりは直近に完了したページの実測解析時間(`AppState.lastPageDurationMs`)を基準値とし、最初の5段階(raster〜rect)にはこの基準値の90%を均等配分する(通信オーバーヘッドは含めない)。残り10%と、インターネット越しの通信を見込んだ固定のオーバーヘッド(`NETWORK_OVERHEAD_MS`)はすべて最後の段階(解析結果まとめ)の見積もりに乗せる(`estimatePlan`が`{primaryMs, tailMs}`を返す)。実測が無い初回は既定値(`DEFAULT_ESTIMATE_MS`)を基準値に使う。
  - 見積もりを超えて実際の応答がまだ来ない場合は、最後の段階のまま全体比率99%で足踏みする。
  - 成功時は、実際にモデルが組み上がった(`pageLoaded`)時点で進捗を100%(`ratio:1`)に更新し、一瞬(`PROGRESS_HOLD_MS`)見せてから専用action(`pageProgressCleared`)で消す。失敗時(`pageFailed`)は100%を見せる意味が無いため即座に消す。API応答受信直後の`pageLoadSettled`は`loading`解除と実測時間の記録だけを行い、進捗表示には触れない。
  - 進捗の計算(`computeProgress`)は経過時間と見積もり計画(`primaryMs`・`tailMs`)だけを引数に取る純粋関数とし、時刻の取得・タイマー・遅延(`sleep`)の管理は `controllers/page.ts` の `showPage` が行う(reducerは純粋関数の規約を保つ)。
  - ステージ一覧はセグメント化した1本のバー(`PageProgressBar`)で表示し、各セグメントの表示幅は `STAGE_DISPLAY_WEIGHTS` という見た目専用の重みで決める。実際の時間配分(`primaryMs`/`tailMs`、通信オーバーヘッドで「解析結果まとめ」の実時間は伸びる)とは独立しており、「解析結果まとめ」は他の段階より狭く、`raster`は短め、`line`/`curve`/`rect`は長めに表示する。表示領域(`Viewport`)の横幅の80%を使う。

## 理由

- サーバー側の処理をストリーミング化せずに体感を改善できる。実装・運用コストに対して、途中経過が見えることによる「止まっていないと分かる」効果の方が大きい。
- サムネイルは「初期状態が既にスピナー」という設計にすることで、読み込みの速さに関わらず必ず一度は中間状態が描画される。dispatchのタイミングに依存する「最小表示時間」のような妥協を避けられる。
- 見積もりの基準値に直近の実測を使うことで、大きい・複雑なPDFほど遅くなるという実際の傾向をある程度反映できる。通信オーバーヘッドを「解析結果まとめ」だけに乗せるのは、実際のオーバーヘッドがサーバー処理そのもの(raster/text/line/curve/rectという名目上の段階)ではなく、応答を待つ最後の段階で体感されるものだから。
- 最後の段階で足踏みさせ、成功時は100%を明示的に見せてから消すことで、進捗が中途半端な比率のまま消えたり、100%を超えて見えたりする不自然な表示にならない。
- セグメント幅を実際の時間配分と切り離すことで、通信オーバーヘッドの増減が「解析結果まとめ」の見た目の長さに直結せず、UI上は常に「まとめ処理は短く終わる」という自然な印象を保てる。

## 影響

- `web/src/domain/progress.ts`(新規): `PROGRESS_STAGES`、見積もり計画の算出(`estimatePlan`)、経過時間から段階・比率を求める `computeProgress`、表示専用の重み `STAGE_DISPLAY_WEIGHTS`。単体テスト `progress.test.ts` を追加。
- `web/src/state/state.ts`: `PageState.progress`(`primaryMs`/`tailMs`/`ratio`/`stageIndex`)、`AppState.lastPageDurationMs` を追加。`ThumbEntry`に読み込み中フラグは追加しない。
- `web/src/state/actions.ts`: `pageProgressTicked`、`pageProgressCleared` を追加。`pageLoadSettled` に実測時間(`durationMs`)を追加。
- `web/src/state/reducer.ts`: 上記actionのハンドラを追加・変更。`pageLoadSettled`は進捗に触れない、`pageLoaded`で進捗を100%に、`pageFailed`で進捗を即座にクリア。`reducer.test.ts` にケースを追加。
- `web/src/controllers/page.ts`: `showPage` で見積もり計画をもとにタイマーで `pageProgressTicked` をdispatchし、`pageLoaded`後に`sleep`を挟んで`pageProgressCleared`をdispatch。
- `web/src/services/timing.ts`(新規): `sleep`。
- `web/src/components/thumbnail-button.tsx`、`web/src/components/page-progress-bar.tsx`(新規、セグメントバー)、`web/src/containers/page-progress-container.tsx`(新規): 表示側。
- `web/src/index.css`: daisyUIの `include` に `loading`、`progress` を追加(バンドルサイズ削減のため使う部品を明示的に絞る運用のため)。
