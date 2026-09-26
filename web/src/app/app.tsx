import { useEffect } from "react";
import { ThumbnailsContainer } from "../containers/thumbnails-container";
import { ToolbarContainer } from "../containers/toolbar-container";
import { TooltipContainer } from "../containers/tooltip-container";
import { ViewportContainer } from "../containers/viewport-container";
import { useAppController } from "./app-context";

export const App = () => {
  const { install } = useAppController();
  useEffect(() => install(), [install]);
  return (
    <>
      <TooltipContainer />
      <ToolbarContainer />
      <div className="flex min-h-0 flex-1">
        <ThumbnailsContainer />
        <ViewportContainer />
      </div>
    </>
  );
};
