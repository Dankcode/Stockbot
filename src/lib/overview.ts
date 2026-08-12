import { api, listFrom } from "./api";
import { useQuery } from "./query";
import type { ActivityItem, OverviewAggregate, Portfolio, ProviderHealth, RiskBudgetItem, SessionSummary } from "./types";

function recordOf(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function healthFrom(value: unknown) {
  if (Array.isArray(value)) return value as ProviderHealth[];
  const record = recordOf(value);
  return Object.entries(record).flatMap(([id, health]) => health && typeof health === "object" ? [{ id, ...(health as Omit<ProviderHealth, "id">) }] : []);
}

export function decodeOverview(payload: unknown): OverviewAggregate {
  const root = recordOf(payload);
  const source = recordOf(root.overview ?? root);
  const riskValue = source.riskBudget ?? source.risk;
  const riskRecord = recordOf(riskValue);
  const budgetDefinitions: Array<{ id: string; label: string; unit: RiskBudgetItem["unit"]; used: string; limit: string }> = [
    { id: "dailyLoss", label: "Daily loss", unit: "money", used: "used", limit: "limit" },
    { id: "drawdown", label: "Drawdown", unit: "percent", used: "usedPercent", limit: "limitPercent" },
    { id: "exposure", label: "Exposure", unit: "percent", used: "usedPercent", limit: "limitPercent" },
    { id: "ordersToday", label: "Orders today", unit: "count", used: "used", limit: "limit" }
  ];
  const budgets = budgetDefinitions.flatMap((definition) => {
    const source = recordOf(riskRecord[definition.id]);
    if (!Object.keys(source).length) return [];
    return [{
      id: definition.id,
      label: definition.label,
      unit: definition.unit,
      observed: typeof source[definition.used] === "number" ? source[definition.used] as number : null,
      limit: typeof source[definition.limit] === "number" ? source[definition.limit] as number : null,
      percent: typeof source.percent === "number" ? source.percent : null
    }];
  });
  const usedValues = budgets.map((budget) => budget.percent).filter((value): value is number => typeof value === "number");
  const riskBudget = riskValue === undefined ? undefined : {
    usedPercent: usedValues.length ? Math.max(...usedValues) : null,
    budgets
  };
  return {
    portfolio: source.portfolio && typeof source.portfolio === "object" ? source.portfolio as Portfolio : undefined,
    activeSessions: listFrom<SessionSummary>(source.activeSessions ?? source.sessions, ["sessions", "items"]),
    riskBudget,
    activity: listFrom<ActivityItem>(source.activity, ["activity", "items", "events"]),
    alerts: listFrom<ActivityItem>(source.alerts, ["alerts", "items"]),
    dataHealth: healthFrom(source.dataHealth ?? source.providers)
  };
}

export function useOverviewQuery() {
  return useQuery("overview", async () => decodeOverview(await api.get<unknown>("/overview")), {
    refreshMs: 10_000,
    staleAfterMs: 15_000
  });
}
