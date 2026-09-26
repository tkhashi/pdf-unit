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
  viewportBox,
} from "./harness";

const CALIBRATION = /^線幅補正 (×[\d.]+|-)$/;
const TYPE_ROW = /^種類: line {2}#\d+$/;
const TYPE_ROW_SELECTED = /^種類: line {2}#\d+ {2}\(\d+件\)$/;

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
  expect(await text(ui, "legend")).toBe("line 22rect 3curve 6text 16image 0");
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

  await ui.page.getByRole("radio", { name: "ラスター" }).hover();
  await ui.page.waitForTimeout(400);
  expect(await tooltip(ui)).toBe(
    "PDFに埋め込まれた画像だけを表示(線・文字は隠す)"
  );
  expect(ui.cspViolations).toEqual([]);
  expect(ui.errors).toEqual([]);
  await ui.page.context().close();
});
