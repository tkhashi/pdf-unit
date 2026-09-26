// 表示変換(ページ座標 pt → 表示領域の座標 px: x_screen = view.x + x * view.scale)
import {
  FIT_PAD_PX,
  MAX_SCALE,
  MIN_SCALE,
  RESOLUTIONS,
  WHEEL_ZOOM_RATE,
} from "./constants";
import type { PageSize } from "./types";

export interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly height: number;
  readonly width: number;
}

export const INITIAL_VIEW: View = { scale: 1, x: 0, y: 0 };

/** ページ全体を表示領域の中央に収める */
export const fitView = ({ width, height }: PageSize, vp: Size): View => {
  const scale = Math.min(
    (vp.width - FIT_PAD_PX * 2) / width,
    (vp.height - FIT_PAD_PX * 2) / height
  );
  return {
    scale,
    x: (vp.width - width * scale) / 2,
    y: (vp.height - height * scale) / 2,
  };
};

/** カーソル位置 m を中心にホイール量 deltaY だけ拡大縮小する */
export const zoomAt = (view: View, m: Point, deltaY: number): View => {
  const factor = Math.exp(-deltaY * WHEEL_ZOOM_RATE);
  const scale = Math.min(Math.max(view.scale * factor, MIN_SCALE), MAX_SCALE);
  return {
    scale,
    x: m.x - (m.x - view.x) * (scale / view.scale),
    y: m.y - (m.y - view.y) * (scale / view.scale),
  };
};

export const toPage = (view: View, m: Point): Point => ({
  x: (m.x - view.x) / view.scale,
  y: (m.y - view.y) / view.scale,
});

/** 原本画像はズーム量に応じた解像度で読み込む(pt→px = scale * dpr、72dpi基準) */
export const neededResolution = (scale: number, dpr: number): number => {
  const need = 72 * scale * dpr;
  return RESOLUTIONS.find((r) => r >= need) ?? (RESOLUTIONS.at(-1) as number);
};

/** ハイライトの外側へのはみ出し幅(pt) */
export const highlightPad = (scale: number, min: number, max: number) =>
  Math.min(max, Math.max(min, scale)) / scale;
