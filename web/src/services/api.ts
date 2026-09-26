// サーバーはステートレス。開いたPDFから必要なページだけを切り出したPDFをPOSTする(ADR 0019, 0020)。
// CloudFront(OAC)→Lambda関数URLでは POST のボディのSHA-256を x-amz-content-sha256 ヘッダーで渡す必要がある
import { MAX_SEND_BYTES } from "../domain/constants";
import { tooLargeMessage } from "../domain/messages";
import type { PageBody } from "./pdf";
import { perfApi } from "./perf";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

const errorDetail = async (res: Response): Promise<string> => {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return body.detail === undefined || body.detail === null
      ? `${res.status}`
      : String(body.detail);
  } catch {
    return `${res.status}`;
  }
};

export const apiPost = async <T>(path: string, body: PageBody): Promise<T> => {
  if (body.bytes.length > MAX_SEND_BYTES) {
    // 送っても 413 になるので送信しない
    throw new ApiError(413, tooLargeMessage(body.bytes.length, MAX_SEND_BYTES));
  }
  const t0 = performance.now();
  const res = await fetch(path, {
    body: body.bytes as Uint8Array<ArrayBuffer>,
    headers: {
      "Content-Type": "application/pdf",
      "x-amz-content-sha256": body.sha256,
    },
    method: "POST",
  });
  if (!res.ok) {
    throw new ApiError(res.status, await errorDetail(res));
  }
  const data = (await res.json()) as T;
  perfApi(path, t0, body.bytes.length, res);
  return data;
};
