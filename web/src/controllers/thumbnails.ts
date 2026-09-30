// サムネイル一覧: ブラウザ内(pdf.js の専用 Worker)でラスタライズする(ADR 0041)。
// サーバーへの通信が無くなったため、本体ページの読み込み完了を待たずに、表示範囲に入った
// ページから順に IntersectionObserver で検知して要求する
import { THUMB_MAX_WIDTH, THUMB_WIDTH } from "../domain/constants";
import { thumbUnavailableTip } from "../domain/messages";
import { devicePixelRatio } from "../render/dom";
import { renderThumb } from "../services/thumbnail-render";
import type { ControllerContext, DocumentSession } from "./context";

export interface ThumbnailScheduler {
  readonly dispose: () => void;
  /** サムネイルのボタンを登録する(el が null なら登録解除) */
  readonly register: (page: number, el: HTMLElement | null) => void;
  /** 文書が変わったら要求の記録を捨て、監視をやり直す */
  readonly reset: (session: DocumentSession) => void;
}

// 要求の進み具合は画面に出さない内部の記録なので store に置かず、文書ごとにここで持つ
interface Tracking {
  readonly elements: Map<number, HTMLElement>;
  readonly observer: IntersectionObserver | null;
  /** 要求済み(描画中・描画済み・失敗確定)のページ */
  readonly requested: Set<number>;
  readonly session: DocumentSession | null;
  /** 表示範囲内でまだ要求していないページ */
  readonly visible: Set<number>;
}

const pageOf = (el: Element): number =>
  Number((el as HTMLElement).dataset.page);

export const createThumbnailScheduler = (
  ctx: ControllerContext
): ThumbnailScheduler => {
  const { app } = ctx;
  let t: Tracking = {
    elements: new Map(),
    observer: null,
    requested: new Set(),
    session: null,
    visible: new Set(),
  };

  const loadOne = async (
    tracking: Tracking,
    target: DocumentSession,
    page: number,
    width: number
  ): Promise<void> => {
    try {
      const source = await target.thumbSource;
      const src = await renderThumb(source, page, width);
      if (tracking !== t) {
        return;
      }
      // 監視は要求が確定したときに解除する(成功・失敗のいずれも読み込みをやり直さない)
      const el = tracking.elements.get(page);
      if (el) {
        tracking.observer?.unobserve(el);
      }
      app.dispatch({
        docId: target.id,
        thumbs: [{ page, src }],
        type: "thumbsLoaded",
      });
    } catch {
      if (tracking !== t) {
        return;
      }
      const el = tracking.elements.get(page);
      if (el) {
        tracking.observer?.unobserve(el);
      }
      app.dispatch({
        docId: target.id,
        page,
        tip: thumbUnavailableTip(page),
        type: "thumbUnavailable",
      });
    }
  };

  const pump = (): void => {
    const tracking = t;
    const target = tracking.session;
    if (!(target && ctx.session() === target)) {
      return;
    }
    const width = Math.min(
      THUMB_MAX_WIDTH,
      Math.round(THUMB_WIDTH * devicePixelRatio())
    );
    for (const page of tracking.visible) {
      tracking.visible.delete(page);
      if (tracking.requested.has(page)) {
        continue; // 同じページを重複して要求しない
      }
      tracking.requested.add(page);
      loadOne(tracking, target, page, width);
    }
  };

  const reset = (session: DocumentSession): void => {
    t.observer?.disconnect();
    const root = ctx.dom.thumbs;
    const visible = new Set<number>();
    const observer = root
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (e.isIntersecting) {
                visible.add(pageOf(e.target));
              } else {
                visible.delete(pageOf(e.target));
              }
            }
            pump();
          },
          { root, rootMargin: "300px 0px" }
        )
      : null;
    t = {
      elements: new Map(),
      observer,
      requested: new Set(),
      session,
      visible,
    };
  };

  const register = (page: number, el: HTMLElement | null): void => {
    const prev = t.elements.get(page);
    if (prev) {
      t.observer?.unobserve(prev);
      t.elements.delete(page);
    }
    if (el) {
      t.elements.set(page, el);
      t.observer?.observe(el);
    }
  };

  return {
    dispose: () => {
      t.observer?.disconnect();
    },
    register,
    reset,
  };
};
