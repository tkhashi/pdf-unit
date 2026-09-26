import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppState } from "../app/app-context";
import { InfoPanel } from "../components/info-panel";
import { describe } from "../domain/describe";

/** ホバー中の要素、無ければ選択の起点要素を表示する */
export const InfoPanelContainer = () => {
  const { hovered, model, selection } = useAppState(
    useShallow((s) => ({
      hovered: s.hovered,
      model: s.page.model,
      selection: s.selection,
    }))
  );
  const rows = useMemo(() => {
    const id = hovered >= 0 ? hovered : (selection?.anchor ?? -1);
    const it = model.items[id];
    return it ? describe(model.items, it, selection, model.lwScale) : [];
  }, [hovered, model, selection]);
  return <InfoPanel rows={rows} />;
};
