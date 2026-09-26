import { useShallow } from "zustand/react/shallow";
import { useAppController, useAppState } from "../app/app-context";
import { DocInfo } from "../components/doc-info";
import { FileOpenButton } from "../components/file-open-button";
import { HelpButton } from "../components/help-button";
import { Legend } from "../components/legend";
import { ModeSegment } from "../components/mode-segment";
import { OpacityControl } from "../components/opacity-control";
import { Separator } from "../components/separator";
import { StatusText } from "../components/status-text";
import { pageInfoText } from "../domain/messages";

/** ヘッダー(ツールバー)。文書を開くまでは文書に依存する項目を出さない */
export const ToolbarContainer = () => {
  const { actions } = useAppController();
  const s = useAppState(
    useShallow((st) => ({
      doc: st.doc,
      helpExpanded: st.tooltip.pinned,
      legendCounts: st.legendCounts,
      mode: st.visibility.displayMode,
      pageIndex: st.page.index,
      rasterOpacity: st.rasterOpacity,
      status: st.status,
      visibility: st.visibility,
    }))
  );
  const { doc } = s;
  return (
    <header className="flex flex-none flex-wrap items-center gap-x-2.5 gap-y-1.5 whitespace-nowrap bg-neutral px-3 py-1.5 text-[13px] text-neutral-content">
      <strong className="font-semibold tracking-wide">PDF Unit</strong>
      <Separator />
      <FileOpenButton onOpen={actions.openFile} />
      {doc ? (
        <DocInfo
          filename={doc.filename}
          pageInfo={pageInfoText(s.pageIndex, doc.pages.length)}
        />
      ) : null}
      <Separator />
      <ModeSegment mode={s.mode} onChange={actions.setDisplayMode} />
      {doc ? (
        <>
          <Separator />
          {s.legendCounts ? (
            <Legend
              counts={s.legendCounts}
              hiddenTypes={s.visibility.hiddenTypes}
              onToggleAll={actions.setAllTypesToggled}
              onToggleType={actions.setTypeVisible}
            />
          ) : (
            <span />
          )}
        </>
      ) : null}
      <Separator />
      <OpacityControl
        onChange={actions.setRasterOpacity}
        value={s.rasterOpacity}
      />
      {doc ? (
        <>
          <Separator />
          <StatusText status={s.status} />
        </>
      ) : null}
      <span className="flex-1" />
      <HelpButton expanded={s.helpExpanded} onToggle={actions.toggleHelp} />
    </header>
  );
};
