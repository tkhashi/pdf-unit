// 計測(ADR 0023)。API呼び出しの所要時間・サイズ・サーバー側の内訳(Server-Timing)と、ページ切替からの経過時間を
// console.debug に出す(ブラウザの既定では表示されない Verbose レベル)。画面の表示・動作には影響させない
import { kb } from "../domain/format";

interface PagePerf {
  readonly page: number;
  readonly t0: number;
}

// 計測の起点は画面の状態ではないため store に置かず、ここだけで持つ
let pagePerf: PagePerf | null = null;

export const perfStart = (page: number): void => {
  pagePerf = { page, t0: performance.now() };
};

export const perfMark = (page: number, label: string, extra = ""): void => {
  if (!pagePerf || pagePerf.page !== page) {
    return;
  }
  console.debug(
    `[perf] p${page + 1} ${label} +${Math.round(performance.now() - pagePerf.t0)}ms`,
    extra
  );
};

export const perfApi = (
  path: string,
  t0: number,
  sentBytes: number,
  res: Response
): void => {
  console.debug(
    `[perf] ${path} ${Math.round(performance.now() - t0)}ms ` +
      `送信${kb(sentBytes)}KB 受信${kb(contentLength(res))}KB`,
    res.headers.get("server-timing") ?? "",
    res.headers.get("x-perf-metrics") ?? ""
  );
};

const contentLength = (res: Response): number | null => {
  const v = res.headers.get("content-length");
  return v === null ? null : Number(v);
};

export const perfExtract = (
  indices: readonly number[],
  t0: number,
  bytes: number
): void => {
  const first = (indices[0] ?? 0) + 1;
  const last = (indices.at(-1) ?? 0) + 1;
  console.debug(
    `[perf] 切り出し p${first}${indices.length > 1 ? `-${last}` : ""} ` +
      `${Math.round(performance.now() - t0)}ms ${kb(bytes)}KB`
  );
};
