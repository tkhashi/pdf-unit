// 新旧 UI を同じ条件で動かすための道具。旧UIは BASE_REF の index.html(git show)、新UIは dist-e2e を配信し、
// /api/* だけを同じ API サーバーへ中継する(差分が UI 由来だけになるように)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const REPO = join(WEB, "..");
export const FIXTURES = join(HERE, ".fixtures");
export const BASE_REF = process.env.BASE_REF ?? "7acb834";
const API = process.env.PDF_UNIT_API ?? "http://127.0.0.1:8765";
// crypto.subtle を使うため localhost(安全なコンテキスト)にする。実際には待ち受けず route で応答する
export const ORIGIN = "http://localhost:8799";

export type Kind = "old" | "new";

const gitShow = (path: string): Buffer =>
  execFileSync("git", ["-C", REPO, "show", `${BASE_REF}:${path}`], {
    maxBuffer: 64 * 1024 * 1024,
  });

const legacy = {
  index: gitShow("src/pdf_unit/static/index.html"),
  pdfLib: gitShow("src/pdf_unit/static/vendor/pdf-lib.min.js"),
};

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
};

const newFile = (path: string): { body: Buffer; type: string } | null => {
  const file = join(WEB, "dist-e2e", path === "/" ? "index.html" : path);
  return existsSync(file)
    ? {
        body: readFileSync(file),
        type: TYPES[extname(file)] ?? "application/octet-stream",
      }
    : null;
};

export interface ApiCall {
  readonly path: string;
  readonly sha256: string;
}

export interface Ui {
  readonly apiCalls: ApiCall[];
  readonly consoleDebug: string[];
  readonly cspViolations: string[];
  readonly errors: string[];
  inFlight: number;
  readonly kind: Kind;
  readonly page: Page;
  readonly sel: Readonly<Record<SelKey, string>>;
}

type SelKey =
  | "docName"
  | "highlight"
  | "info"
  | "legend"
  | "pageInfo"
  | "scene"
  | "status"
  | "thumbs"
  | "viewport";

const SELECTORS: Record<Kind, Record<SelKey, string>> = {
  new: {
    docName: "[data-testid=doc-name]",
    highlight: "[data-testid=highlight-canvas]",
    info: "[data-testid=info]",
    legend: "[data-testid=legend]",
    pageInfo: "[data-testid=page-info]",
    scene: "[data-testid=scene-canvas]",
    status: "[data-testid=status]",
    thumbs: "[data-testid=thumbs]",
    viewport: "[data-testid=viewport]",
  },
  old: {
    docName: "#docName",
    highlight: "#hlc",
    info: "#info",
    legend: "#legend",
    pageInfo: "#pageInfo",
    scene: "#vec",
    status: "#status",
    thumbs: "#thumbs",
    viewport: "#viewport",
  },
};

export interface OpenOptions {
  /** API の応答を遅らせる(ms)。パスの一部で指定 */
  readonly delay?: Readonly<Record<string, number>>;
  readonly dpr?: number;
  readonly height?: number;
  readonly width?: number;
}

export const openUi = async (
  browser: Browser,
  kind: Kind,
  opts: OpenOptions = {}
): Promise<Ui> => {
  const context = await browser.newContext({
    deviceScaleFactor: opts.dpr ?? 1,
    viewport: { height: opts.height ?? 800, width: opts.width ?? 1280 },
  });
  const page = await context.newPage();
  const ui: Ui = {
    apiCalls: [],
    consoleDebug: [],
    cspViolations: [],
    errors: [],
    inFlight: 0,
    kind,
    page,
    sel: SELECTORS[kind],
  };
  page.on("console", (m) => {
    if (m.type() === "debug") {
      ui.consoleDebug.push(m.text());
    }
  });
  page.on("pageerror", (e) => ui.errors.push(String(e)));
  await page.exposeFunction("__cspViolation", (v: string) =>
    ui.cspViolations.push(v)
  );
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      (
        window as unknown as { __cspViolation: (v: string) => void }
      ).__cspViolation(`${e.violatedDirective} ${e.blockedURI}`)
    );
  });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      const path = url.pathname + url.search;
      ui.apiCalls.push({
        path,
        sha256: route.request().headers()["x-amz-content-sha256"] ?? "",
      });
      ui.inFlight += 1;
      try {
        const wait = Object.entries(opts.delay ?? {}).find(([k]) =>
          path.includes(k)
        )?.[1];
        if (wait) {
          await new Promise((r) => setTimeout(r, wait));
        }
        const response = await route.fetch({ url: API + path });
        await route.fulfill({ response });
      } finally {
        ui.inFlight -= 1;
      }
      return;
    }
    if (kind === "old") {
      if (url.pathname === "/") {
        await route.fulfill({ body: legacy.index, contentType: "text/html" });
      } else if (url.pathname === "/vendor/pdf-lib.min.js") {
        await route.fulfill({
          body: legacy.pdfLib,
          contentType: "text/javascript",
        });
      } else {
        await route.fulfill({ status: 404 });
      }
      return;
    }
    const f = newFile(url.pathname);
    await (f
      ? route.fulfill({ body: f.body, contentType: f.type })
      : route.fulfill({ status: 404 }));
  });
  // pdf-lib は切り出したPDFに作成日時を書くため、時刻を固定して送るバイト列(SHA-256)を比べられるようにする
  await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
  await page.goto(`${ORIGIN}/`);
  return ui;
};

