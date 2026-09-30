// サムネイルのラスタライズ(pdf.js)をこの Worker 内で完結させる。pdf.js は `window` が無い環境
// (Worker内)では自身の内部 Worker 生成に失敗し、同一スレッド実行(fake worker)に自動で切り替わる。
// これにより、pdf.js の処理はすべてこの Worker 内に閉じ、メインスレッドは一切ブロックしない(ADR 0041)
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFPageProxy,
} from "pdfjs-dist";
// Vite の ?url でビルド時に発行された URL を取る
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

// pdf.js は Worker 内では別 Worker の起動に失敗し、代わりに workerSrc を動的 import して
// 同一スレッドで処理する(fake worker)。workerSrc には実際に WorkerMessageHandler を
// エクスポートするモジュールを指す必要がある
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface OpenJob {
  readonly data: ArrayBuffer;
  readonly docId: number;
  readonly kind: "open";
}
interface RenderJob {
  readonly docId: number;
  readonly kind: "render";
  readonly page: number;
  /** 数値が小さいほど先に処理する(可視中=0、先読み=1)。キュー内で reprioritize により書き換わる */
  priority: number;
  readonly reqId: number;
  readonly width: number;
}
interface ReprioritizeJob {
  readonly docId: number;
  readonly kind: "reprioritize";
  readonly page: number;
  readonly priority: number;
}
interface CloseJob {
  readonly docId: number;
  readonly kind: "close";
}
type InMessage = OpenJob | RenderJob | ReprioritizeJob | CloseJob;

type OutMessage =
  | { readonly kind: "opened"; readonly docId: number }
  | {
      readonly kind: "open-error";
      readonly docId: number;
      readonly error: string;
    }
  | {
      readonly kind: "rendered";
      readonly reqId: number;
      readonly dataUrl: string;
    }
  | {
      readonly kind: "render-error";
      readonly reqId: number;
      readonly error: string;
    };

// pdf.js の既定(DOMCanvasFactory)は document.createElement("canvas") を呼ぶため、
// document が無い Worker 内では画像デコード等の内部処理が失敗する。OffscreenCanvas で作り直す
interface CanvasAndContext {
  canvas: OffscreenCanvas | null;
  context: OffscreenCanvasRenderingContext2D | null;
}
class OffscreenCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(canvasAndContext: CanvasAndContext, width: number, height: number) {
    if (!canvasAndContext.canvas) {
      throw new Error("Canvas is not specified");
    }
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: CanvasAndContext) {
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

const tasks = new Map<number, PDFDocumentLoadingTask>();

// 描画は1件ずつ直列に行う(pdf.js の処理は重く、並行させてもメモリを増やすだけ)。
// 可視範囲のページを優先し、それ以外は開いた直後から背景で1ページずつ先読みする
const queue: RenderJob[] = [];
let processing = false;

const pumpQueue = (): void => {
  if (processing) {
    return;
  }
  const job = queue.shift();
  if (!job) {
    return;
  }
  processing = true;
  handleRender(job).finally(() => {
    processing = false;
    pumpQueue();
  });
};

const enqueueRender = (job: RenderJob): void => {
  queue.push(job);
  queue.sort((a, b) => a.priority - b.priority);
  pumpQueue();
};

const reprioritize = (job: ReprioritizeJob): void => {
  const entry = queue.find((j) => j.docId === job.docId && j.page === job.page);
  if (entry) {
    entry.priority = job.priority;
    queue.sort((a, b) => a.priority - b.priority);
  }
};

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// btoa は1引数ずつでは遅いため、チャンク単位で文字列化してから渡す
const bufferToBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x80_00;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const handleOpen = async (job: OpenJob): Promise<void> => {
  try {
    const task = getDocument({
      CanvasFactory: OffscreenCanvasFactory,
      data: new Uint8Array(job.data),
    });
    tasks.set(job.docId, task);
    await task.promise;
    postMessage({ docId: job.docId, kind: "opened" } satisfies OutMessage);
  } catch (e) {
    tasks.delete(job.docId);
    postMessage({
      docId: job.docId,
      error: errorMessage(e),
      kind: "open-error",
    } satisfies OutMessage);
  }
};

const handleRender = async (job: RenderJob): Promise<void> => {
  let page: PDFPageProxy | null = null;
  try {
    const task = tasks.get(job.docId);
    if (!task) {
      throw new Error("document not open");
    }
    const doc = await task.promise;
    page = await doc.getPage(job.page + 1);
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: job.width / unscaled.width });
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(viewport.width)),
      Math.max(1, Math.round(viewport.height))
    );
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("2d context unavailable");
    }
    await page.render({
      canvas: null,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const dataUrl = `data:image/png;base64,${bufferToBase64(await blob.arrayBuffer())}`;
    postMessage({
      dataUrl,
      kind: "rendered",
      reqId: job.reqId,
    } satisfies OutMessage);
  } catch (e) {
    postMessage({
      error: errorMessage(e),
      kind: "render-error",
      reqId: job.reqId,
    } satisfies OutMessage);
  } finally {
    // pdf.js は描画したページの命令列(Path2D を含む)と画像を、cleanup() を呼ぶまでページごとに保持し続ける。
    // 同じページを描き直すことはないので、描き終えたら捨てる(ADR 0048)
    page?.cleanup();
  }
};

const handleClose = (job: CloseJob): void => {
  tasks.get(job.docId)?.destroy();
  tasks.delete(job.docId);
  // 閉じた文書の未着手ジョブ(先読み分)はもう不要。ただし応答しないと、要求元の Promise が解決されない。
  // その Promise が閉じた文書全体を参照し続けてしまうため、失敗として答えてから捨てる(ADR 0049)
  const remaining: RenderJob[] = [];
  for (const j of queue) {
    if (j.docId === job.docId) {
      postMessage({
        error: "document closed",
        kind: "render-error",
        reqId: j.reqId,
      } satisfies OutMessage);
    } else {
      remaining.push(j);
    }
  }
  queue.length = 0;
  queue.push(...remaining);
};

self.onmessage = (e: MessageEvent<InMessage>) => {
  const job = e.data;
  if (job.kind === "open") {
    handleOpen(job);
  } else if (job.kind === "render") {
    enqueueRender(job);
  } else if (job.kind === "reprioritize") {
    reprioritize(job);
  } else {
    handleClose(job);
  }
};
