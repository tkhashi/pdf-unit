import { describe, expect, it } from "vitest";
import { buildPageModel } from "../domain/page-model";
import { sampleLines } from "../test/sample";
import type { Action } from "./actions";
import { reduce } from "./reducer";
import { type AppState, INITIAL_STATE } from "./state";

const viewport = { height: 648, width: 848 };
const run = (actions: readonly Action[], s: AppState = INITIAL_STATE) =>
  actions.reduce(reduce, s);

const opened = run([
  {
    doc: { filename: "a.pdf", id: 1, pages: [{ height: 300, width: 400 }] },
    thumbsVisible: true,
    type: "documentOpened",
  },
  { index: 0, type: "pageRequested", viewport },
]);
const model = buildPageModel(sampleLines());
const loaded = run([{ model, request: 1, type: "pageLoaded" }], opened);

describe("ページの読み込み", () => {
  it("ページを要求すると選択・ホバー・原本画像を初期化し、全体表示にする", () => {
    expect(opened.page).toMatchObject({ index: 0, loading: true, request: 1 });
    expect(opened.view).toEqual({ scale: 2, x: 24, y: 24 });
    expect(opened.status.text).toBe("抽出中...");
    expect(opened.thumbs.entries).toHaveLength(1);
  });

  it("線データを受け取ると凡例と線幅補正を表示する", () => {
    expect(loaded.legendCounts).toEqual(model.counts);
    expect(loaded.status.text).toBe("線幅補正 ×0.5");
    expect(loaded.status.tip).toContain("実測して算出しました");
  });

  it("古い要求への応答は捨てる", () => {
    const next = run([{ index: 0, type: "pageRequested", viewport }], loaded);
    expect(run([{ model, request: 1, type: "pageLoaded" }], next)).toBe(next);
    expect(run([{ message: "x", request: 1, type: "pageFailed" }], next)).toBe(
      next
    );
    expect(
      run([{ durationMs: 10, request: 2, type: "pageLoadSettled" }], next).page
        .loading
    ).toBe(false);
  });

  it("応答受信では進捗を変えず、実測時間だけ次回の見積もりに残す", () => {
    const settled = run(
      [{ durationMs: 1234, request: 1, type: "pageLoadSettled" }],
      opened
    );
    expect(settled.page.progress).not.toBeNull();
    expect(settled.lastPageDurationMs).toBe(1234);
  });

  it("成功すると進捗を100%にし、少し後に消す", () => {
    expect(loaded.page.progress).toMatchObject({ ratio: 1, stageIndex: 5 });
    const cleared = run([{ request: 1, type: "pageProgressCleared" }], loaded);
    expect(cleared.page.progress).toBeNull();
  });

  it("失敗すると進捗を即座に消す", () => {
    const failed = run(
      [{ message: "x", request: 1, type: "pageFailed" }],
      opened
    );
    expect(failed.page.progress).toBeNull();
  });

  it("進捗の更新は現在の要求のものだけ反映する", () => {
    const ticked = run(
      [{ ratio: 0.5, request: 1, stageIndex: 2, type: "pageProgressTicked" }],
      opened
    );
    expect(ticked.page.progress).toMatchObject({ ratio: 0.5, stageIndex: 2 });
    expect(
      run(
        [
          {
            ratio: 0.9,
            request: 999,
            stageIndex: 5,
            type: "pageProgressTicked",
          },
        ],
        opened
      )
    ).toBe(opened);
  });

  it("サーバーのページ寸法と食い違えば合わせて全体表示し直す", () => {
    const s = run(
      [
        {
          pageSize: { height: 300, width: 400.02 },
          request: 1,
          type: "pageSizeReported",
          viewport,
        },
      ],
      opened
    );
    expect(s.doc?.pages[0]).toEqual({ height: 300, width: 400.02 });
    const same = run(
      [
        {
          pageSize: { height: 300.005, width: 400 },
          request: 1,
          type: "pageSizeReported",
          viewport,
        },
      ],
      opened
    );
    expect(same).toBe(opened);
  });
});

describe("原本画像", () => {
  it("要求した段階より高い解像度だけを要求・受け取りし、失敗したら段階を戻す", () => {
    const req = run(
      [{ docId: 1, page: 0, res: 200, type: "originalImageRequested" }],
      loaded
    );
    expect(req.originalImage.requestedRes).toBe(200);
    const lower = run(
      [{ docId: 1, page: 0, res: 100, type: "originalImageRequested" }],
      req
    );
    expect(lower).toBe(req);
    const got = run(
      [
        {
          docId: 1,
          page: 0,
          resolution: 150,
          src: "a",
          type: "originalImageLoaded",
        },
        {
          docId: 1,
          page: 0,
          resolution: 100,
          src: "b",
          type: "originalImageLoaded",
        },
      ],
      req
    );
    expect(got.originalImage).toEqual({
      receivedRes: 150,
      requestedRes: 200,
      src: "a",
    });
    expect(
      run([{ docId: 1, page: 0, res: 100, type: "originalImageFailed" }], got)
    ).toBe(got);
    expect(
      run([{ docId: 1, page: 0, res: 200, type: "originalImageFailed" }], got)
        .originalImage.requestedRes
    ).toBe(0);
    expect(
      run(
        [{ docId: 2, page: 0, res: 400, type: "originalImageRequested" }],
        got
      )
    ).toBe(got);
  });
});

describe("表示対象と選択", () => {
  it("クリックで選択し、表示対象の変更で選択を絞ってホバーを外す", () => {
    const s = run([{ id: 0, type: "clicked" }], loaded);
    expect(s.hovered).toBe(0);
    expect(s.selection?.members).toEqual([0, 1, 2]);
    const hidden = run(
      [{ itemType: "rect", type: "typeVisibilityChanged", visible: false }],
      s
    );
    expect(hidden.hovered).toBe(-1);
    expect(hidden.selection?.members).toEqual([0, 1, 2]);
    expect(
      run([{ mode: "raster", type: "displayModeChanged" }], s).selection
    ).toBeNull();
  });

  it("一括チェックは、一部でも非表示なら全部表示、全部表示中なら全部非表示", () => {
    const one = run(
      [{ itemType: "text", type: "typeVisibilityChanged", visible: false }],
      loaded
    );
    const all = run([{ type: "allTypesToggled" }], one);
    expect([...all.visibility.hiddenTypes]).toEqual([]);
    const none = run([{ type: "allTypesToggled" }], all);
    expect(none.visibility.hiddenTypes.size).toBe(5);
  });

  it("何もない所のクリックで解除、同じホバーは状態を変えない", () => {
    const s = run([{ id: 0, type: "clicked" }], loaded);
    expect(run([{ id: -1, type: "clicked" }], s).selection).toBeNull();
    expect(run([{ id: 0, type: "hovered" }], s)).toBe(s);
  });
});

describe("サムネイル", () => {
  it("別の文書への応答は捨てる", () => {
    const s = run(
      [
        { docId: 1, thumbs: [{ page: 0, src: "x" }], type: "thumbsLoaded" },
        { docId: 2, page: 0, tip: "t", type: "thumbUnavailable" },
      ],
      loaded
    );
    expect(s.thumbs.entries).toEqual([{ src: "x", unavailableTip: null }]);
  });
});
