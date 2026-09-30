// 状態遷移。副作用を持たない純粋関数で、変更があれば新しいオブジェクトを、無ければ元の state を返す
import { ITEM_TYPES, type ItemType } from "../domain/constants";
import { calibrationStatus, plainStatus } from "../domain/messages";
import { EMPTY_PAGE_MODEL } from "../domain/page-model";
import { estimateDurationMs } from "../domain/progress";
import { filterSelection, selectNext } from "../domain/selection";
import { fitView } from "../domain/view";
import { hiddenPredicate, type Visibility } from "../domain/visibility";
import type { Action } from "./actions";
import {
  type AppState,
  INITIAL_ORIGINAL_IMAGE,
  type ThumbEntry,
} from "./state";

type Handler<T extends Action["type"]> = (
  s: AppState,
  a: Extract<Action, { type: T }>
) => AppState;

const EMPTY_THUMB: ThumbEntry = {
  loading: false,
  src: null,
  unavailableTip: null,
};

/** 表示対象が変わったら、見えなくなった要素を選択・ホバーから外す */
const withVisibility = (s: AppState, visibility: Visibility): AppState => ({
  ...s,
  hovered: -1,
  selection: filterSelection(
    s.page.model.items,
    s.selection,
    hiddenPredicate(visibility)
  ),
  visibility,
});

const withHiddenTypes = (s: AppState, hiddenTypes: ReadonlySet<ItemType>) =>
  withVisibility(s, { ...s.visibility, hiddenTypes });

const isCurrentDoc = (s: AppState, docId: number): boolean =>
  s.doc?.id === docId;

const isCurrentImage = (s: AppState, docId: number, page: number) =>
  isCurrentDoc(s, docId) && s.page.index === page;

const replaceAt = <T>(list: readonly T[], i: number, value: T): T[] =>
  list.map((v, j) => (j === i ? value : v));

const documentOpened: Handler<"documentOpened"> = (s, a) => ({
  ...s,
  doc: a.doc,
  thumbs: {
    entries: a.doc.pages.map(() => EMPTY_THUMB),
    visible: a.thumbsVisible,
  },
});

const pageRequested: Handler<"pageRequested"> = (s, a) => {
  const size = s.doc?.pages[a.index];
  if (!size) {
    return s;
  }
  return {
    ...s,
    hovered: -1,
    originalImage: INITIAL_ORIGINAL_IMAGE,
    page: {
      index: a.index,
      loading: true,
      model: EMPTY_PAGE_MODEL,
      progress: {
        estimateMs: estimateDurationMs(s.lastPageDurationMs),
        ratio: 0,
        stageIndex: 0,
      },
      request: s.page.request + 1,
    },
    selection: null,
    status: plainStatus("抽出中..."),
    view: fitView(size, a.viewport),
  };
};

const pageProgressTicked: Handler<"pageProgressTicked"> = (s, a) =>
  a.request === s.page.request && s.page.progress
    ? {
        ...s,
        page: {
          ...s.page,
          progress: {
            ...s.page.progress,
            ratio: a.ratio,
            stageIndex: a.stageIndex,
          },
        },
      }
    : s;

const pageLoadSettled: Handler<"pageLoadSettled"> = (s, a) =>
  a.request === s.page.request
    ? {
        ...s,
        lastPageDurationMs: a.durationMs,
        page: { ...s.page, loading: false, progress: null },
      }
    : s;

// 座標系の基準はサーバー(PDFium)の寸法。pdf-libで求めた寸法と食い違えば合わせる
const pageSizeReported: Handler<"pageSizeReported"> = (s, a) => {
  if (a.request !== s.page.request) {
    return s;
  }
  const size = s.doc?.pages[s.page.index];
  if (
    !(s.doc && size) ||
    (Math.abs(size.width - a.pageSize.width) <= 0.01 &&
      Math.abs(size.height - a.pageSize.height) <= 0.01)
  ) {
    return s;
  }
  const pages = replaceAt(s.doc.pages, s.page.index, { ...a.pageSize });
  return {
    ...s,
    doc: { ...s.doc, pages },
    view: fitView(a.pageSize, a.viewport),
  };
};

const pageLoaded: Handler<"pageLoaded"> = (s, a) => {
  if (a.request !== s.page.request) {
    return s;
  }
  const { model } = a;
  return {
    ...s,
    legendCounts: model.counts,
    page: { ...s.page, model },
    status: model.calibration
      ? calibrationStatus(model.calibration, model.lwScale)
      : s.status,
  };
};

const pageFailed: Handler<"pageFailed"> = (s, a) =>
  a.request === s.page.request
    ? { ...s, status: plainStatus(`エラー: ${a.message}`) }
    : s;

const clicked: Handler<"clicked"> = (s, a) => ({
  ...s,
  hovered: a.id,
  selection:
    a.id >= 0
      ? selectNext(
          s.page.model.items,
          s.selection,
          a.id,
          hiddenPredicate(s.visibility)
        )
      : null,
});

