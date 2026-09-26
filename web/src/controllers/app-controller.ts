// 画面全体の組み立て: store・描画層・コントローラーを作り、React のコンポーネントへ操作を渡す
import type { ItemType } from "../domain/constants";
import type { DisplayMode } from "../domain/visibility";
import {
  createDomRefSetters,
  createDomRefs,
  type DomRefSetters,
  type DomRefs,
  viewportSize,
} from "../render/dom";
import { createRenderer } from "../render/renderer";
import { type AppStore, createAppStore } from "../state/store";
import type { ControllerContext, DocumentSession } from "./context";
import { openFile, setThumbsVisible } from "./document";
import { watchOriginalImage } from "./original-image";
import { showPage } from "./page";
import { createThumbnailScheduler } from "./thumbnails";
import { createTooltipController } from "./tooltip";
import { attachViewportInput } from "./viewport-input";

/** コンポーネントから呼ぶ操作 */
export interface AppActions {
  readonly openFile: (file: File) => void;
  readonly registerThumb: (page: number, el: HTMLElement | null) => void;
  readonly setAllTypesToggled: () => void;
  readonly setDisplayMode: (mode: DisplayMode) => void;
  readonly setRasterOpacity: (value: number) => void;
  readonly setTypeVisible: (type: ItemType, visible: boolean) => void;
  readonly showPage: (page: number) => void;
  readonly toggleHelp: (el: HTMLElement) => void;
  readonly toggleThumbs: () => void;
}

export interface AppController {
  readonly actions: AppActions;
  readonly app: AppStore;
  /** 表示領域の要素に操作を付ける(戻り値で外す) */
  readonly attachViewport: (el: HTMLElement) => () => void;
  readonly dom: DomRefs;
  /** window・document のリスナー等を付ける(戻り値で外す) */
  readonly install: () => () => void;
  /** 描画・計測に使う DOM 要素を登録する ref */
  readonly refs: DomRefSetters;
}

export const createAppController = (): AppController => {
  const app = createAppStore();
  const dom = createDomRefs();
  const renderer = createRenderer(app, dom);
  let session: DocumentSession | null = null;
  const ctx: ControllerContext = {
    app,
    dom,
    renderer,
    session: () => session,
    setSession: (s) => {
      session = s;
    },
  };
  const thumbs = createThumbnailScheduler(ctx);
  let tooltip: ReturnType<typeof createTooltipController> | null = null;

  const open = (file: File) => {
    openFile(ctx, thumbs, file);
  };

  const actions: AppActions = {
    openFile: open,
    registerThumb: thumbs.register,
    setAllTypesToggled: () => app.dispatch({ type: "allTypesToggled" }),
    setDisplayMode: (mode) =>
      app.dispatch({ mode, type: "displayModeChanged" }),
    setRasterOpacity: (value) =>
      app.dispatch({ type: "rasterOpacityChanged", value }),
    setTypeVisible: (itemType, visible) =>
      app.dispatch({ itemType, type: "typeVisibilityChanged", visible }),
    showPage: (page) => {
      showPage(ctx, page);
    },
    toggleHelp: (el) => tooltip?.toggleHelp(el),
    toggleThumbs: () => setThumbsVisible(ctx, !app.getState().thumbs.visible),
  };

  const install = () => {
    const tip = createTooltipController(app);
    tooltip = tip;
    const unwatchImage = watchOriginalImage(ctx);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
      if (app.getState().tooltip.pinned) {
        tip.hide();
        return;
      }
      app.dispatch({ type: "selectionCleared" });
    };
    const onResize = () => {
      if (app.getState().doc) {
        app.dispatch({ type: "viewFitted", viewport: viewportSize(dom) });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    // ヘッダーの折返し等で表示領域の大きさが変わったら、Canvasの画素バッファを表示サイズに合わせ直す
    // (合わないとCanvasが引き伸ばされて表示され、原本とずれる)
    const resizeObserver = new ResizeObserver(() => {
      renderer.resize();
      renderer.invalidate(true);
    });
    if (dom.viewport) {
      resizeObserver.observe(dom.viewport);
    }
    renderer.resize();
    return () => {
      tip.dispose();
      tooltip = null;
      unwatchImage();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      resizeObserver.disconnect();
    };
  };

  return {
    actions,
    app,
    attachViewport: (el) => attachViewportInput(ctx, el, open),
    dom,
    install,
    refs: createDomRefSetters(dom),
  };
};