export const frames = (ui: Ui, n = 2): Promise<void> =>
  ui.page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = (k: number) =>
          k <= 0 ? resolve() : requestAnimationFrame(() => step(k - 1));
        step(count);
      }),
    n
  );

/** API の応答をすべて受け取り、描画が済むまで待つ */
export const settle = async (ui: Ui, quietMs = 400): Promise<void> => {
  let quietSince = Date.now();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (ui.inFlight > 0) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      break;
    }
    await ui.page.waitForTimeout(50);
  }
  await frames(ui, 3);
};

export const openFile = async (ui: Ui, name: string): Promise<void> => {
  await ui.page.setInputFiles("input[type=file]", join(FIXTURES, name));
};

export const text = (ui: Ui, key: SelKey): Promise<string> =>
  ui.page.evaluate(
    (sel) => document.querySelector(sel)?.textContent ?? "",
    ui.sel[key]
  );

/** 画面に見えている要素の文字列(見えていなければ null) */
export const visibleText = (ui: Ui, key: SelKey): Promise<string | null> =>
  ui.page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    return el && el.offsetParent !== null ? (el.textContent ?? "") : null;
  }, ui.sel[key]);

export const attr = (ui: Ui, key: SelKey, name: string) =>
  ui.page.evaluate(
    ([sel, a]) => document.querySelector(sel)?.getAttribute(a) ?? null,
    [ui.sel[key], name] as const
  );

export const infoRows = (ui: Ui): Promise<string[]> =>
  ui.page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? [...el.children].map((c) => c.textContent ?? "") : [];
  }, ui.sel.info);

export const viewportBox = async (ui: Ui) => {
  const box = await ui.page.locator(ui.sel.viewport).boundingBox();
  if (!box) {
    throw new Error("viewport が見つからない");
  }
  return box;
};

export const viewportClientSize = (ui: Ui) =>
  ui.page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    return { height: el.clientHeight, width: el.clientWidth };
  }, ui.sel.viewport);

/** 新UIの表示領域の大きさを旧UIに合わせる(ウィンドウの大きさを変える。resize で全体表示に戻る) */
export const equalizeViewports = async (oldUi: Ui, newUi: Ui) => {
  for (let i = 0; i < 6; i += 1) {
    const a = await viewportClientSize(oldUi);
    const b = await viewportClientSize(newUi);
    if (a.width === b.width && a.height === b.height) {
      // 全体表示の倍率は表示時の大きさで決まる(凡例が入ってヘッダーが折り返す前)ため、両方とも今の大きさで合わせ直す
      for (const ui of [oldUi, newUi]) {
        await ui.page.evaluate(() => window.dispatchEvent(new Event("resize")));
        await settle(ui);
      }
      return;
    }
    const size = newUi.page.viewportSize() ?? { height: 800, width: 1280 };
    await newUi.page.setViewportSize({
      height: size.height + a.height - b.height,
      width: size.width + a.width - b.width,
    });
    await settle(newUi);
  }
  throw new Error("表示領域の大きさを揃えられない");
};

export interface UiState {
  readonly count: number;
  readonly displayMode: string;
  readonly hidden: string[];
  readonly hovered: number;
  readonly imageRes: number;
  readonly requestedRes: number;
  readonly selection: {
    anchor: number;
    level: number;
    members: number[];
  } | null;
  readonly view: { scale: number; x: number; y: number };
}

interface NewHook {
  readonly __pdfUnit: {
    controller: {
      app: {
        getState: () => {
          hovered: number;
          originalImage: { receivedRes: number; requestedRes: number };
          page: {
            model: { items: { bbox?: number[]; type: string }[] };
          };
          selection: {
            anchor: number;
            level: number;
            members: number[];
          } | null;
          view: { scale: number; x: number; y: number };
          visibility: { displayMode: string; hiddenTypes: Set<string> };
        };
      };
    };
  };
}

