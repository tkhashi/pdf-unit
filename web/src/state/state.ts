// 画面の状態。すべて読み取り専用で、変更は reducer が新しいオブジェクトを返して行う
import { DEFAULT_RASTER_OPACITY } from "../domain/constants";
import type { TypeCounts } from "../domain/items";
import { plainStatus, type StatusText } from "../domain/messages";
import { EMPTY_PAGE_MODEL, type PageModel } from "../domain/page-model";
import type { Selection } from "../domain/selection";
import type { PageSize } from "../domain/types";
import { INITIAL_VIEW, type View } from "../domain/view";
import type { Visibility } from "../domain/visibility";

/** 開いている文書(PDF本体はブラウザ側で services が保持し、ここでは識別子だけを持つ) */
export interface DocState {
  readonly filename: string;
  /** 文書を開くたびに変わる番号。古い文書への応答を捨てるのに使う */
  readonly id: number;
  /** ページの寸法(pdf-lib で求め、線データの応答と食い違えばサーバーの値に合わせる) */
  readonly pages: readonly PageSize[];
}

/** 解析中の擬似プログレスバーの表示状態(実際の処理段階とは連動しない) */
export interface PageProgress {
  /** 最初の6段階に均等配分する合計見積もり時間(ms)。通信オーバーヘッドは含まない */
  readonly primaryMs: number;
  readonly ratio: number;
  readonly stageIndex: number;
  /** 最後の段階(解析結果まとめ)の見積もり時間(ms)。通信オーバーヘッドを含む */
  readonly tailMs: number;
}

export interface PageState {
  /** 表示中のページ(0始まり) */
  readonly index: number;
  /** 本体ページの線データを取得中 */
  readonly loading: boolean;
  readonly model: PageModel;
  /** 取得中のみ値を持つ。loading が false の間は null */
  readonly progress: PageProgress | null;
  /** ページ連続切替時に、古いページの応答で上書きしないための通し番号 */
  readonly request: number;
}

export interface OriginalImageState {
  /** 実際に受け取った原本画像の解像度(サーバーが応答サイズ上限のため下げる場合がある) */
  readonly receivedRes: number;
  /** 要求済みの解像度段階 */
  readonly requestedRes: number;
  readonly src: string | null;
}

export interface ThumbEntry {
  readonly src: string | null;
  /** 大きすぎて表示できない場合の補足 */
  readonly unavailableTip: string | null;
}

export interface ThumbsState {
  readonly entries: readonly ThumbEntry[];
  readonly visible: boolean;
}

export interface TooltipState {
  /** 対象要素の位置(表示時の getBoundingClientRect) */
  readonly anchor: DOMRectReadOnly | null;
  /** ヘルプ(?)の表示をクリックで固定しているか */
  readonly pinned: boolean;
  /** 表示中の補足文(非表示なら null) */
  readonly text: string | null;
}

export interface AppState {
  readonly doc: DocState | null;
  readonly dragging: boolean;
  readonly dropOver: boolean;
  /** ホバー中の要素(無ければ -1) */
  readonly hovered: number;
  /** 直近に完了したページ解析の実測時間(ms)。次回の擬似プログレスバーの見積もりに使う */
  readonly lastPageDurationMs: number | null;
  /** 凡例の件数(最初のページの線データを受け取るまでは null = 凡例なし) */
  readonly legendCounts: TypeCounts | null;
  readonly originalImage: OriginalImageState;
  readonly page: PageState;
  readonly rasterOpacity: number;
  readonly selection: Selection | null;
  readonly status: StatusText;
  readonly thumbs: ThumbsState;
  readonly tooltip: TooltipState;
  readonly view: View;
  readonly visibility: Visibility;
}

export const INITIAL_ORIGINAL_IMAGE: OriginalImageState = {
  receivedRes: 0,
  requestedRes: 0,
  src: null,
};

export const INITIAL_STATE: AppState = {
  doc: null,
  dragging: false,
  dropOver: false,
  hovered: -1,
  lastPageDurationMs: null,
  legendCounts: null,
  originalImage: INITIAL_ORIGINAL_IMAGE,
  page: {
    index: 0,
    loading: false,
    model: EMPTY_PAGE_MODEL,
    progress: null,
    request: 0,
  },
  rasterOpacity: DEFAULT_RASTER_OPACITY,
  selection: null,
  status: plainStatus(""),
  thumbs: { entries: [], visible: false },
  tooltip: { anchor: null, pinned: false, text: null },
  view: INITIAL_VIEW,
  visibility: { displayMode: "both", hiddenTypes: new Set() },
};

/** 表示中のページの寸法 */
export const currentPageSize = (s: AppState): PageSize | null =>
  s.doc?.pages[s.page.index] ?? null;
