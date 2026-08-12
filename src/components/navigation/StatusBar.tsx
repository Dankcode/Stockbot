import { Activity, Database, Octagon, Radio, ShieldCheck } from "lucide-react";
import * as React from "react";
import { formatMoney, formatPercent } from "../../../packages/shared/format.js";
import { api, getAccountId } from "../../lib/api";
import { useOverviewQuery } from "../../lib/overview";
import { invalidateQueries } from "../../lib/query";
import type { StreamStatus } from "../../lib/useEventStream";

export function StatusBar({ streamStatus }: { streamStatus: StreamStatus }) {
  const accountId = getAccountId();
  const overview = useOverviewQuery();
  const [halting, setHalting] = React.useState(false);
  const [haltError, setHaltError] = React.useState<string | null>(null);
  const configuredProviders = overview.data?.dataHealth.filter((provider) => provider.configured !== false) ?? [];
  const healthy = configuredProviders.some((provider) => provider.status === "healthy");

  const haltAll = async () => {
    if (!window.confirm("Halt all running sessions? Open positions will be held.")) return;
    setHalting(true);
    setHaltError(null);
    try {
      await api.post(`/accounts/${accountId}/halt-all`, { liquidate: false });
      invalidateQueries("sessions");
    } catch (error) {
      setHaltError(error instanceof Error ? error.message : "Unable to halt sessions.");
    } finally {
      setHalting(false);
    }
  };

  return (
    <header className="status-bar">
      <a className="brand" href="/" aria-label="Stockbot overview">
        <Activity size={23} aria-hidden="true" /> <span>Stockbot</span>
      </a>
      <span className="mode-badge">PAPER</span>
      <div className="status-stat equity-status">
        <span>Equity</span>
        <strong>{formatMoney(overview.data?.portfolio?.equity)}</strong>
      </div>
      <div className="status-stat">
        <span className="status-inline"><Radio size={13} /> Running</span>
        <strong>{overview.data ? `${overview.data.activeSessions.length} sessions` : "—"}</strong>
      </div>
      <div className="status-stat">
        <span className="status-inline"><ShieldCheck size={13} /> Risk used</span>
        <strong>{formatPercent(overview.data?.riskBudget?.usedPercent ?? overview.data?.portfolio?.riskUsedPercent, { precision: 1 })}</strong>
      </div>
      <div className="status-stat data-health">
        <span className="status-inline"><Database size={13} /> Data {healthy ? "healthy" : "unavailable"}</span>
        <strong>{streamStatus === "open" ? "Live stream" : "Polling"}</strong>
      </div>
      <button className="button destructive halt-all" type="button" onClick={haltAll} disabled={halting} title={haltError ?? undefined}>
        <Octagon size={16} /> {halting ? "HALTING" : "HALT ALL"}
      </button>
      {haltError ? <span className="sr-only" role="alert">{haltError}</span> : null}
    </header>
  );
}
