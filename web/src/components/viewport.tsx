import type { ReactNode, Ref } from "react";
import type { PageSize } from "../domain/types";

interface Props {
  readonly children: ReactNode;
  readonly dragging: boolean;
  readonly dropOver: boolean;
  readonly highlightCanvasRef: Ref<HTMLCanvasElement>;
  readonly pageImageRef: Ref<HTMLImageElement>;
  readonly pageSize: PageSize | null;
  readonly rasterOpacity: number;
  readonly sceneCanvasRef: Ref<HTMLCanvasElement>;
  readonly stageRef: Ref<HTMLDivElement>;
  readonly viewportRef: Ref<HTMLDivElement>;
}

/**
 * 図面表示領域。下から順に、原本画像(stage)、再描画(埋め込み画像・線・文字)、ハイライトを重ねる。
 * 拡大縮小・移動と Canvas への描画は描画層が行う
 */
export const Viewport = ({
  children,
  dragging,
  dropOver,
  highlightCanvasRef,
  pageImageRef,
  pageSize,
  rasterOpacity,
  sceneCanvasRef,
  stageRef,
  viewportRef,
}: Props) => (
  <div
    className={`relative min-w-0 flex-1 overflow-hidden ${dragging ? "cursor-grabbing" : "cursor-crosshair"} ${
      dropOver
        ? "outline-dashed outline-3 outline-primary -outline-offset-8"
        : ""
    }`}
    data-testid="viewport"
    ref={viewportRef}
  >
    {pageSize ? null : (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-base-content/50 text-lg">
        PDFをドラッグ&ドロップ、または「開く」
      </div>
    )}
    <div
      className="absolute top-0 left-0 origin-top-left bg-white shadow-xl"
      hidden={!pageSize}
      ref={stageRef}
      style={pageSize ? { height: pageSize.height, width: pageSize.width } : {}}
    >
      <img
        alt=""
        className="pointer-events-none absolute inset-0 block size-full select-none"
        draggable={false}
        height={pageSize?.height}
        ref={pageImageRef}
        style={{ opacity: rasterOpacity / 100 }}
        width={pageSize?.width}
      />
    </div>
    <canvas
      className="pointer-events-none absolute inset-0 size-full"
      data-testid="scene-canvas"
      ref={sceneCanvasRef}
    />
    <canvas
      className="pointer-events-none absolute inset-0 size-full"
      data-testid="highlight-canvas"
      ref={highlightCanvasRef}
    />
    {children}
  </div>
);
