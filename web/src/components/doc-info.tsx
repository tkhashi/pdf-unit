interface Props {
  readonly filename: string;
  readonly pageInfo: string;
}

export const DocInfo = ({ filename, pageInfo }: Props) => (
  <span className="inline-flex items-baseline gap-1.5 text-neutral-content/80 text-xs">
    <span
      className="max-w-60 truncate"
      data-testid="doc-name"
      data-tip={filename}
    >
      {filename}
    </span>
    <span
      className="text-[11px] text-neutral-content/60"
      data-testid="page-info"
    >
      {pageInfo}
    </span>
  </span>
);
