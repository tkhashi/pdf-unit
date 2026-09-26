// サムネイル一覧: 表示範囲に入ったページを含む10ページ単位のバッチで、1バッチずつ、
// 本体ページの読み込みが終わってから取得する(サーバー側はPDFium処理が直列)
import {
  MAX_SEND_BYTES,
  THUMB_BATCH,
  THUMB_CONCURRENCY,
  THUMB_MAX_WIDTH,
  THUMB_WIDTH,
} from "../domain/constants";
import { pngDataUrl } from "../domain/format";
import { thumbUnavailableTip } from "../domain/messages";
import type { ThumbsResponse } from "../domain/types";
import { devicePixelRatio } from "../render/dom";
import { apiPost } from "../services/api";
import { extractPages } from "../services/pdf";
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
  active: number;
  readonly elements: Map<number, HTMLElement>;
  readonly observer: IntersectionObserver | null;
  /** 要求済み(読込中・読込済み)のバッチ番号 */
  readonly requested: Set<number>;
  readonly session: DocumentSession | null;
  /** 表示範囲内でまだ読み込んでいないページ */
  readonly visible: Set<number>;
}

const pageOf = (el: Element): number =>
  Number((el as HTMLElement).dataset.page);

export const createThumbnailScheduler = (
  ctx: ControllerContext
): ThumbnailScheduler => {
  const { app } = ctx;
  let t: Tracking = {
    active: 0,
    elements: new Map(),
    observer: null,
    requested: new Set(),
    session: null,
    visible: new Set(),
  };

  // 指定ページを1つのPDFに切り出して送る。送信上限を超える場合は半分ずつに分けて送り直し、
  // 1ページでも超える場合はそのサムネイルを「表示できません」にする
  const loadThumbs = async (
    target: DocumentSession,
    indices: readonly number[],
    width: number
  ): Promise<void> => {
    const body = await extractPages(target.pdf, indices);
    if (body.bytes.length > MAX_SEND_BYTES) {
      const [first] = indices;
      if (indices.length === 1 && first !== undefined) {
        app.dispatch({
          docId: target.id,
          page: first,
          tip: thumbUnavailableTip(first, body.bytes.length),
          type: "thumbUnavailable",
        });
        return;
      }
      const half = Math.ceil(indices.length / 2);
      await loadThumbs(target, indices.slice(0, half), width);
      await loadThumbs(target, indices.slice(half), width);
      return;
    }
    const r = await apiPost<ThumbsResponse>(`/api/thumbs?width=${width}`, body);
    // t.page は送ったPDF内でのページ番号
    const thumbs = r.thumbs.flatMap((th) => {
      const page = indices[th.page];
      return page === undefined
        ? []
        : [{ page, src: pngDataUrl(th.png_base64) }];
    });
    app.dispatch({ docId: target.id, thumbs, type: "thumbsLoaded" });
  };

  const loadBatch = async (
    tracking: Tracking,
    target: DocumentSession,
    batch: number,
    width: number
  ): Promise<void> => {
    const start = batch * THUMB_BATCH;
    const count = Math.min(THUMB_BATCH, target.pdf.getPageCount() - start);
    const indices = Array.from({ length: count }, (_, i) => start + i);
    tracking.active += 1;
    try {
      await loadThumbs(target, indices, width);
      if (tracking !== t) {
        return;
      }
      // 監視は読み込み成功時に解除する(失敗したバッチは、再び表示範囲に入ったとき再要求される)
      for (const i of indices) {
        tracking.visible.delete(i);
        const el = tracking.elements.get(i);
        if (el) {
          tracking.observer?.unobserve(el);
        }
      }
    } catch {
      if (tracking === t) {
        tracking.requested.delete(batch); // 失敗したバッチは次に見えたとき再要求する
      }
    } finally {
      if (tracking === t) {
        tracking.active -= 1;
        pump();
      }
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
      if (app.getState().page.loading || tracking.active >= THUMB_CONCURRENCY) {
        return;
      }
      tracking.visible.delete(page);
      const batch = Math.floor(page / THUMB_BATCH);
      if (tracking.requested.has(batch)) {
        continue; // 同じバッチを重複して要求しない
      }
      tracking.requested.add(batch);
      loadBatch(tracking, target, batch, width);
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
      active: 0,
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

  // 本体ページの線データの取得が終わったら、控えていたサムネイルの要求を始める
  const unsubscribe = app.subscribe((s, p) => {
    if (p.page.loading && !s.page.loading) {
      pump();
    }
  });

  return {
    dispose: () => {
      unsubscribe();
      t.observer?.disconnect();
    },
    register,
    reset,
  };
};
