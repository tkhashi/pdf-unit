// 描画・計測に使う DOM 要素。React のコンポーネントが ref で登録し、描画層・コントローラーが参照する
export interface DomRefs {
  highlightCanvas: HTMLCanvasElement | null;
  pageImage: HTMLImageElement | null;
  sceneCanvas: HTMLCanvasElement | null;
  stage: HTMLDivElement | null;
  thumbs: HTMLElement | null;
  viewport: HTMLDivElement | null;
}

export const createDomRefs = (): DomRefs => ({
  highlightCanvas: null,
  pageImage: null,
  sceneCanvas: null,
  stage: null,
  thumbs: null,
  viewport: null,
});

export const devicePixelRatio = (): number => window.devicePixelRatio || 1;

/** 表示領域の大きさ(レイアウト確定後の値を読む) */
export const viewportSize = (dom: DomRefs) => ({
  height: dom.viewport?.clientHeight ?? 0,
  width: dom.viewport?.clientWidth ?? 0,
});

/** ref に渡す登録関数(再レンダーで作り直さないよう一度だけ作る) */
export type DomRefSetters = {
  readonly [K in keyof DomRefs]: (el: DomRefs[K]) => void;
};

export const createDomRefSetters = (dom: DomRefs): DomRefSetters => ({
  highlightCanvas: (el) => {
    dom.highlightCanvas = el;
  },
  pageImage: (el) => {
    dom.pageImage = el;
  },
  sceneCanvas: (el) => {
    dom.sceneCanvas = el;
  },
  stage: (el) => {
    dom.stage = el;
  },
  thumbs: (el) => {
    dom.thumbs = el;
  },
  viewport: (el) => {
    dom.viewport = el;
  },
});
