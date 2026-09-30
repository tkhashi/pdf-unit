// ブラウザで保持するPDF(pdf-lib)。サーバーへは必要なページだけを切り出して送る(ADR 0020)
import { EncryptedPDFError, PDFDocument, type PDFPage } from "pdf-lib";
import type { PageSize } from "../domain/types";
import { perfExtract } from "./perf";

/** 送信するPDFと、そのSHA-256(CloudFront OAC 経由の POST に必要な x-amz-content-sha256) */
export interface PageBody {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export const loadPdf = (data: ArrayBuffer): Promise<PDFDocument> =>
  PDFDocument.load(data, { updateMetadata: false });

export const isEncryptedPdfError = (e: unknown): boolean =>
  e instanceof EncryptedPDFError;

/** サーバー(PDFium)とほぼ同じ定義: CropBox(無ければMediaBox)の幅・高さ。/Rotate 90/270 なら入れ替える。サーバーは MediaBox との交わりを取るので、CropBox がはみ出すページはサーバーの寸法で合わせ直す */
export const pageSize = (page: PDFPage): PageSize => {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  return rot === 90 || rot === 270
    ? { height: box.width, width: box.height }
    : { height: box.height, width: box.width };
};

export const pageSizes = (pdf: PDFDocument): readonly PageSize[] =>
  pdf.getPages().map(pageSize);

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * 指定ページだけを含むPDFを作る。そのページが参照するフォント・画像と、親から引き継ぐ属性(Resources・
 * MediaBox・CropBox・Rotate)だけが入る
 */
export const extractPages = async (
  pdf: PDFDocument,
  indices: readonly number[]
): Promise<PageBody> => {
  const t0 = performance.now();
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(pdf, [...indices])) {
    out.addPage(page);
  }
  const bytes = await out.save({ useObjectStreams: false });
  const sha256 = await sha256Hex(bytes);
  perfExtract(indices, t0, bytes.length);
  return { bytes, sha256 };
};
