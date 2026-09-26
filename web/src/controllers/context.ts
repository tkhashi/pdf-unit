// コントローラー(非同期処理・入力の処理)が共有するもの
import type { PDFDocument } from "pdf-lib";
import type { DomRefs } from "../render/dom";
import type { Renderer } from "../render/renderer";
import type { PageBodySource } from "../services/page-body-cache";
import type { AppStore } from "../state/store";

/** 開いている文書の PDF 本体と、ページ単位の切り出し(store の DocState.id と対応) */
export interface DocumentSession {
  readonly id: number;
  readonly pageBody: PageBodySource;
  readonly pdf: PDFDocument;
}

export interface ControllerContext {
  readonly app: AppStore;
  readonly dom: DomRefs;
  readonly renderer: Renderer;
  /** 現在の文書(古い文書への応答かどうかを同一性で判定する) */
  readonly session: () => DocumentSession | null;
  readonly setSession: (session: DocumentSession) => void;
}
