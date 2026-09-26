import { type ReactNode, type Ref, useLayoutEffect, useRef } from "react";

interface Props {
  readonly children: ReactNode;
  /** 現在のページ(ページを表示し直すたびに変わる request と組で、選択ページへ追従スクロールする) */
  readonly current: number;
  readonly panelRef: Ref<HTMLElement>;
  readonly request: number;
  readonly visible: boolean;
}

/** サムネイル一覧。閉じている間も要素は残す(表示範囲の監視を続けるため) */
export const ThumbnailPanel = ({
  children,
  current,
  panelRef,
  request,
  visible,
}: Props) => {
  const local = useRef<HTMLElement | null>(null);
  // 選択ページを一覧の見える位置へ(DOM の操作だけで、状態は持たない)
  useLayoutEffect(() => {
    if (visible && request >= 0) {
      local.current?.children[current]?.scrollIntoView({ block: "nearest" });
    }
  }, [current, request, visible]);
  const setRef = (el: HTMLElement | null) => {
    local.current = el;
    if (typeof panelRef === "function") {
      panelRef(el);
    }
  };
  return (
    <aside
      className="flex w-48 flex-none flex-col items-center gap-2 overflow-y-auto overflow-x-hidden bg-base-300 p-2"
      data-testid="thumbs"
      hidden={!visible}
      ref={setRef}
    >
      {children}
    </aside>
  );
};
