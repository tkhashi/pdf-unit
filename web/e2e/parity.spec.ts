// 旧UI(BASE_REF の index.html)と新UIに同じ操作をして、状態・表示内容・通信・描画結果が一致することを確かめる。
// PARITY=1 のときだけ実行する(移行の検証用。ADR 0031)
import { type Browser, expect, test } from "@playwright/test";
import { generateFixtures } from "./fixtures";
import {
  canvasData,
  equalizeViewports,
  frames,
  imageMasks,
  infoRows,
  type OpenOptions,
  openFile,
  openUi,
  perfPattern,
  pixelDiff,
  settle,
  state,
  text,
  tooltip,
  type Ui,
  viewportBox,
  visibleText,
} from "./harness";

test.skip(!process.env.PARITY, "PARITY=1 のときだけ実行する");

test.beforeAll(async () => {
  await generateFixtures();
});

interface Pair {
  readonly both: readonly [Ui, Ui];
  readonly newUi: Ui;
  readonly oldUi: Ui;
}

const openPair = async (
  browser: Browser,
  opts: OpenOptions = {}
): Promise<Pair> => {
  const oldUi = await openUi(browser, "old", opts);
  const newUi = await openUi(browser, "new", opts);
  return { both: [oldUi, newUi], newUi, oldUi };
};

const load = async (p: Pair, file: string) => {
  for (const ui of p.both) {
    await openFile(ui, file);
    await settle(ui);
  }
  await equalizeViewports(p.oldUi, p.newUi);
};

/** 両方の UI の値を取り出して比べる */
const same = async <T>(p: Pair, f: (ui: Ui) => Promise<T>, what: string) => {
  const a = await f(p.oldUi);
  const b = await f(p.newUi);
  expect(b as unknown, what).toEqual(a);
  return a;
};

// 埋め込み画像の描き方は新旧で異なる(新UIは枠と原本画像。ADR 0039)ので、画像の範囲は比べない
const sameCanvases = async (p: Pair, what: string) => {
  const masks = await imageMasks(p.newUi);
  for (const key of ["scene", "highlight"] as const) {
    const a = await canvasData(p.oldUi, key);
    const b = await canvasData(p.newUi, key);
    if (a !== b) {
      const n = await pixelDiff(p.newUi, a, b, masks);
      expect(n, `${what}: ${key} の画素の差`).toBe(0);
    }
  }
};

/** 表示領域内の座標(左上原点)へマウスを動かす */
const moveTo = async (ui: Ui, x: number, y: number) => {
  const box = await viewportBox(ui);
  await ui.page.mouse.move(box.x + x, box.y + y);
  await frames(ui, 2);
};

const clickAt = async (ui: Ui, x: number, y: number) => {
  const box = await viewportBox(ui);
  await ui.page.mouse.click(box.x + x, box.y + y);
  await frames(ui, 2);
};

const wheelAt = async (ui: Ui, x: number, y: number, deltaY: number) => {
  await moveTo(ui, x, y);
  await ui.page.mouse.wheel(0, deltaY);
  await frames(ui, 2);
};

/** サムネイルでページを切り替える。凡例の件数でヘッダーの折返しが変わるため、表示領域の大きさを揃え直す */
const switchPage = async (p: Pair, page: number) => {
  for (const ui of p.both) {
    const thumb = ui.page.locator(`${ui.sel.thumbs} [data-page="${page}"]`);
    await thumb.scrollIntoViewIfNeeded();
    await thumb.click();
    await settle(ui);
  }
  await equalizeViewports(p.oldUi, p.newUi);
};

const closeAll = async (p: Pair) => {
  for (const ui of p.both) {
    expect(ui.errors, `${ui.kind} のページのエラー`).toEqual([]);
    await ui.page.context().close();
  }
};

