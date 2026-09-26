// 図面表示領域の操作: ホイールでズーム、ドラッグで移動、ホバー・クリックで要素の強調と選択、ドロップで文書を開く
import { CLICK_SLOP_PX } from "../domain/constants";
import { pick } from "../domain/spatial-index";
import { type Point, toPage, zoomAt } from "../domain/view";
import { hiddenPredicate } from "../domain/visibility";
import type { ControllerContext } from "./context";

interface Drag {
  readonly moved: boolean;
  readonly vx: number;
  readonly vy: number;
  readonly x: number;
  readonly y: number;
}

/** 表示領域の要素に操作のリスナーを付ける。戻り値で外す */
export const attachViewportInput = (
  ctx: ControllerContext,
  el: HTMLElement,
  openFile: (file: File) => void
): (() => void) => {
  const { app } = ctx;
  // 1フレーム以内に何度も変わる値は描画に使わないため store に置かず、ここで持つ
  let drag: Drag | null = null;
  let mouse: Point | null = null; // 最後のカーソル位置(viewport座標)
  let movePending = false;

  const toViewport = (e: MouseEvent): Point => {
    const rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const pickAt = (m: Point): number => {
    const s = app.getState();
    const p = toPage(s.view, m);
    return pick(
      s.page.model.items,
      s.page.model.index,
      p.x,
      p.y,
      s.view.scale,
      hiddenPredicate(s.visibility)
    );
  };

  const hoverAtMouse = (): void => {
    if (!(app.getState().doc && mouse) || drag) {
      return;
    }
    app.dispatch({ id: pickAt(mouse), type: "hovered" });
  };

  const onWheel = (e: WheelEvent): void => {
    const s = app.getState();
    if (!s.doc) {
      return;
    }
    e.preventDefault();
    const m = toViewport(e);
    app.dispatch({ type: "viewChanged", view: zoomAt(s.view, m, e.deltaY) });
    mouse = m;
    hoverAtMouse(); // 許容距離がズームで変わるため再判定
  };

  const onPointerDown = (e: PointerEvent): void => {
    const s = app.getState();
    if (!s.doc || e.button !== 0) {
      return;
    }
    drag = {
      moved: false,
      vx: s.view.x,
      vy: s.view.y,
      x: e.clientX,
      y: e.clientY,
    };
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) {
        return;
      }
      drag = { ...drag, moved: true };
      app.dispatch({ dragging: true, type: "draggingChanged" });
      const { scale } = app.getState().view;
      app.dispatch({
        type: "viewChanged",
        view: { scale, x: drag.vx + dx, y: drag.vy + dy },
      });
      return;
    }
    mouse = toViewport(e);
    if (!movePending) {
      movePending = true;
      requestAnimationFrame(() => {
        movePending = false;
        hoverAtMouse();
      });
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!drag) {
      return;
    }
    const wasClick = !drag.moved;
    drag = null;
    app.dispatch({ dragging: false, type: "draggingChanged" });
    mouse = toViewport(e);
    if (wasClick) {
      app.dispatch({ id: pickAt(mouse), type: "clicked" });
    } else {
      hoverAtMouse();
    }
  };

  const onPointerCancel = (): void => {
    drag = null;
    app.dispatch({ dragging: false, type: "draggingChanged" });
  };

  const onPointerLeave = (): void => {
    if (!drag) {
      mouse = null;
      app.dispatch({ id: -1, type: "hovered" });
    }
  };

  const onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    app.dispatch({ over: true, type: "dropOverChanged" });
  };

  const onDragLeave = (): void => {
    app.dispatch({ over: false, type: "dropOverChanged" });
  };

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    app.dispatch({ over: false, type: "dropOverChanged" });
    const file = e.dataTransfer?.files[0];
    if (file) {
      openFile(file);
    }
  };

  const listeners = [
    ["wheel", onWheel, { passive: false }],
    ["pointerdown", onPointerDown, undefined],
    ["pointermove", onPointerMove, undefined],
    ["pointerup", onPointerUp, undefined],
    ["pointercancel", onPointerCancel, undefined],
    ["pointerleave", onPointerLeave, undefined],
    ["dragover", onDragOver, undefined],
    ["dragleave", onDragLeave, undefined],
    ["drop", onDrop, undefined],
  ] as const;
  for (const [type, fn, opts] of listeners) {
    el.addEventListener(type, fn as EventListener, opts);
  }
  return () => {
    for (const [type, fn] of listeners) {
      el.removeEventListener(type, fn as EventListener);
    }
  };
};
