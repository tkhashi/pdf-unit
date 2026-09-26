// ツールチップ。補足文は各要素の data-tip に持つ(ブラウザ標準の title は環境によって表示されないため自前で出す。ADR 0017)
import { TIP_DELAY_MS } from "../domain/constants";
import type { AppStore } from "../state/store";

export interface TooltipController {
  readonly dispose: () => void;
  readonly hide: () => void;
  /** ヘルプ(?)のクリック: 表示を固定/解除する */
  readonly toggleHelp: (el: HTMLElement) => void;
}

/** ヘルプボタンの目印(このボタン上の pointerdown では固定表示を閉じない) */
export const HELP_ATTR = "data-help";

const tipOf = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element
    ? (target.closest<HTMLElement>("[data-tip]") ?? null)
    : null;

export const createTooltipController = (app: AppStore): TooltipController => {
  // 表示待ちのタイマーと対象要素は画面の状態ではないため、ここで持つ
  let target: HTMLElement | null = null;
  let timer = 0;
  // 対象の補足文が表示中に変わったら(原本の濃さ・ステータス等)、表示を追従させる
  const observer = new MutationObserver(() => {
    const { tooltip } = app.getState();
    if (!target || tooltip.text === null) {
      return;
    }
    const text = target.dataset.tip;
    if (text) {
      app.dispatch({
        anchor: target.getBoundingClientRect(),
        pinned: tooltip.pinned,
        text,
        type: "tooltipShown",
      });
    } else {
      hide();
    }
  });

  const pinned = () => app.getState().tooltip.pinned;

  const show = (el: HTMLElement, pin = false): void => {
    const text = el.dataset.tip;
    if (!text) {
      return;
    }
    target = el;
    observer.disconnect();
    observer.observe(el, { attributeFilter: ["data-tip"], attributes: true });
    app.dispatch({
      anchor: el.getBoundingClientRect(),
      pinned: pin,
      text,
      type: "tooltipShown",
    });
  };

  const hide = (): void => {
    clearTimeout(timer);
    target = null;
    observer.disconnect();
    app.dispatch({ type: "tooltipHidden" });
  };

  const onPointerOver = (e: PointerEvent): void => {
    if (pinned()) {
      return;
    }
    const el = tipOf(e.target);
    if (el === target) {
      return;
    }
    hide();
    if (el) {
      target = el;
      timer = window.setTimeout(() => show(el), TIP_DELAY_MS);
    }
  };
  const onLeave = (): void => {
    if (!pinned()) {
      hide();
    }
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (!(e.target instanceof Element && e.target.closest(`[${HELP_ATTR}]`))) {
      hide();
    }
  };
  const onFocusIn = (e: FocusEvent): void => {
    const el = tipOf(e.target);
    if (el && !pinned()) {
      hide();
      show(el);
    }
  };

  const root = document.documentElement;
  document.addEventListener("pointerover", onPointerOver);
  root.addEventListener("pointerleave", onLeave);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("wheel", onLeave, { passive: true });
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onLeave);

  return {
    dispose: () => {
      hide();
      document.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("wheel", onLeave);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onLeave);
    },
    hide,
    toggleHelp: (el) => {
      if (pinned()) {
        hide();
        return;
      }
      hide();
      show(el, true);
    },
  };
};
