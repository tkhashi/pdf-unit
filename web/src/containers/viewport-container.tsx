import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppController, useAppState } from "../app/app-context";
import { Viewport } from "../components/viewport";
import { currentPageSize } from "../state/state";
import { InfoPanelContainer } from "./info-panel-container";

export const ViewportContainer = () => {
  const { attachViewport, dom, refs } = useAppController();
  const s = useAppState(
    useShallow((st) => ({
      dragging: st.dragging,
      dropOver: st.dropOver,
      pageSize: currentPageSize(st),
      rasterOpacity: st.rasterOpacity,
    }))
  );
  useEffect(() => {
    const el = dom.viewport;
    return el ? attachViewport(el) : undefined;
  }, [attachViewport, dom]);
  return (
    <Viewport
      dragging={s.dragging}
      dropOver={s.dropOver}
      highlightCanvasRef={refs.highlightCanvas}
      pageImageRef={refs.pageImage}
      pageSize={s.pageSize}
      rasterOpacity={s.rasterOpacity}
      sceneCanvasRef={refs.sceneCanvas}
      stageRef={refs.stage}
      viewportRef={refs.viewport}
    >
      <InfoPanelContainer />
    </Viewport>
  );
};