test("文書を開いた直後の表示・通信・計測ログが一致する", async ({
  browser,
}) => {
  const p = await openPair(browser);
  await same(p, (ui) => ui.page.title(), "開く前の title");
  await same(p, (ui) => visibleText(ui, "status"), "開く前のステータス");
  await load(p, "vectors.pdf");
  await same(p, (ui) => ui.page.title(), "title");
  await same(p, (ui) => text(ui, "docName"), "ファイル名");
  await same(p, (ui) => text(ui, "pageInfo"), "ページ表示");
  await same(p, (ui) => visibleText(ui, "status"), "ステータス");
  await same(p, (ui) => text(ui, "legend"), "凡例");
  await same(p, state, "状態");
  await same(
    p,
    async (ui) =>
      ui.apiCalls
        // 新UIは埋め込み画像の画像データを要求しない(ADR 0039)
        .filter((c) => !c.path.startsWith("/api/page/images"))
        .map((c) => `${c.path} ${c.sha256}`)
        .sort(),
    "API 呼び出し(パスと送ったPDFのSHA-256。埋め込み画像の画像データを除く)"
  );
  await same(
    p,
    async (ui) =>
      ui.apiCalls.find((c) => c.path.startsWith("/api/page/"))?.path,
    "最初のページAPI(原本画像が線データより先)"
  );
  await same(
    p,
    async (ui) => perfPattern(ui.consoleDebug).sort(),
    "console.debug の計測ログ"
  );
  await sameCanvases(p, "開いた直後");
  expect(p.newUi.cspViolations).toEqual([]);
  await closeAll(p);
});

/** 旧UIの要素ごとの「当たる点」(ページ座標)。線は最初の頂点、文字・画像は枠の中心 */
const itemPoints = (ui: Ui) =>
  ui.page.evaluate(
    () =>
      new Function(`return items.map((it) => it.polylines
        ? { id: it.id, type: it.type, x: it.polylines[0][0], y: it.polylines[0][1] }
        : { id: it.id, type: it.type, x: (it.bbox[0] + it.bbox[2]) / 2, y: (it.bbox[1] + it.bbox[3]) / 2 })`)() as {
        id: number;
        type: string;
        x: number;
        y: number;
      }[]
  );

const toScreen = async (ui: Ui, x: number, y: number) => {
  const { view } = await state(ui);
  return { x: view.x + x * view.scale, y: view.y + y * view.scale };
};

const sweep = async (p: Pair, label: string, cols = 24, rows = 16) => {
  const box = await viewportBox(p.oldUi);
  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      const x = ((i + 0.5) * box.width) / cols;
      const y = ((j + 0.5) * box.height) / rows;
      for (const ui of p.both) {
        await moveTo(ui, x, y);
      }
      const at = `${label} (${Math.round(x)}, ${Math.round(y)})`;
      await same(p, async (ui) => (await state(ui)).hovered, `${at} のホバー`);
      await same(p, infoRows, `${at} の属性パネル`);
    }
  }
};

test("ホバーの対象・属性パネル・ハイライトの描画が一致する(ズーム・パン含む)", async ({
  browser,
}) => {
  const p = await openPair(browser);
  await load(p, "vectors.pdf");
  await sweep(p, "全体表示");
  const box = await viewportBox(p.oldUi);
  for (const ui of p.both) {
    await wheelAt(ui, box.width * 0.3, box.height * 0.3, -600);
    await settle(ui);
  }
  await same(p, state, "ズーム後の状態");
  await sweep(p, "ズーム後", 16, 10);
  await sameCanvases(p, "ズーム後のホバー");
  // ドラッグ(4px 未満はクリック扱い、以上は移動)
  for (const ui of p.both) {
    const b = await viewportBox(ui);
    await ui.page.mouse.move(b.x + 400, b.y + 300);
    await ui.page.mouse.down();
    await ui.page.mouse.move(b.x + 402, b.y + 301);
    await ui.page.mouse.move(b.x + 250, b.y + 200, { steps: 5 });
    await ui.page.mouse.up();
    await settle(ui);
  }
  await same(p, state, "ドラッグ後の状態");
  await sameCanvases(p, "ドラッグ後");
  // 最大まで拡大して原本画像の解像度段階を上げる
  for (const ui of p.both) {
    for (let k = 0; k < 6; k += 1) {
      await wheelAt(ui, 300, 300, -800);
    }
    await settle(ui);
  }
  await same(p, state, "最大拡大後の状態");
  await same(
    p,
    async (ui) =>
      ui.apiCalls
        .filter((c) => c.path.startsWith("/api/page/image?"))
        .map((c) => c.path),
    "原本画像の要求の順序"
  );
  await sameCanvases(p, "最大拡大後");
  await closeAll(p);
});

