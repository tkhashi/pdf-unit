// Canvas への描画(旧 index.html の drawScene / drawHighlights と同じ手順)
import {
  DIM_ALPHA,
  GROUP_COLOR,
  HL_PAD_MAX_PX,
  HL_PAD_MIN_PX,
  HOVER_COLOR,
  MIN_DRAW_PX,
  TYPE_COLORS,
} from "../domain/constants";
import { at, insetQuad, quadMinSide } from "../domain/geometry";
import {
  type ImageItem,
  type Item,
  isImage,
  isText,
  type TextItem,
} from "../domain/items";
import type { PageModel } from "../domain/page-model";
import type { Selection } from "../domain/selection";
import { highlightPad, type View } from "../domain/view";
import type { PageResources, StrokeBatch } from "./resources";

export interface SceneInput {
  readonly dpr: number;
  readonly hasDoc: boolean;
  readonly isHidden: (type: Item["type"]) => boolean;
  readonly model: PageModel;
  readonly resources: PageResources;
  readonly selection: Selection | null;
  readonly view: View;
}

const pageTransform = (
  ctx: CanvasRenderingContext2D,
  { dpr, view }: SceneInput
): void => {
  ctx.setTransform(
    dpr * view.scale,
    0,
    0,
    dpr * view.scale,
    dpr * view.x,
    dpr * view.y
  );
};

const clear = (ctx: CanvasRenderingContext2D): void => {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
};

// 文字は画面座標で描く(ptのまま極小フォントを拡大すると描画が崩れるため)
const drawGlyphs = (
  ctx: CanvasRenderingContext2D,
  it: TextItem,
  { dpr, view }: SceneInput
): void => {
  for (const g of it.chars) {
    ctx.setTransform(
      dpr,
      0,
      0,
      dpr,
      dpr * (view.x + g.x * view.scale),
      dpr * (view.y + g.y * view.scale)
    );
    ctx.rotate((g.rotation * Math.PI) / 180);
    if (g.sx !== 1) {
      ctx.scale(g.sx, 1);
    }
    ctx.font = `${g.size * view.scale}px sans-serif`;
    ctx.fillText(g.text, 0, 0);
  }
};

// 埋め込み画像: 回転なしはbboxへ、回転・せん断ありは画像の左上/右上/左下を四隅に合わせたアフィン変換で描く
const drawImageItem = (
  ctx: CanvasRenderingContext2D,
  it: ImageItem,
  input: SceneInput
): void => {
  const el = input.resources.images.get(it.index);
  if (!(el?.complete && el.naturalWidth)) {
    return;
  }
  const [x0, top, x1, bottom] = it.bbox;
  // 画面上で画像1画素が2px以上に拡大されたら補間せず画素をそのまま見せる
  ctx.imageSmoothingEnabled =
    (input.view.scale * (x1 - x0)) / el.naturalWidth < 2;
  if (it.placement === "bbox") {
    ctx.drawImage(el, x0, top, x1 - x0, bottom - top);
    return;
  }
  const q = it.quad; // 左下, 右下, 右上, 左上
  const [blx, bly, trx, trY, tlx, tly] = [0, 1, 4, 5, 6, 7].map((i) =>
    at(q, i)
  ) as [number, number, number, number, number, number];
  const w = el.naturalWidth;
  const h = el.naturalHeight;
  ctx.save();
  ctx.transform(
    (trx - tlx) / w,
    (trY - tly) / w,
    (blx - tlx) / h,
    (bly - tly) / h,
    tlx,
    tly
  );
  ctx.drawImage(el, 0, 0);
  ctx.restore();
};

const strokeBatches = (
  ctx: CanvasRenderingContext2D,
  batches: readonly StrokeBatch[],
  input: SceneInput,
  skipHidden: boolean
): void => {
  for (const b of batches) {
    if (skipHidden && input.isHidden(b.type)) {
      continue;
    }
    ctx.strokeStyle = TYPE_COLORS[b.type];
    ctx.lineWidth = Math.max(b.w, MIN_DRAW_PX / input.view.scale);
    ctx.stroke(b.path);
  }
};

