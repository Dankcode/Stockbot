import { formatMoney, formatPercent } from "../../../packages/shared/format.js";
import type { RiskBudgetItem } from "../../lib/types";

function valueLabel(item: RiskBudgetItem, value: number | null) {
  if (item.unit === "money") return formatMoney(value);
  if (item.unit === "percent") return formatPercent(value, { precision: 1 });
  return value == null ? "—" : new Intl.NumberFormat("en-US").format(value);
}

export function BudgetMeter({ item }: { item: RiskBudgetItem }) {
  const computed = item.observed != null && item.limit != null && item.limit > 0 ? (item.observed / item.limit) * 100 : null;
  const percent = item.percent ?? computed;
  const bounded = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const level = bounded >= 85 ? "high" : bounded >= 60 ? "caution" : "good";
  return (
    <div className="budget-row">
      <div className="budget-label">
        <span>{item.label}</span>
        <strong>{valueLabel(item, item.observed)}</strong>
      </div>
      <span className={`budget-percent ${level}`}>{formatPercent(percent, { precision: 1 })}</span>
      <div className="budget-track" role="meter" aria-label={item.label} aria-valuemin={0} aria-valuemax={item.limit ?? undefined} aria-valuenow={item.observed ?? undefined}>
        <span className={`budget-fill ${level}`} style={{ width: `${bounded}%` }} />
      </div>
      <span className="budget-limit">{valueLabel(item, item.limit)} limit</span>
    </div>
  );
}
