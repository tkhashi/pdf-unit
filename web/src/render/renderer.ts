// store の変化を購読して Canvas を描き直す。React の再レンダーを通さず、1フレームに1回だけ描く

import { hiddenPredicate } from "../domain/visibility";
import { type AppState, currentPageSize } from "../state/state";
import type { AppStore } from "../state/store";
import { type DomRefs, devicePixelRatio } from "./dom";
import { drawHighlights, drawScene, type SceneInput } from "./draw";
import { groupBatchesOf, resourcesOf } from "./resources";

export interface Renderer {
  readonly dispose: () => void;
  /** 次のフレームで描き直す(scene: 線・文字・画像の層も描き直すか。false ならハイライトの層だけ) */
  readonly invalidate: (scene?: boolean) => void;
  /** Canvas の画素バッファを表示サイズに合わせる(合わないと引き伸ばされて原本とずれる) */
  readonly resize: () => void;
}

// 線・文字・画像の層の見た目を変える状態が変わったか
const sceneChanged = (s: AppState, p: AppState): boolean =>
  s.doc !== p.doc ||
  s.page.model !== p.page.model ||
  s.view !== p.view ||
  s.visibility !== p.visibility ||
  (s.selection === null) !== (p.selection === null);

const highlightChanged = (s: AppState, p: AppState): boolean =>
  s.hovered !== p.hovered || s.selection !== p.selection;

const sceneInput = (s: AppState, dom: DomRefs): SceneInput => ({
  dpr: devicePixelRatio(),
  hasDoc: s.doc !== null,
  isHidden: hiddenPredicate(s.visibility),
  model: s.page.model,
  pageImage: dom.pageImage,
  pageSize: currentPageSize(s),
  resources: resourcesOf(s.page.model),
  selection: s.selection,
  view: s.view,
});

/** 原本画像を載せた要素の拡大縮小・移動(Canvas と同じ変換) */
const applyStageTransform = (dom: DomRefs, s: AppState): void => {
  if (dom.stage) {
    dom.stage.style.transform = `translate(${s.view.x}px, ${s.view.y}px) scale(${s.view.scale})`;
  }
};

export const createRenderer = (app: AppStore, dom: DomRefs): Renderer => {
  let pending = false;
  let sceneDirty = false;

  const frame = () => {
    pending = false;
    const s = app.getState();
    const input = sceneInput(s, dom);
    const scene = dom.sceneCanvas?.getContext("2d");
    if (sceneDirty && scene) {
      drawScene(scene, input);
    }
    sceneDirty = false;
    const hl = dom.highlightCanvas?.getContext("2d");
    if (hl) {
      drawHighlights(hl, {
        ...input,
        group: s.selection ? groupBatchesOf(s.page.model, s.selection) : null,
        hovered: s.hovered,
      });
    }
  };

  const invalidate = (scene = true) => {
    sceneDirty ||= scene;
    if (pending) {
      return;
    }
    pending = true;
    requestAnimationFrame(frame);
  };

  const resize = () => {
    const dpr = devicePixelRatio();
    const vp = dom.viewport;
    for (const c of [dom.sceneCanvas, dom.highlightCanvas]) {
      if (c && vp) {
        c.width = Math.round(vp.clientWidth * dpr);
        c.height = Math.round(vp.clientHeight * dpr);
      }
    }
  };

  // 購読中に別の dispatch が入れ子で起きると引数の s が最新でなくなるため、DOM へ書く値は getState() から取る
  const unsubscribe = app.subscribe((s, p) => {
    if (s.view !== p.view) {
      applyStageTransform(dom, app.getState());
    }
    if (sceneChanged(s, p)) {
      invalidate(true);
    } else if (highlightChanged(s, p)) {
      invalidate(false);
    }
  });
  applyStageTransform(dom, app.getState());

  return { dispose: unsubscribe, invalidate, resize };
};
