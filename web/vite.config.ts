/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// 本番ビルドの index.html に付ける CSP(ADR 0030)。開発サーバーは HMR 用のインラインスクリプトを使うため付けない
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const contentSecurityPolicy = (): Plugin => ({
  apply: "build",
  name: "pdf-unit:csp",
  transformIndexHtml: () => [
    {
      attrs: {
        content: CONTENT_SECURITY_POLICY,
        "http-equiv": "Content-Security-Policy",
      },
      injectTo: "head-prepend",
      tag: "meta",
    },
  ],
});

// 画面に出すアプリの版(ADR 0033)。版の正は Git のタグ(vX.Y.Z)。デプロイのワークフローは次の版を APP_VERSION で
// 渡す。手元では git describe の結果(タグは main のマージコミットに付くため、development 系では通常コミットの
// ハッシュ)を使い、取れなければ "dev" にする
const TAG_PREFIX = /^v/;
const appVersion = (): string => {
  if (process.env.APP_VERSION) {
    return process.env.APP_VERSION;
  }
  try {
    return execSync("git describe --tags --always --dirty", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(TAG_PREFIX, "");
  } catch {
    return "dev";
  }
};

// API サーバー(uvicorn)の待ち受け先。ユーザーが使う 127.0.0.1:8000 と衝突しないよう既定は 8765
const apiTarget = process.env.PDF_UNIT_API ?? "http://127.0.0.1:8765";

export default defineConfig(({ mode }) => ({
  // index.html と assets/ を同じ場所に置けばどこでも動くよう相対パスで参照する
  base: "./",
  build: {
    // pdf-lib(約0.5MB)を含むため1ファイルが大きい。分割しても初回表示に全部必要なので警告の閾値だけ上げる
    chunkSizeWarningLimit: 800,
    emptyOutDir: true,
    license: { fileName: "licenses.md" },
    // 本番は FastAPI / S3 が配信する src/pdf_unit/static へ。E2E 用(状態参照フック入り)は別の場所へ出す
    outDir: mode === "e2e" ? "dist-e2e" : "../src/pdf_unit/static",
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  server: {
    proxy: { "/api": apiTarget },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
}));
