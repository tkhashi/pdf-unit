// 新UIの基本動作(新旧比較で旧UIと一致することを確かめた値を期待値にする)
import { expect, test } from "@playwright/test";
import { generateFixtures } from "./fixtures";
import {
  infoRows,
  openFile,
  openUi,
  settle,
  state,
  text,
  tooltip,
  type Ui,
  viewportBox,
} from "./harness";

const CALIBRATION = /^線幅補正 (×[\d.]+|-)$/;
const TYPE_ROW = /^種類: line {2}#\d+$/;
const TYPE_ROW_SELECTED = /^種類: line {2}#\d+ {2}\(\d+件\)$/;
const FILL_TYPE_ROW = /^種類: fill {2}#\d+$/;

test.beforeAll(async () => {
  await generateFixtures();
});

test("PDFを開いて、凡例・線幅補正・ホバー・選択・ツールチップが働く", async ({
  browser,
}) => {
  const ui = await openUi(browser, "new");
  expect(await ui.page.title()).toBe("PDF Unit");
  await openFile(ui, "vectors.pdf");
  await settle(ui);
  expect(await ui.page.title()).toBe("vectors.pdf - PDF Unit");
  expect(await text(ui, "pageInfo")).toBe("1 / 2 ページ");
  // pdf-lib の色を指定しない矩形は塗りと線の両方で描かれ、rect と fill の両方になる
  expect(await text(ui, "legend")).toBe(
    "line 22rect 3curve 6fill 2text 16image 0"
  );
  expect(await text(ui, "status")).toMatch(CALIBRATION);

  const s = await state(ui);
  const box = await viewportBox(ui);
  // 最初の横線(40, 58)の上
  const x = box.x + s.view.x + 100 * s.view.scale;
  const y = box.y + s.view.y + 62 * s.view.scale;
  await ui.page.mouse.move(x, y);
  await settle(ui);
  expect((await state(ui)).hovered).toBeGreaterThanOrEqual(0);
  expect((await infoRows(ui))[0]).toMatch(TYPE_ROW);
  await ui.page.mouse.click(x, y);
  await settle(ui);
  expect((await infoRows(ui))[0]).toMatch(TYPE_ROW_SELECTED);
  await ui.page.keyboard.press("Escape");
  await settle(ui);
  expect((await state(ui)).selection).toBeNull();

  // 塗りつぶしの矩形(40, 242)-(100, 282)の内側。線幅は示し、描画太さは示さない
  await ui.page.mouse.move(
    box.x + s.view.x + 70 * s.view.scale,
    box.y + s.view.y + 262 * s.view.scale
  );
  await settle(ui);
  const fillRows = await infoRows(ui);
  expect(fillRows[0]).toMatch(FILL_TYPE_ROW);
  expect(fillRows).toContain("線幅: 1");
  expect(fillRows.some((r) => r.startsWith("描画太さ"))).toBe(false);

  await ui.page.getByRole("radio", { name: "ラスター" }).hover();
  await ui.page.waitForTimeout(400);
  expect(await tooltip(ui)).toBe(
    "PDFに埋め込まれた画像だけを表示(線・文字は隠す)"
  );
  expect(ui.cspViolations).toEqual([]);
  expect(ui.errors).toEqual([]);
  await ui.page.context().close();
});

const thumbState = (ui: Ui) =>
  ui.page.evaluate((sel) => {
    const aside = document.querySelector(sel) as HTMLElement;
    return [...aside.querySelectorAll("[data-page]")].map((b) => ({
      loaded: !!b.querySelector("img")?.hasAttribute("src"),
      page: Number((b as HTMLElement).dataset.page),
    }));
  }, ui.sel.thumbs);

test("サムネイルは本体ページの読み込みを待たずに表示され始める", async ({
  browser,
}) => {
  // 本体ページの読み込みを遅らせても、サムネイルはブラウザ内(pdf.js)で描画するため止まらない(ADR 0041)
  const ui = await openUi(browser, "new", {
    delay: { "/api/page/lines": 2000 },
  });
  await openFile(ui, "multipage.pdf");
  await ui.page.waitForFunction(
    (sel) => {
      const aside = document.querySelector(sel);
      return !!aside?.querySelector("[data-page] img[src]");
    },
    ui.sel.thumbs,
    { timeout: 5000 }
  );
  const thumbs = await thumbState(ui);
  expect(thumbs.some((t) => t.loaded)).toBe(true);
  expect(ui.cspViolations).toEqual([]);
  await ui.page.context().close();
});

test("開いた直後から全ページが背景で先読みされ、最終的にすべて表示される", async ({
  browser,
}) => {
  const ui = await openUi(browser, "new");
  await openFile(ui, "multipage.pdf");
  await ui.page.waitForFunction(
    (sel) => {
      const aside = document.querySelector(sel);
      const buttons = aside?.querySelectorAll("[data-page]") ?? [];
      return (
        buttons.length > 0 &&
        [...buttons].every((b) => b.querySelector("img")?.hasAttribute("src"))
      );
    },
    ui.sel.thumbs,
    { timeout: 15_000 }
  );
  const thumbs = await thumbState(ui);
  expect(thumbs.every((t) => t.loaded)).toBe(true);
  expect(ui.errors).toEqual([]);
  await ui.page.context().close();
});
