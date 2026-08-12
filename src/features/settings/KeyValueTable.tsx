function renderValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function KeyValueTable({ value, label }: { value: Record<string, unknown>; label: string }) {
  const entries = Object.entries(value);
  return (
    <div className="table-scroll">
      <table className="data-table key-value-table" aria-label={label}>
        <tbody>{entries.map(([key, item]) => <tr key={key}><th>{key.split("_").join(" ")}</th><td>{renderValue(item)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
