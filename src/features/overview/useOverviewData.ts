import { useOverviewQuery } from "../../lib/overview";

export function useOverviewData() {
  const aggregate = useOverviewQuery();
  const slice = <T,>(data: T | undefined) => ({ ...aggregate, data });
  const activity = aggregate.data
    ? Array.from(
        new Map(
          [...aggregate.data.activity, ...aggregate.data.alerts].map((item) => [item.id, item])
        ).values()
      ).sort((left, right) => right.at - left.at)
    : undefined;
  return {
    aggregate,
    portfolio: slice(aggregate.data?.portfolio),
    sessions: slice(aggregate.data?.activeSessions),
    risk: slice(aggregate.data?.riskBudget),
    activity: slice(activity)
  };
}