test("クリックで属性を巡回する選択・Esc・何もない所のクリックが一致する", async ({
  browser,
}) => {
  const p = await openPair(browser);
  await load(p, "vectors.pdf");
  const points = await itemPoints(p.oldUi);
  const sample = points.filter((_, i) => i % 3 === 0);
  for (const pt of sample) {
    const s = await toScreen(p.oldUi, pt.x, pt.y);
    for (let k = 0; k < 9; k += 1) {
      for (const ui of p.both) {
        await clickAt(ui, s.x, s.y);
      }
      const at = `要素 #${pt.id}(${pt.type})の ${k + 1} 回目のクリック`;
      const st = await same(p, state, at);
      await same(p, infoRows, `${at} の属性パネル`);
      if (k % 3 === 0) {
        await sameCanvases(p, at);
      }
      if (!st.selection) {
        break;
      }
    }
  }
  // 選択中に Esc で解除
  const [first] = sample;
  if (first) {
    const s = await toScreen(p.oldUi, first.x, first.y);
    for (const ui of p.both) {
      await clickAt(ui, s.x, s.y);
      await ui.page.keyboard.press("Escape");
      await frames(ui);
    }
    await same(p, state, "Esc 後");
    await sameCanvases(p, "Esc 後");
  }
  // 何もない所のクリック
  for (const ui of p.both) {
    await clickAt(ui, 5, 5);
  }
  await same(p, state, "何もない所のクリック後");
  await closeAll(p);
});

test("選択中に種類・一括・表示切替を変えたときの選択・凡例・描画が一致する", async ({
  browser,
}) => {
  const p = await openPair(browser);
  await load(p, "vectors.pdf");
  await load(p, "vectors.pdf");
  const points = await itemPoints(p.oldUi);
  const legendState = (ui: Ui) =>
    ui.page.evaluate(
      (sel) =>
        [...document.querySelectorAll(`${sel} input[type=checkbox]`)].map(
          (c) =>
            `${(c as HTMLInputElement).checked}/${(c as HTMLInputElement).indeterminate}`
        ),
      ui.sel.legend
    );
  const toggles: ((ui: Ui) => Promise<void>)[] = [
    (ui) =>
      ui.page.locator(`${ui.sel.legend} input[type=checkbox]`).nth(1).click(),
    (ui) =>
      ui.page.locator(`${ui.sel.legend} input[type=checkbox]`).nth(4).click(),
    (ui) =>
      ui.page.locator(`${ui.sel.legend} input[type=checkbox]`).nth(0).click(),
    (ui) =>
      ui.page.locator(`${ui.sel.legend} input[type=checkbox]`).nth(0).click(),
    (ui) => ui.page.getByRole("radio", { name: "ベクター" }).click(),
    (ui) => ui.page.getByRole("radio", { name: "ラスター" }).click(),
    (ui) => ui.page.getByRole("radio", { name: "ラスター" }).click(),
    (ui) => ui.page.getByRole("radio", { name: "両方" }).click(),
    (ui) =>
      ui.page.locator(`${ui.sel.legend} input[type=checkbox]`).nth(2).click(),
    (ui) =>
      ui.page.locator(`${ui.sel.legend} input[type=checkbox]`).nth(0).click(),
  ];
  for (const pt of points.filter((_, i) => i % 7 === 0)) {
    const s = await toScreen(p.oldUi, pt.x, pt.y);
    for (const [k, toggle] of toggles.entries()) {
      for (const ui of p.both) {
        await clickAt(ui, s.x, s.y);
        await clickAt(ui, s.x, s.y);
        await toggle(ui);
        await frames(ui);
      }
      const at = `要素 #${pt.id} を選択中に切替 ${k + 1}`;
      await same(p, state, at);
      await same(p, legendState, `${at} の凡例`);
      await same(p, infoRows, `${at} の属性パネル`);
      await sameCanvases(p, at);
      await moveTo(p.oldUi, s.x, s.y);
      await moveTo(p.newUi, s.x, s.y);
      await same(p, async (ui) => (await state(ui)).hovered, `${at} のホバー`);
    }
  }
  await closeAll(p);
});

