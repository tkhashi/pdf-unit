// サムネイル一覧: ブラウザ内(pdf.js の専用 Worker)でラスタライズする(ADR 0041)。
// 文書を開いたら全ページを背景優先度で1ページずつ先読みし(Worker側で直列処理し、描き終えた
// ページの資源はすぐ捨てる。ADR 0048)、IntersectionObserver で検知した表示範囲の
// ページは優先度を上げて先に描画させる。全ページ描き終えたら Worker 側の文書を閉じる(ADR 0050)
import {
  THUMB_MAX_WIDTH,
  THUMB_RESOLUTION_SCALE,
  THUMB_WIDTH,
} from "../domain/constants";
import { thumbUnavailableTip } from "../domain/messages";
import { devicePixelRatio } from "../render/dom";
import {
  closeThumbnailSource,
  renderThumb,
  reprioritizeThumb,
  THUMB_PRIORITY_BACKGROUND,
  THUMB_PRIORITY_VISIBLE,
} from "../services/thumbnail-render";
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
  /** 要求済み(背景で先読み中・描画中・描画済み・失敗確定)のページ */
  readonly requested: Set<number>;
  readonly session: DocumentSession | null;
  /** 要求が確定した(描画済み・失敗確定)ページ */
  readonly settled: Set<number>;
  /** 表示範囲内でまだ優先度を上げていないページ */
  readonly visible: Set<number>;
}

const pageOf = (el: Element): number =>
  Number((el as HTMLElement).dataset.page);

const thumbWidth = (): number =>
  Math.round(
    Math.min(THUMB_MAX_WIDTH, THUMB_WIDTH * devicePixelRatio()) *
      THUMB_RESOLUTION_SCALE
  );

export const createThumbnailScheduler = (
  ctx: ControllerContext
): ThumbnailScheduler => {
  const { app } = ctx;
  let t: Tracking = {
    elements: new Map(),
    observer: null,
    requested: new Set(),
    session: null,
    settled: new Set(),
    visible: new Set(),
  };

  // 監視は要求が確定したときに解除する(成功・失敗のいずれも読み込みをやり直さない)。
  // 全ページが確定したら同じ文書を描き直すことはないので、Worker が持つPDFとパース結果を解放する
  const settle = (
    tracking: Tracking,
    target: DocumentSession,
    page: number
  ): void => {
    const el = tracking.elements.get(page);
    if (el) {
      tracking.observer?.unobserve(el);
    }
    tracking.settled.add(page);
    if (tracking.settled.size === target.pdf.getPageCount()) {
      target.thumbSource.then(closeThumbnailSource, () => {
        // 開けなかった文書は閉じる必要がない
      });
    }
  };

  const loadOne = async (
    tracking: Tracking,
    target: DocumentSession,
    page: number,
    width: number,
    priority: number
  ): Promise<void> => {
    try {
      const source = await target.thumbSource;
      const src = await renderThumb(source, page, width, priority);
      if (tracking !== t) {
        return;
      }
      settle(tracking, target, page);
      app.dispatch({
        docId: target.id,
        thumbs: [{ page, src }],
        type: "thumbsLoaded",
      });
    } catch {
      if (tracking !== t) {
        return;
      }
      settle(tracking, target, page);
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
    const width = thumbWidth();
    for (const page of tracking.visible) {
      tracking.visible.delete(page);
      if (tracking.requested.has(page)) {
        // 既に背景で先読み中かもしれないので優先度だけ上げる(描画済みなら無視される)
        target.thumbSource
          .then((source) =>
            reprioritizeThumb(source, page, THUMB_PRIORITY_VISIBLE)
          )
          .catch(() => {
            // 文書を開けなかった場合は loadOne 側で失敗表示になる
          });
        continue;
      }
      tracking.requested.add(page);
      loadOne(tracking, target, page, width, THUMB_PRIORITY_VISIBLE);
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
    const requested = new Set<number>();
    t = {
      elements: new Map(),
      observer,
      requested,
      session,
      settled: new Set(),
      visible,
    };
    // 表示範囲を待たず、全ページを背景優先度で1ページずつ先読みする(Worker側で直列処理)
    const width = thumbWidth();
    const count = session.pdf.getPageCount();
    for (let page = 0; page < count; page += 1) {
      requested.add(page);
      loadOne(t, session, page, width, THUMB_PRIORITY_BACKGROUND);
    }
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
