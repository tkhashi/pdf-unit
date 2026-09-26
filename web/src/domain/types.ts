// /api/page/lines 等の応答の型。サーバー側の定義(extract.py の LineRecord・TextRecord・CharGlyph、
// raster.py の ImageRecord、server.py の各API)と対応する
import type { StrokeType } from "./constants";

/** x0, top, x1, bottom(左上原点、pt) */
export type Bbox = readonly [number, number, number, number];

export interface PageSize {
  readonly height: number;
  readonly width: number;
}

export interface LineRecord {
  readonly bbox: Bbox;
  readonly color: string | null;
  /** SVG path data(描画用) */
  readonly d: string;
  readonly id: number;
  readonly linewidth: number | null;
  /** ヒット判定用の折れ線群 [x0, y0, x1, y1, ...](ベジェは分割済み) */
  readonly polylines: readonly (readonly number[])[];
  readonly type: StrokeType;
}

export interface CharGlyph {
  readonly rotation: number;
  readonly size: number;
  readonly sx: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

export interface TextRecord {
  readonly bbox: Bbox;
  readonly chars: readonly CharGlyph[];
  readonly color: string | null;
  readonly fontname: string | null;
  readonly size: number | null;
  readonly text: string;
  readonly type: "text";
  /** 復元できず「□」で表示している文字の数 */
  readonly unreadable: number;
}

export interface ImageRecord {
  readonly bbox: Bbox;
  readonly dpi: number;
  readonly filters: readonly string[];
  /** ページ内の画像番号(画像データ取得APIのキー) */
  readonly index: number;
  /** "bbox": 画像データをbboxに描く / "affine": 画像データの左上等を quad に合わせて変形 */
  readonly placement: "bbox" | "affine";
  readonly px_height: number;
  readonly px_width: number;
  /** 四隅 [x, y] * 4(左下・右下・右上・左上の順、top原点) */
  readonly quad: readonly number[];
  readonly type: "image";
}

export type CalibrationMethod =
  | "measured"
  | "manual"
  | "fallback_disabled"
  | "fallback_no_samples";

export interface LinesResponse {
  readonly calibration: CalibrationMethod;
  readonly images: readonly ImageRecord[];
  readonly lines: readonly LineRecord[];
  readonly linewidth_scale: number;
  readonly page: PageSize;
  readonly texts: readonly TextRecord[];
}

export interface PageImageResponse {
  readonly png_base64: string;
  readonly resolution: number;
}

export interface ThumbsResponse {
  readonly thumbs: readonly {
    readonly page: number;
    readonly png_base64: string;
  }[];
}
