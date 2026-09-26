import { useShallow } from "zustand/react/shallow";
import { useAppState } from "../app/app-context";
import { Tooltip } from "../components/tooltip";

export const TooltipContainer = () => {
  const { anchor, text } = useAppState(
    useShallow((s) => ({ anchor: s.tooltip.anchor, text: s.tooltip.text }))
  );
  return <Tooltip anchor={anchor} text={text} />;
};