test("ヒット判定がページ全体で一致する(ブラウザ内で多数の点を判定)", async ({
  browser,
}) => {
  const p = await openPair(browser);
  await load(p, "vectors.pdf");
  const probe = (ui: Ui, scale: number) =>
    ui.page.evaluate(
      ([kind, sc]) => {
        let seed = 7;
        const rnd = () => {
          seed = (seed * 16_807) % 2_147_483_647;
          return seed / 2_147_483_647;
        };
        const out: number[] = [];
        const w = window as unknown as Record<string, unknown>;
        for (let i = 0; i < 20_000; i += 1) {
          const x = rnd() * 600 - 2;
          const y = rnd() * 850 - 2;
          if (kind === "old") {
            out.push(
              new Function(
                "x",
                "y",
                "sc",
                "view.scale = sc; return pick(x, y);"
              )(x, y, sc) as number
            );
          } else {
            const hook = w.__pdfUnit as {
              controller: { app: { getState: () => never } };
              pick: (...a: unknown[]) => number;
            };
            const s = hook.controller.app.getState() as {
              page: { model: { items: unknown; index: unknown } };
              visibility: { displayMode: string; hiddenTypes: Set<string> };
            };
            const v = s.visibility;
            const hidden = (t: string) =>
              v.hiddenTypes.has(t) ||
              (v.displayMode === "vector" && t === "image") ||
              (v.displayMode === "raster" && t !== "image");
            out.push(
              hook.pick(
                s.page.model.items,
                s.page.model.index,
                x,
                y,
                sc,
                hidden
              )
            );
          }
        }
        return out;
      },
      [ui.kind, scale] as const
    );
  for (const scale of [0.3, 1, 4, 40]) {
    const a = await probe(p.oldUi, scale);
    const b = await probe(p.newUi, scale);
    expect(b, `倍率 ${scale} のヒット判定`).toEqual(a);
    expect(a.some((id) => id >= 0)).toBe(true);
  }
  await closeAll(p);
});

test("複数ページ: サムネイルの取得・ページ切替・一覧の開閉が一致する", async ({
  browser,
}) => {
  const p = await openPair(browser);
  await load(p, "multipage.pdf");
  const thumbState = (ui: Ui) =>
    ui.page.evaluate((sel) => {
      const aside = document.querySelector(sel) as HTMLElement;
      return {
        hidden: aside.hidden,
        loaded: [...aside.querySelectorAll("img")].map((i) =>
          i.hasAttribute("src")
        ),
        tips: [...aside.querySelectorAll("[data-page]")].map((b) =>
          b.getAttribute("data-tip")
        ),
      };
    }, ui.sel.thumbs);
  await same(p, thumbState, "開いた直後のサムネイル");
  const thumbCalls = (ui: Ui) =>
    Promise.resolve(
      ui.apiCalls
        .filter((c) => c.path.startsWith("/api/thumbs"))
        .map((c) => `${c.path} ${c.sha256}`)
    );
  await same(p, thumbCalls, "サムネイルの要求");
  for (const page of [3, 12, 24, 0]) {
    await switchPage(p, page);
    await same(p, (ui) => text(ui, "pageInfo"), `${page + 1}ページ目の表示`);
    await same(p, state, `${page + 1}ページ目の状態`);
    await same(p, thumbState, `${page + 1}ページ目のサムネイル`);
    await sameCanvases(p, `${page + 1}ページ目`);
  }
  await same(p, thumbCalls, "スクロール後のサムネイルの要求");
  await same(p, async (ui) => ui.maxThumbsInFlight, "サムネイルの同時要求数");
  // 一覧を閉じる・開く(表示の大きさは変わるが全体表示には戻さない)
  for (const ui of p.both) {
    await ui.page
      .getByRole("button", { name: "サムネイル一覧を閉じる" })
      .click();
    await settle(ui);
  }
  await same(p, thumbState, "閉じたサムネイル");
  await same(p, async (ui) => (await state(ui)).view, "閉じた後の表示");
  for (const ui of p.both) {
    await ui.page.getByRole("button", { name: "サムネイル一覧を開く" }).click();
    await settle(ui);
  }
  await same(p, thumbState, "開き直したサムネイル");
  await closeAll(p);
});

