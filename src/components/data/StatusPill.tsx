import type { SessionStatus } from "../../../packages/shared/schemas.js";

const statusLabels: Record<SessionStatus, string> = {
  draft: "Draft",
  arming: "Arming",
  running: "Running",
  paused: "Paused",
  stopping: "Stopping",
  halted: "Halted",
  stopped: "Stopped",
  errored: "Errored"
};

export function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {statusLabels[status]}
    </span>
  );
}
