import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";

type StateProps = {
  title: string;
  detail?: string;
  compact?: boolean;
};

export function LoadingState({ title = "Loading", compact = false }: Partial<StateProps>) {
  return (
    <div className={`data-state loading-state${compact ? " compact" : ""}`} role="status" aria-label={title}>
      <div className="skeleton-line wide" />
      <div className="skeleton-line" />
      {!compact ? <div className="skeleton-line short" /> : null}
      <span className="sr-only">{title}</span>
    </div>
  );
}

export function EmptyState({ title, detail, compact = false }: StateProps) {
  return (
    <div className={`data-state${compact ? " compact" : ""}`}>
      <Inbox aria-hidden="true" />
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

export function ErrorState({
  title = "Data unavailable",
  detail,
  compact = false,
  onRetry
}: Partial<StateProps> & { onRetry?: () => void }) {
  return (
    <div className={`data-state error-state${compact ? " compact" : ""}`} role="alert">
      <AlertTriangle aria-hidden="true" />
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
      {onRetry ? (
        <button className="button secondary small" type="button" onClick={onRetry}>
          <RefreshCw size={14} /> Retry
        </button>
      ) : null}
    </div>
  );
}

export function StaleBadge({ updatedAt }: { updatedAt: number }) {
  const ageSeconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1_000));
  const age = ageSeconds < 60
    ? `${ageSeconds}s`
    : ageSeconds < 3_600
      ? `${Math.round(ageSeconds / 60)}m`
      : ageSeconds < 86_400
        ? `${Math.round(ageSeconds / 3_600)}h`
        : `${Math.round(ageSeconds / 86_400)}d`;
  return (
    <span className="stale-badge" title={`Last updated ${ageSeconds} seconds ago`}>
      Stale · {age}
    </span>
  );
}