test("ページ連続切替で遅れて届く古い応答を捨てる動作が一致する", async ({
  browser,
}) => {
  const p = await openPair(browser, { delay: { "/api/page/lines": 300 } });
  await load(p, "multipage.pdf");
  for (const ui of p.both) {
    for (const page of [1, 2, 5]) {
      await ui.page.locator(`${ui.sel.thumbs} [data-page="${page}"]`).click();
    }
    await settle(ui);
  }
  await equalizeViewports(p.oldUi, p.newUi);
  await same(p, (ui) => text(ui, "pageInfo"), "最後に選んだページの表示");
  await same(p, state, "状態");
  await same(p, (ui) => text(ui, "legend"), "凡例");
  await sameCanvases(p, "連続切替後");
  await closeAll(p);
});

test("ツールチップ(遅延表示・固定・ライブ更新)が一致する", async ({
  browser,
}) => {
  const p = await openPair(browser);
  await load(p, "vectors.pdf");
  const targets: ((ui: Ui) => ReturnType<Ui["page"]["locator"]>)[] = [
    (ui) => ui.page.getByRole("radio", { name: "ベクター" }),
    (ui) => ui.page.locator(ui.sel.status),
    (ui) => ui.page.locator(ui.sel.docName),
    (ui) => ui.page.locator(`${ui.sel.legend} label`).nth(2),
    (ui) => ui.page.locator("input[type=range]"),
    (ui) => ui.page.locator(`${ui.sel.thumbs} [data-page="0"]`),
  ];
  for (const [k, target] of targets.entries()) {
    for (const ui of p.both) {
      await target(ui).hover();
      await ui.page.waitForTimeout(400);
    }
    await same(p, tooltip, `対象 ${k + 1} のツールチップ`);
  }
  // 原本の濃さを変えるとツールチップの文が追従する
  for (const ui of p.both) {
    const range = ui.page.locator("input[type=range]");
    await range.hover();
    await ui.page.waitForTimeout(400);
    await range.fill("55");
    await ui.page.waitForTimeout(50);
  }
  await same(p, tooltip, "濃さ変更後のツールチップ");
  // ヘルプの固定と Esc
  for (const ui of p.both) {
    await ui.page.getByRole("button", { name: "操作説明" }).click();
    await ui.page.mouse.move(10, 10);
    await ui.page.waitForTimeout(400);
  }
  await same(p, tooltip, "固定したヘルプ");
  await same(
    p,
    (ui) =>
      ui.page
        .getByRole("button", { name: "操作説明" })
        .getAttribute("aria-expanded"),
    "ヘルプの aria-expanded"
  );
  for (const ui of p.both) {
    await ui.page.keyboard.press("Escape");
    await frames(ui);
  }
  await same(p, tooltip, "Esc 後のヘルプ");
  // 表示までの遅延(250ms): 対象へ入った直後は出ず、250ms 後に出る
  for (const ui of p.both) {
    await ui.page.mouse.move(5, 5);
    await ui.page.waitForTimeout(50);
  }
  const delayed = (ui: Ui) =>
    ui.page.evaluate(async () => {
      const el = document.querySelector('[role="radio"]') as HTMLElement;
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      const visible = () => {
        const tip = document.querySelector("[role=tooltip]") as HTMLElement;
        return !tip.hidden;
      };
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await wait(200);
      const early = visible();
      await wait(120);
      return { early, late: visible() };
    });
  await same(p, delayed, "250ms の遅延");
  await closeAll(p);
});

