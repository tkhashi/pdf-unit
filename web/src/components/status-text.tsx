import type { StatusText as Status } from "../domain/messages";

interface Props {
  readonly status: Status;
}

export const StatusText = ({ status }: Props) => (
  <span
    className="whitespace-normal"
    data-testid="status"
    data-tip={status.tip ?? undefined}
  >
    {status.text}
  </span>
);
