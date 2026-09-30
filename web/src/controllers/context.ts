// コントローラー(非同期処理・入力の処理)が共有するもの
import type { PDFDocument } from "pdf-lib";
import type { DomRefs } from "../render/dom";
import type { Renderer } from "../render/renderer";
import type { PageBodySource } from "../services/page-body-cache";
import type { ThumbnailSource } from "../services/thumbnail-render";
import type { AppStore } from "../state/store";

/** 開いている文書の PDF 本体と、ページ単位の切り出し(store の DocState.id と対応) */
export interface DocumentSession {
  readonly id: number;
  readonly pageBody: PageBodySource;
  readonly pdf: PDFDocument;
  /** サムネイルのラスタライズ用(ブラウザ内、pdf.js。ADR 0041)。本体ページの表示を待たせないよう Promise のまま持つ */
  readonly thumbSource: Promise<ThumbnailSource>;
}

export interface ControllerContext {
  readonly app: AppStore;
  readonly dom: DomRefs;
  readonly renderer: Renderer;
  /** 現在の文書(古い文書への応答かどうかを同一性で判定する) */
  readonly session: () => DocumentSession | null;
  readonly setSession: (session: DocumentSession) => void;
}
