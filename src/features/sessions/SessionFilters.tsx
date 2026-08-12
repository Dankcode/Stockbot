export type SessionFilterState = {
  status: string;
  mode: string;
  algorithm: string;
  days: string;
};

export function SessionFilters({ value, algorithms, onChange }: { value: SessionFilterState; algorithms: string[]; onChange: (next: SessionFilterState) => void }) {
  const update = (key: keyof SessionFilterState, next: string) => onChange({ ...value, [key]: next });
  return (
    <div className="session-filters" aria-label="Session filters">
      <label><span>Status</span><select value={value.status} onChange={(event) => update("status", event.target.value)}><option value="">All</option><option value="running">Running</option><option value="paused">Paused</option><option value="halted">Halted</option><option value="stopped">Stopped</option><option value="errored">Errored</option></select></label>
      <label><span>Mode</span><select value={value.mode} onChange={(event) => update("mode", event.target.value)}><option value="">All</option><option value="paper">Paper</option><option value="backtest">Backtest</option></select></label>
      <label><span>Algorithm</span><select value={value.algorithm} onChange={(event) => update("algorithm", event.target.value)}><option value="">All</option>{algorithms.map((algorithm) => <option key={algorithm} value={algorithm}>{algorithm}</option>)}</select></label>
      <label><span>Date</span><select value={value.days} onChange={(event) => update("days", event.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="">All time</option></select></label>
    </div>
  );
}
