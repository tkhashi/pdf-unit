import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppController, useAppState } from "../app/app-context";
import { ThumbToggle } from "../components/thumb-toggle";
import { ThumbnailButton } from "../components/thumbnail-button";
import { ThumbnailPanel } from "../components/thumbnail-panel";

const ThumbnailItemContainer = ({ page }: { readonly page: number }) => {
  const { actions } = useAppController();
  const { current, entry, size } = useAppState(
    useShallow((s) => ({
      current: s.page.index === page,
      entry: s.thumbs.entries[page],
      size: s.doc?.pages[page],
    }))
  );
  // 監視の登録・解除は要素の生成・破棄のときだけ行う(再レンダーのたびに登録し直さない)
  const ref = useCallback(
    (el: HTMLButtonElement | null) => {
      actions.registerThumb(page, el);
      return () => actions.registerThumb(page, null);
    },
    [actions, page]
  );
  if (!(entry && size)) {
    return null;
  }
  return (
    <ThumbnailButton
      current={current}
      loading={entry.loading}
      onSelect={actions.showPage}
      page={page}
      ref={ref}
      size={size}
      src={entry.src}
      unavailableTip={entry.unavailableTip}
    />
  );
};

const pageNumbers = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => i);

/** 左のサムネイル一覧と開閉ボタン */
export const ThumbnailsContainer = () => {
  const { actions, refs } = useAppController();
  const s = useAppState(
    useShallow((st) => ({
      count: st.thumbs.entries.length,
      current: st.page.index,
      docId: st.doc?.id ?? 0,
      hasDoc: st.doc !== null,
      request: st.page.request,
      visible: st.thumbs.visible,
    }))
  );
  return (
    <>
      <ThumbnailPanel
        current={s.current}
        panelRef={refs.thumbs}
        request={s.request}
        visible={s.visible}
      >
        {pageNumbers(s.count).map((page) => (
          // 文書を開き直したら一覧の要素を作り直す(旧UIの replaceChildren と同じ)
          <ThumbnailItemContainer key={`${s.docId}-${page}`} page={page} />
        ))}
      </ThumbnailPanel>
      {s.hasDoc ? (
        <ThumbToggle onToggle={actions.toggleThumbs} visible={s.visible} />
      ) : null}
    </>
  );
};
