import { defineConfig } from "@playwright/test";

// 画面は page.route で配信し、API だけ実サーバー(PDF_UNIT_API、既定 127.0.0.1:8765)へ中継する(e2e/harness.ts)。
// 事前に `pnpm e2e:build` と API サーバーの起動が必要
export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  reporter: [["list"]],
  testDir: "e2e",
  timeout: 180_000,
  use: { browserName: "chromium" },
  workers: 1,
});
