import { TYPE_COLORS } from "../domain/constants";
import type { InfoRow, InfoValue } from "../domain/describe";

const Value = ({ value }: { readonly value: InfoValue }) => {
  switch (value.kind) {
    case "type":
      return (
        <>
          <b style={{ color: TYPE_COLORS[value.type] }}>{value.type}</b>
          {`  #${value.id}`}
        </>
      );
    case "color":
      return (
        <>
          {value.color}{" "}
          <span
            className="inline-block size-2.5 border border-white align-middle"
            style={{ background: value.color }}
          />
        </>
      );
    default:
      return <>{value.text}</>;
  }
};

interface Props {
  readonly rows: readonly InfoRow[];
}

/** ホバー中の要素(無ければ選択の起点要素)の属性。選択中の属性の行は強調し件数を添える */
export const InfoPanel = ({ rows }: Props) =>
  rows.length > 0 ? (
    <div
      className="pointer-events-none absolute right-3 bottom-3 min-w-[260px] max-w-[480px] whitespace-pre-wrap rounded-md bg-neutral/90 px-2.5 py-2 font-mono text-neutral-content text-xs leading-relaxed shadow-lg"
      data-testid="info"
    >
      {rows.map((r) => {
        const active = r.count !== null;
        return (
          <div
            className={`-mx-1 rounded-sm px-1 ${active ? "bg-warning font-bold text-warning-content" : ""}`}
            key={r.label}
          >
            <span
              className={
                active ? "text-warning-content/70" : "text-neutral-content/60"
              }
            >
              {r.label}:
            </span>{" "}
            <Value value={r.value} />
            {active ? `  (${r.count}件)` : ""}
          </div>
        );
      })}
    </div>
  ) : null;
