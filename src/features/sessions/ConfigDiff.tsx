import type { SessionSummary } from "../../lib/types";

function display(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function rowsFrom(sessions: SessionSummary[], supplied?: Record<string, Record<string, unknown>>) {
  if (supplied && Object.keys(supplied).length) return Object.entries(supplied);
  const fields: Array<[string, (session: SessionSummary) => unknown]> = [
    ["Algorithm version", (session) => session.algorithmVersionId],
    ["Symbols", (session) => session.symbols],
    ["Bar interval", (session) => session.barInterval],
    ["Parameters", (session) => session.params],
    ["Fill model", (session) => session.fillModel],
    ["Risk profile", (session) => session.riskProfile],
    ["Schedule", (session) => session.schedule]
  ];
  return fields.map(([label, read]) => [label, Object.fromEntries(sessions.map((session) => [session.id, read(session)]))] as const);
}

export function ConfigDiff({ sessions, diff }: { sessions: SessionSummary[]; diff?: Record<string, Record<string, unknown>> }) {
  const rows = rowsFrom(sessions, diff);
  return (
    <div className="table-scroll">
      <table className="data-table config-diff" aria-label="Configuration diff">
        <thead><tr><th>Configuration diff</th>{sessions.map((session) => <th key={session.id}>{session.name}</th>)}</tr></thead>
        <tbody>{rows.map(([label, values]) => {
          const displayValues = sessions.map((session) => display(values[session.id]));
          const differs = new Set(displayValues).size > 1;
          return <tr key={label}><th>{label}</th>{displayValues.map((value, index) => <td className={differs ? "changed" : ""} key={sessions[index].id}>{value}</td>)}</tr>;
        })}</tbody>
      </table>
    </div>
  );
}
