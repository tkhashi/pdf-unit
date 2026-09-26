import type { ItemType } from "../domain/constants";
import type { StatusText } from "../domain/messages";
import type { PageModel } from "../domain/page-model";
import type { PageSize } from "../domain/types";
import type { Size, View } from "../domain/view";
import type { DisplayMode } from "../domain/visibility";
import type { DocState } from "./state";

export type Action =
  | {
      readonly doc: DocState;
      readonly thumbsVisible: boolean;
      readonly type: "documentOpened";
    }
  | {
      readonly index: number;
      readonly type: "pageRequested";
      /** 表示領域の大きさ(ページ全体を収める表示にするため) */
      readonly viewport: Size;
    }
  | { readonly request: number; readonly type: "pageLoadSettled" }
  | {
      /** サーバー(pdfplumber)が返したページ寸法(座標系の基準) */
      readonly pageSize: PageSize;
      readonly request: number;
      readonly type: "pageSizeReported";
      readonly viewport: Size;
    }
  | {
      readonly model: PageModel;
      readonly request: number;
      readonly type: "pageLoaded";
    }
  | {
      readonly message: string;
      readonly request: number;
      readonly type: "pageFailed";
    }
  | { readonly status: StatusText; readonly type: "statusChanged" }
  | { readonly type: "viewChanged"; readonly view: View }
  | { readonly type: "viewFitted"; readonly viewport: Size }
  | { readonly id: number; readonly type: "hovered" }
  | { readonly id: number; readonly type: "clicked" }
  | { readonly type: "selectionCleared" }
  | {
      readonly itemType: ItemType;
      readonly type: "typeVisibilityChanged";
      readonly visible: boolean;
    }
  | { readonly type: "allTypesToggled" }
  | { readonly mode: DisplayMode; readonly type: "displayModeChanged" }
  | { readonly type: "rasterOpacityChanged"; readonly value: number }
  | {
      readonly docId: number;
      readonly page: number;
      readonly res: number;
      readonly type: "originalImageRequested";
    }
  | {
      readonly docId: number;
      readonly page: number;
      readonly resolution: number;
      readonly src: string;
      readonly type: "originalImageLoaded";
    }
  | {
      readonly docId: number;
      readonly page: number;
      readonly res: number;
      readonly type: "originalImageFailed";
    }
  | { readonly type: "thumbsVisibilityChanged"; readonly visible: boolean }
  | {
      readonly docId: number;
      readonly thumbs: readonly {
        readonly page: number;
        readonly src: string;
      }[];
      readonly type: "thumbsLoaded";
    }
  | {
      readonly docId: number;
      readonly page: number;
      readonly tip: string;
      readonly type: "thumbUnavailable";
    }
  | { readonly dragging: boolean; readonly type: "draggingChanged" }
  | { readonly over: boolean; readonly type: "dropOverChanged" }
  | {
      readonly anchor: DOMRectReadOnly;
      readonly pinned: boolean;
      readonly text: string;
      readonly type: "tooltipShown";
    }
  | { readonly type: "tooltipHidden" };
