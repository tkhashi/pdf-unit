// Canvas への描画(旧 index.html の drawScene / drawHighlights と同じ手順)
import {
  DIM_ALPHA,
  FILL_ALPHA,
  GROUP_COLOR,
  HL_PAD_MAX_PX,
  HL_PAD_MIN_PX,
  HOVER_COLOR,
  MIN_DRAW_PX,
  TYPE_COLORS,
} from "../domain/constants";
import { at, insetQuad, quadMinSide } from "../domain/geometry";
import {
  type FillItem,
  type Item,
  isFill,
  isImage,
  isText,
  type TextItem,
} from "../domain/items";
import type { PageModel } from "../domain/page-model";
import type { Selection } from "../domain/selection";
import type { PageSize } from "../domain/types";
import { highlightPad, type View } from "../domain/view";
import {
  imageRegionsOf,
  type PageResources,
  type StrokeBatch,
} from "./resources";

export interface SceneInput {
  readonly dpr: number;
  readonly hasDoc: boolean;
  readonly isHidden: (type: Item["type"]) => boolean;
  readonly model: PageModel;
  /** 原本画像の要素(埋め込み画像の範囲に不透明で描き写す) */
  readonly pageImage: HTMLImageElement | null;
  /** 原本画像が覆うページの大きさ(pt) */
  readonly pageSize: PageSize | null;
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

// 埋め込み画像は画素を取得せず、範囲の中だけ原本画像を不透明で描き写す(下敷きの濃さによらず絵柄が見える)。
// 範囲は全画像をまとめた1つの Path2D なので、原本画像の描画は1回で済む(ADR 0039)
const drawOriginalIn = (
  ctx: CanvasRenderingContext2D,
  region: Path2D,
  { pageImage, pageSize }: SceneInput
): void => {
  if (!(pageImage?.complete && pageImage.naturalWidth && pageSize)) {
    return;
  }
  ctx.save();
  ctx.clip(region);
  ctx.drawImage(pageImage, 0, 0, pageSize.width, pageSize.height);
  ctx.restore();
};

const strokeImageFrames = (
  ctx: CanvasRenderingContext2D,
  region: Path2D,
  input: SceneInput
): void => {
  ctx.strokeStyle = TYPE_COLORS.image;
  ctx.lineWidth = MIN_DRAW_PX / input.view.scale;
  ctx.stroke(region);
};

// 塗りつぶしの描画(塗り・縁取り)は、原本と同じくクリップの内側だけに行う(ADR 0046)
const withinClip = (
  ctx: CanvasRenderingContext2D,
  it: FillItem,
  input: SceneInput,
  draw: () => void
): void => {
  if (it.clip.length === 0) {
    draw();
    return;
  }
  ctx.save();
  for (const c of it.clip) {
    const clip = input.resources.clipPaths[c];
    if (clip) {
      ctx.clip(clip);
    }
  }
  draw();
  ctx.restore();
};

// 塗りつぶしは本来の色(白地を隠す白など)ではなく種類の色で、下が透ける濃さで塗る。
// 塗りの規則は要素ごとに異なり、まとめると重なりの扱いが変わるため1件ずつ塗る(ADR 0044)
const paintFill = (
  ctx: CanvasRenderingContext2D,
  it: FillItem,
  input: SceneInput
): void => {
  const path = input.resources.paths[it.id];
  if (path) {
    withinClip(ctx, it, input, () => ctx.fill(path, it.fill_rule));
  }
};

const drawFills = (
  ctx: CanvasRenderingContext2D,
  input: SceneInput,
  alpha: number
): void => {
  if (input.isHidden("fill")) {
    return;
  }
  ctx.globalAlpha = alpha * FILL_ALPHA;
  ctx.fillStyle = TYPE_COLORS.fill;
  for (const it of input.model.items) {
    if (isFill(it)) {
      paintFill(ctx, it, input);
    }
  }
  ctx.globalAlpha = alpha;
};

/** 塗りつぶしの範囲の縁取り(小さな範囲でも見えるよう、縁の外側にも pad だけはみ出す) */
const outlineFill = (
  ctx: CanvasRenderingContext2D,
  it: FillItem,
  color: string,
  input: SceneInput
): void => {
  const path = input.resources.paths[it.id];
  if (!path) {
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth =
    2 * highlightPad(input.view.scale, HL_PAD_MIN_PX, HL_PAD_MAX_PX);
  withinClip(ctx, it, input, () => ctx.stroke(path));
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
  const alpha = input.selection ? DIM_ALPHA : 1;
  ctx.globalAlpha = alpha;
  const regions = input.resources.imageRegions;
  if (regions && !input.isHidden("image")) {
    drawOriginalIn(ctx, regions, input);
    strokeImageFrames(ctx, regions, input);
  }
  drawFills(ctx, input, alpha);
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
  if (isFill(it)) {
    ctx.fillStyle = color;
    paintFill(ctx, it, input);
    outlineFill(ctx, it, color, input);
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
  // 画像は範囲の原本画像を減光前の濃さで先に描き直し、その上に枠を重ねる。
  // 線・文字・塗りつぶしは縁取り(黄)を先に描き、その上に減光前の色で描き直す
  const images = imageRegionsOf(group.areas);
  if (images) {
    drawOriginalIn(ctx, images, input);
  }
  const fills = group.areas.filter(isFill);
  for (const it of fills) {
    outlineFill(ctx, it, GROUP_COLOR, input);
  }
  ctx.globalAlpha = FILL_ALPHA;
  ctx.fillStyle = TYPE_COLORS.fill;
  for (const it of fills) {
    paintFill(ctx, it, input);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = GROUP_COLOR;
  for (const b of group.strokes) {
    ctx.lineWidth = b.w + 2 * pad;
    ctx.stroke(b.path);
  }
  for (const it of group.areas) {
    if (!isFill(it)) {
      highlightItem(ctx, it, GROUP_COLOR, input);
    }
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