export const drawScene = (
  ctx: CanvasRenderingContext2D,
  input: SceneInput
): void => {
  clear(ctx);
  if (!input.hasDoc) {
    return;
  }
  const { items } = input.model;
  pageTransform(ctx, input);
  ctx.globalAlpha = input.selection ? DIM_ALPHA : 1;
  if (!input.isHidden("image")) {
    for (const it of items) {
      if (isImage(it)) {
        drawImageItem(ctx, it, input);
      }
    }
  }
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  strokeBatches(ctx, input.resources.strokeBatches, input, true);
  if (!input.isHidden("text")) {
    ctx.fillStyle = TYPE_COLORS.text;
    for (const it of items) {
      if (isText(it)) {
        drawGlyphs(ctx, it, input);
      }
    }
  }
  ctx.globalAlpha = 1;
};

const quadPath = (ctx: CanvasRenderingContext2D, pts: readonly number[]) => {
  ctx.beginPath();
  ctx.moveTo(at(pts, 0), at(pts, 1));
  for (let i = 2; i < 8; i += 2) {
    ctx.lineTo(at(pts, i), at(pts, i + 1));
  }
  ctx.closePath();
};

const highlightItem = (
  ctx: CanvasRenderingContext2D,
  it: Item,
  color: string,
  input: SceneInput
): void => {
  const pad = highlightPad(input.view.scale, HL_PAD_MIN_PX, HL_PAD_MAX_PX);
  if (isImage(it)) {
    quadPath(ctx, it.quad);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.2;
    ctx.fill();
    ctx.globalAlpha = 1;
    // 枠線は画像の内側に寄せて描く。隙間なく並んだ画像(分割された写真等)でも
    // 隣同士の枠が重ならず、1枚ずつ区別できる
    const w = pad;
    const inset = Math.min(pad * 1.5 + w / 2, quadMinSide(it.quad) / 4);
    quadPath(ctx, insetQuad(it.quad, inset));
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke();
    return;
  }
  if (isText(it)) {
    const [x0, top, x1, bottom] = it.bbox;
    ctx.fillStyle = color;
    ctx.fillRect(
      x0 - pad,
      top - pad,
      x1 - x0 + 2 * pad,
      bottom - top + 2 * pad
    );
    return;
  }
  const path = input.resources.paths[it.id];
  if (!path) {
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = it.w + 2 * pad;
  ctx.stroke(path);
};

const drawGroup = (
  ctx: CanvasRenderingContext2D,
  group: { areas: readonly Item[]; strokes: readonly StrokeBatch[] },
  input: SceneInput
): void => {
  const pad = highlightPad(input.view.scale, HL_PAD_MIN_PX, HL_PAD_MAX_PX);
  // 画像は不透明なので先に描き直し、その上に枠を重ねる。
  // 線・文字は縁取り(黄)を先に描き、その上に減光前の本来の色で描き直す
  for (const it of group.areas) {
    if (isImage(it)) {
      drawImageItem(ctx, it, input);
    }
  }
  ctx.strokeStyle = GROUP_COLOR;
  for (const b of group.strokes) {
    ctx.lineWidth = b.w + 2 * pad;
    ctx.stroke(b.path);
  }
  for (const it of group.areas) {
    highlightItem(ctx, it, GROUP_COLOR, input);
  }
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  strokeBatches(ctx, group.strokes, input, false);
  ctx.fillStyle = TYPE_COLORS.text;
  for (const it of group.areas) {
    if (isText(it)) {
      drawGlyphs(ctx, it, input);
    }
  }
  pageTransform(ctx, input); // drawGlyphsが画面座標に切り替えるため戻す
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
};

export const drawHighlights = (
  ctx: CanvasRenderingContext2D,
  input: SceneInput & {
    readonly group: {
      areas: readonly Item[];
      strokes: readonly StrokeBatch[];
    } | null;
    readonly hovered: number;
  }
): void => {
  clear(ctx);
  if (!input.hasDoc) {
    return;
  }
  pageTransform(ctx, input);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (input.group) {
    drawGroup(ctx, input.group, input);
  }
  const hovered = input.model.items[input.hovered];
  if (hovered) {
    highlightItem(ctx, hovered, HOVER_COLOR, input);
  }
};
