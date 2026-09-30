// 単体テスト用の小さな /api/page/lines 応答
import type { LinesResponse } from "../domain/types";

export const sampleLines = (): LinesResponse => ({
  calibration: "measured",
  fills: [
    {
      bbox: [300, 20, 360, 80],
      color: "rgb(255,255,255)",
      // 穴のある範囲(偶奇規則)
      d: "M300 20 H360 V80 H300 Z M320 40 H340 V60 H320 Z",
      fill_rule: "evenodd",
      id: 0,
      linewidth: 2.5,
      polylines: [
        [300, 20, 360, 20, 360, 80, 300, 80, 300, 20],
        [320, 40, 340, 40, 340, 60, 320, 60, 320, 40],
      ],
      type: "fill",
    },
  ],
  images: [
    {
      bbox: [200, 200, 260, 240],
      dpi: 96,
      filters: ["FlateDecode"],
      index: 0,
      placement: "bbox",
      px_height: 40,
      px_width: 60,
      quad: [200, 240, 260, 240, 260, 200, 200, 200],
      type: "image",
    },
  ],
  lines: [
    {
      bbox: [10, 10, 110, 10],
      color: "rgb(0,0,0)",
      d: "M10 10 L110 10",
      id: 0,
      linewidth: 1,
      polylines: [[10, 10, 110, 10]],
      type: "line",
    },
    {
      bbox: [10, 30, 110, 30],
      color: "rgb(128,128,128)",
      d: "M10 30 L110 30",
      id: 1,
      linewidth: 1,
      polylines: [[10, 30, 110, 30]],
      type: "line",
    },
    {
      bbox: [10, 50, 60, 50],
      color: "rgb(0,0,0)",
      d: "M10 50 L60 50",
      id: 2,
      linewidth: 2,
      polylines: [[10, 50, 60, 50]],
      type: "line",
    },
    {
      bbox: [10, 60, 50, 100],
      color: "rgb(0,0,0)",
      d: "M10 60 H50 V100 H10 Z",
      id: 3,
      linewidth: 1,
      polylines: [[10, 60, 50, 60, 50, 100, 10, 100, 10, 60]],
      type: "rect",
    },
  ],
  linewidth_scale: 0.5,
  page: { height: 300, width: 400 },
  texts: [
    {
      bbox: [100, 40, 140, 52],
      chars: [{ rotation: 0, size: 12, sx: 1, text: "A", x: 100, y: 50 }],
      color: "rgb(0,0,0)",
      fontname: "Helvetica",
      size: 12,
      text: "ABC",
      type: "text",
      unreadable: 0,
    },
  ],
});
