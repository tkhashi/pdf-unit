// 旧 index.html の定数をそのまま移したもの。値を変えると検出・描画・通信の結果が変わる

/** 要素の種類。凡例・一括チェックはこの順に並ぶ */
export const ITEM_TYPES = ["line", "rect", "curve", "text", "image"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export type StrokeType = "line" | "rect" | "curve";
export type AreaType = "text" | "image";

export const TYPE_COLORS: Readonly<Record<ItemType, string>> = {
  curve: "#c026d3",
  image: "#64748b",
  line: "#2563eb",
  rect: "#16a34a",
  text: "#ea580c",
};

/** 面で判定する要素(文字・画像)の優先度ペナルティ(許容距離に対する倍率)。重なる線を優先する */
export const AREA_PENALTY: Readonly<Record<AreaType, number>> = {
  image: 0.75,
  text: 0.5,
};

/** 選択中は他の要素を減光し、選択要素は本来の色+黄の縁取り。ホバーは赤(種類色・選択の黄と区別) */
export const HOVER_COLOR = "rgba(239, 68, 68, 0.6)";
export const GROUP_COLOR = "rgba(250, 204, 21, 0.85)";
export const DIM_ALPHA = 0.2;
export const RESOLUTIONS: readonly number[] = [100, 200, 400];
/** カーソルから線の縁までの許容距離(画面px) */
export const HIT_PX = 8;
/** ハイライトが線の外側にはみ出す幅(画面px、片側)。縮小表示時は細く */
export const HL_PAD_MIN_PX = 1;
/** 拡大表示時の上限 */
export const HL_PAD_MAX_PX = 3;
/** 形状比較の再標本化点数 */
export const SHAPE_N = 64;
/** 形状一致とみなす正規化残差(形状サイズ比) */
export const SHAPE_TOL = 0.03;
/** 実描画太さの下限(pt) */
export const MIN_LINEWIDTH = 0.15;
/** ベクター描画時の最小線幅(画面px) */
export const MIN_DRAW_PX = 0.75;
/** 空間インデックスのセルサイズ(pt) */
export const CELL = 8;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 400;
export const CLICK_SLOP_PX = 4;
/** ページ表示時に全体を収めるときの余白(px) */
export const FIT_PAD_PX = 24;
/** ホイール1単位あたりの拡大率の指数 */
export const WHEEL_ZOOM_RATE = 0.0015;
/**
 * 1回に送るPDF(切り出したページ)の上限。Lambda の同期呼び出しの上限(6MB)と関数URLのbase64化(4/3倍)から
 * 決めた値でサーバーと同じ。PDF全体の大きさには制限が無い(必要なページだけを送るため。ADR 0020)
 */
export const MAX_SEND_BYTES = 4 * 1024 * 1024;
/** 切り出した1ページPDFを使い回す件数(同じページの線データ・原本画像・埋め込み画像で共用) */
export const PAGE_PDF_CACHE = 6;
/** サムネイルの描画幅(ブラウザ内、pdf.js でラスタライズ。ADR 0041) */
export const THUMB_WIDTH = 140;
export const THUMB_MAX_WIDTH = 400;
export const TIP_DELAY_MS = 250;
export const DEFAULT_RASTER_OPACITY = 20;
/** 解析完了(擬似プログレスバーの100%表示)からバーを消すまでの一瞬の間(ms) */
export const PROGRESS_HOLD_MS = 150;
