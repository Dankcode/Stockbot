import { BudgetMeter } from "../../components/data/BudgetMeter";
import { EquitySparkline } from "../../components/data/EquitySparkline";
import { Metric } from "../../components/data/Metric";
import { Timeline } from "../../components/data/Timeline";
import { EmptyState, ErrorState, LoadingState, StaleBadge } from "../../components/states/DataStates";
import { ActiveSessions } from "./ActiveSessions";
import { PositionsTable } from "./PositionsTable";
import { useOverviewData } from "./useOverviewData";

export function OverviewPage() {
  const { portfolio, sessions, risk, activity } = useOverviewData();
  return (
    <div className="overview-page page-grid">
      <section className="overview-hero panel-span" aria-label="Account overview">
        {portfolio.isLoading ? <LoadingState title="Loading account equity" /> : null}
        {portfolio.error && !portfolio.data ? <ErrorState detail={portfolio.error.message} onRetry={portfolio.refetch} /> : null}
        {!portfolio.isLoading && !portfolio.error && !portfolio.data ? <EmptyState title="Portfolio unavailable" detail="No real portfolio snapshot was returned." /> : null}
        {portfolio.data ? (
          <>
            <div className="overview-metrics">
              <Metric metric="finalEquity" label="Equity" value={portfolio.data.equity} />
              <Metric metric="dayChange" label="Day P&L" value={portfolio.data.dayChange} />
              <Metric metric="realizedPnl" label="Realized all-time" value={portfolio.data.realizedPnl} />
            </div>
            <div className="overview-equity-chart">
              {portfolio.data.equityHistory && portfolio.data.equityHistory.length > 1 ? (
                <EquitySparkline points={portfolio.data.equityHistory} />
              ) : (
                <EmptyState compact title="Equity history unavailable" detail="No real equity snapshots were returned." />
              )}
            </div>
            {portfolio.isStale ? <StaleBadge updatedAt={portfolio.updatedAt} /> : null}
          </>
        ) : null}
      </section>

      <section className="panel overview-sessions">
        <header className="panel-header"><h2>Active sessions</h2>{sessions.isStale ? <StaleBadge updatedAt={sessions.updatedAt} /> : null}</header>
        {sessions.isLoading ? <LoadingState title="Loading active sessions" /> : null}
        {sessions.error && !sessions.data ? <ErrorState detail={sessions.error.message} onRetry={sessions.refetch} /> : null}
        {sessions.data?.length ? <ActiveSessions sessions={sessions.data} /> : sessions.data ? <EmptyState title="No active sessions" detail="Started paper sessions will appear here." /> : null}
      </section>

      <section className="panel overview-risk">
        <header className="panel-header"><h2>Risk budget</h2>{risk.isStale ? <StaleBadge updatedAt={risk.updatedAt} /> : null}</header>
        {risk.isLoading ? <LoadingState title="Loading risk budget" /> : null}
        {risk.error && !risk.data ? <ErrorState detail={risk.error.message} onRetry={risk.refetch} /> : null}
        {risk.data?.budgets?.length ? <div className="budget-list">{risk.data.budgets.map((item) => <BudgetMeter key={item.id} item={item} />)}</div> : risk.data ? <EmptyState title="Risk budget unavailable" detail="No real risk limits were returned." /> : null}
      </section>

      <section className="panel overview-positions">
        <header className="panel-header"><h2>Open positions</h2><span>{portfolio.data?.positions?.length ?? "—"}</span></header>
        {portfolio.isLoading ? <LoadingState title="Loading positions" /> : null}
        {portfolio.error && !portfolio.data ? <ErrorState detail={portfolio.error.message} onRetry={portfolio.refetch} /> : null}
        {!portfolio.isLoading && !portfolio.error && !portfolio.data ? <EmptyState title="Positions unavailable" detail="No real portfolio snapshot was returned." /> : null}
        {portfolio.data?.positions?.length ? <PositionsTable positions={portfolio.data.positions} /> : portfolio.data ? <EmptyState title="No open positions" detail="Filled paper orders will appear here." /> : null}
      </section>

      <section className="panel overview-activity">
        <header className="panel-header"><h2>Activity</h2>{activity.isStale ? <StaleBadge updatedAt={activity.updatedAt} /> : null}</header>
        {activity.isLoading ? <LoadingState title="Loading activity" /> : null}
        {activity.error && !activity.data ? <ErrorState detail={activity.error.message} onRetry={activity.refetch} /> : null}
        {activity.data?.length ? <Timeline items={activity.data} /> : activity.data ? <EmptyState title="No activity" detail="Fills, blocks, risk events and state changes will appear here." /> : null}
      </section>
    </div>
  );
}