export const state = (ui: Ui): Promise<UiState> =>
  ui.kind === "old"
    ? ui.page.evaluate(
        // 旧UIのトップレベルの let / function(グローバルな束縛)を読む
        () =>
          new Function(`return {
            count: items.length,
            displayMode,
            hidden: [...hiddenTypes].sort(),
            hovered,
            imageRes,
            requestedRes: currentRes,
            selection: selection && { anchor: selection.anchor, level: selection.level, members: [...selection.members] },
            view: { ...view },
          }`)() as UiState
      )
    : ui.page.evaluate(() => {
        const s = (
          window as unknown as NewHook
        ).__pdfUnit.controller.app.getState();
        return {
          count: s.page.model.items.length,
          displayMode: s.visibility.displayMode,
          hidden: [...s.visibility.hiddenTypes].sort(),
          hovered: s.hovered,
          imageRes: s.originalImage.receivedRes,
          requestedRes: s.originalImage.requestedRes,
          selection: s.selection && {
            anchor: s.selection.anchor,
            level: s.selection.level,
            members: [...s.selection.members],
          },
          view: { ...s.view },
        };
      });

/** Canvas の画素(dataURL) */
export const canvasData = (ui: Ui, key: "scene" | "highlight") =>
  ui.page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLCanvasElement).toDataURL(),
    ui.sel[key]
  );

/**
 * 新UIの埋め込み画像の範囲(Canvas の画素座標の矩形 [x0, y0, x1, y1])。新UIは画像を枠と原本画像で描き、
 * 旧UIは画像データを描くため、画素の比較から外す(ADR 0039)。枠・ハイライトの線幅ぶん広げる
 */
export const imageMasks = (ui: Ui): Promise<number[][]> =>
  ui.page.evaluate(() => {
    const s = (
      window as unknown as NewHook
    ).__pdfUnit.controller.app.getState();
    const dpr = window.devicePixelRatio || 1;
    const margin = 12;
    const { scale, x, y } = s.view;
    return s.page.model.items
      .filter((it) => it.type === "image" && it.bbox)
      .map((it) => {
        const [x0, top, x1, bottom] = it.bbox as number[];
        return [
          (x + (x0 as number) * scale - margin) * dpr,
          (y + (top as number) * scale - margin) * dpr,
          (x + (x1 as number) * scale + margin) * dpr,
          (y + (bottom as number) * scale + margin) * dpr,
        ];
      });
  });

/** 2つの dataURL の画素の差の数(同じ大きさの前提)。masks の矩形の中は数えない */
export const pixelDiff = (
  ui: Ui,
  a: string,
  b: string,
  masks: readonly number[][] = []
): Promise<number> =>
  ui.page.evaluate(
    async ([x, y, rects]) => {
      const load = async (src: string) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d") as CanvasRenderingContext2D;
        ctx.drawImage(img, 0, 0);
        return {
          data: ctx.getImageData(0, 0, c.width, c.height).data,
          width: c.width,
        };
      };
      const [p, q] = await Promise.all([load(x), load(y)]);
      if (p.data.length !== q.data.length) {
        return -1;
      }
      const masked = (px: number, py: number) =>
        rects.some(
          ([x0, y0, x1, y1]) =>
            px >= (x0 as number) &&
            px < (x1 as number) &&
            py >= (y0 as number) &&
            py < (y1 as number)
        );
      let n = 0;
      for (let i = 0; i < p.data.length; i += 4) {
        const differs =
          p.data[i] !== q.data[i] ||
          p.data[i + 1] !== q.data[i + 1] ||
          p.data[i + 2] !== q.data[i + 2] ||
          p.data[i + 3] !== q.data[i + 3];
        if (
          differs &&
          !masked((i / 4) % p.width, Math.floor(i / 4 / p.width))
        ) {
          n += 1;
        }
      }
      return n;
    },
    [a, b, masks] as const
  );

/** 数字を伏せた console.debug([perf] の書式の比較用) */
export const perfPattern = (lines: readonly string[]): string[] =>
  lines.map((l) => l.replace(/\d+(\.\d+)?/g, "N"));

export const tooltip = (ui: Ui) =>
  ui.page.evaluate(() => {
    const el = document.querySelector("[role=tooltip]") as HTMLElement | null;
    return el && !el.hidden ? (el.textContent ?? "") : null;
  });