test("エラー(暗号化・PDFでない・大きすぎるページ)の表示が一致する", async ({
  browser,
}) => {
  for (const file of ["encrypted.pdf", "not-a-pdf.pdf"]) {
    const p = await openPair(browser);
    for (const ui of p.both) {
      await openFile(ui, file);
      await settle(ui);
    }
    await same(
      p,
      (ui) => visibleText(ui, "status"),
      `${file} を最初に開いたときのステータス`
    );
    await same(p, state, `${file} の状態`);
    await load(p, "vectors.pdf");
    for (const ui of p.both) {
      await openFile(ui, file);
      await settle(ui);
    }
    await same(
      p,
      (ui) => visibleText(ui, "status"),
      `${file} を2つ目に開いたときのステータス`
    );
    await same(p, (ui) => text(ui, "docName"), `${file} の後の文書名`);
    await closeAll(p);
  }
  const p = await openPair(browser);
  await load(p, "heavy.pdf");
  await switchPage(p, 1);
  await same(
    p,
    (ui) => visibleText(ui, "status"),
    "大きすぎるページのステータス"
  );
  await same(
    p,
    (ui) =>
      ui.page
        .locator(`${ui.sel.thumbs} [data-page="1"]`)
        .getAttribute("data-tip"),
    "大きすぎるページのサムネイル"
  );
  await same(p, state, "大きすぎるページの状態");
  await closeAll(p);
});

test("2つ目の文書: 表示設定を引き継ぎ、回転・CropBox のページ寸法が一致する", async ({
  browser,
}) => {
  const p = await openPair(browser);
  await load(p, "vectors.pdf");
  for (const ui of p.both) {
    await ui.page
      .locator(`${ui.sel.legend} input[type=checkbox]`)
      .nth(3)
      .click();
    await ui.page.getByRole("radio", { name: "ベクター" }).click();
    await ui.page.locator("input[type=range]").fill("70");
  }
  await load(p, "geometry.pdf");
  await same(p, state, "2つ目の文書の状態");
  await same(p, (ui) => text(ui, "legend"), "凡例");
  await same(p, (ui) => ui.page.title(), "title");
  for (const page of [0, 1, 2]) {
    await switchPage(p, page);
    await same(p, state, `geometry ${page + 1}ページ目の状態`);
    await sameCanvases(p, `geometry ${page + 1}ページ目`);
    await sweep(p, `geometry ${page + 1}ページ目`, 12, 8);
  }
  await closeAll(p);
});

test("高DPI(devicePixelRatio 2)の描画と原本画像の解像度が一致する", async ({
  browser,
}) => {
  const p = await openPair(browser, { dpr: 2 });
  await load(p, "vectors.pdf");
  await same(p, state, "状態");
  await sameCanvases(p, "DPR 2");
  const pts = await itemPoints(p.oldUi);
  const [, , , , , pt] = pts;
  if (pt) {
    const s = await toScreen(p.oldUi, pt.x, pt.y);
    for (const ui of p.both) {
      await clickAt(ui, s.x, s.y);
    }
    await sameCanvases(p, "DPR 2 の選択");
  }
  await same(
    p,
    async (ui) =>
      ui.apiCalls
        .filter(
          (c) => c.path.includes("width=") || c.path.includes("resolution=")
        )
        .map((c) => c.path),
    "DPR に応じた要求"
  );
  await closeAll(p);
});