const typeVisibilityChanged: Handler<"typeVisibilityChanged"> = (s, a) => {
  const hidden = new Set(s.visibility.hiddenTypes);
  if (a.visible) {
    hidden.delete(a.itemType);
  } else {
    hidden.add(a.itemType);
  }
  return withHiddenTypes(s, hidden);
};

// 一括チェック: 押すと、全部表示中なら全部非表示、それ以外なら全部表示にする
const allTypesToggled: Handler<"allTypesToggled"> = (s) => {
  const show = ITEM_TYPES.some((t) => s.visibility.hiddenTypes.has(t));
  return withHiddenTypes(s, new Set(show ? [] : ITEM_TYPES));
};

const originalImageRequested: Handler<"originalImageRequested"> = (s, a) =>
  isCurrentImage(s, a.docId, a.page) && a.res > s.originalImage.requestedRes
    ? { ...s, originalImage: { ...s.originalImage, requestedRes: a.res } }
    : s;

// 古いページ・低い解像度の応答で、より高い解像度の画像を上書きしない
const originalImageLoaded: Handler<"originalImageLoaded"> = (s, a) =>
  isCurrentImage(s, a.docId, a.page) &&
  a.resolution > s.originalImage.receivedRes
    ? {
        ...s,
        originalImage: {
          ...s.originalImage,
          receivedRes: a.resolution,
          src: a.src,
        },
      }
    : s;

// 失敗したら、次に表示が変わったとき同じ段階を要求し直す
const originalImageFailed: Handler<"originalImageFailed"> = (s, a) =>
  isCurrentImage(s, a.docId, a.page) && s.originalImage.requestedRes === a.res
    ? { ...s, originalImage: { ...s.originalImage, requestedRes: 0 } }
    : s;

const thumbRequested: Handler<"thumbRequested"> = (s, a) => {
  const entry = s.thumbs.entries[a.page];
  if (!(isCurrentDoc(s, a.docId) && entry) || entry.loading) {
    return s;
  }
  const entries = replaceAt(s.thumbs.entries, a.page, {
    ...entry,
    loading: true,
  });
  return { ...s, thumbs: { ...s.thumbs, entries } };
};

const thumbsLoaded: Handler<"thumbsLoaded"> = (s, a) => {
  if (!isCurrentDoc(s, a.docId)) {
    return s;
  }
  const loaded = new Map(a.thumbs.map((t) => [t.page, t.src]));
  const entries = s.thumbs.entries.map((e, i) => {
    const src = loaded.get(i);
    return src === undefined ? e : { ...e, loading: false, src };
  });
  return { ...s, thumbs: { ...s.thumbs, entries } };
};

const thumbUnavailable: Handler<"thumbUnavailable"> = (s, a) => {
  const entry = s.thumbs.entries[a.page];
  if (!(isCurrentDoc(s, a.docId) && entry)) {
    return s;
  }
  const entries = replaceAt(s.thumbs.entries, a.page, {
    ...entry,
    loading: false,
    unavailableTip: a.tip,
  });
  return { ...s, thumbs: { ...s.thumbs, entries } };
};

const handlers: { readonly [T in Action["type"]]: Handler<T> } = {
  allTypesToggled,
  clicked,
  displayModeChanged: (s, a) =>
    withVisibility(s, { ...s.visibility, displayMode: a.mode }),
  documentOpened,
  draggingChanged: (s, a) =>
    s.dragging === a.dragging ? s : { ...s, dragging: a.dragging },
  dropOverChanged: (s, a) =>
    s.dropOver === a.over ? s : { ...s, dropOver: a.over },
  hovered: (s, a) => (s.hovered === a.id ? s : { ...s, hovered: a.id }),
  originalImageFailed,
  originalImageLoaded,
  originalImageRequested,
  pageFailed,
  pageLoaded,
  pageLoadSettled,
  pageProgressTicked,
  pageRequested,
  pageSizeReported,
  rasterOpacityChanged: (s, a) => ({ ...s, rasterOpacity: a.value }),
  selectionCleared: (s) => (s.selection ? { ...s, selection: null } : s),
  statusChanged: (s, a) => ({ ...s, status: a.status }),
  thumbRequested,
  thumbsLoaded,
  thumbsVisibilityChanged: (s, a) => ({
    ...s,
    thumbs: { ...s.thumbs, visible: a.visible },
  }),
  thumbUnavailable,
  tooltipHidden: (s) =>
    s.tooltip.text === null && !s.tooltip.pinned
      ? s
      : { ...s, tooltip: { anchor: null, pinned: false, text: null } },
  tooltipShown: (s, a) => ({
    ...s,
    tooltip: { anchor: a.anchor, pinned: a.pinned, text: a.text },
  }),
  typeVisibilityChanged,
  viewChanged: (s, a) => ({ ...s, view: a.view }),
  viewFitted: (s, a) => {
    const size = s.doc?.pages[s.page.index];
    return size ? { ...s, view: fitView(size, a.viewport) } : s;
  },
};

export const reduce = (s: AppState, a: Action): AppState =>
  (handlers[a.type] as Handler<typeof a.type>)(s, a as never);
