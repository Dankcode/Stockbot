import { Router } from "express";
import { asyncHandler, sendData } from "../middleware.js";
import { sessionResource } from "../serializers.js";

function percent(numerator, denominator) {
  return denominator > 0 && numerator != null ? Math.max(0, (numerator / denominator) * 100) : null;
}

export function overviewRouter({ accountId, broker, supervisor, repositories, market }) {
  const router = Router();
  router.get("/", asyncHandler(async (_request, response) => {
    const todayUtc = new Date();
    const dayStart = Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate());
    const [portfolio, equityHistory, running, paused, arming, alerts, unread] = await Promise.all([
      broker.portfolio(accountId),
      repositories.sessions.getAccountEquity(accountId, { limit: 1_000 }),
      supervisor.list({ accountId, status: "running", limit: 20 }),
      supervisor.list({ accountId, status: "paused", limit: 20 }),
      supervisor.list({ accountId, status: "arming", limit: 20 }),
      repositories.alerts.feed(accountId, { limit: 20 }),
      repositories.alerts.unreadCount(accountId)
    ]);
    const activeSessions = [...running, ...paused, ...arming].sort((a, b) => Number(b.startedAt || b.createdAt) - Number(a.startedAt || a.createdAt));
    const exposure = portfolio.equity ? percent(portfolio.positionValue || 0, portfolio.equity) : null;
    const dailyLoss = portfolio.dayChange == null ? null : Math.max(0, -portfolio.dayChange);
    const dailyLossLimit = Math.round((portfolio.equity || portfolio.cash) * 0.03);
    const recentOrders = await repositories.orders.list({ accountId, limit: 101 });
    const ordersToday = recentOrders.filter((order) => Number(order.submittedAt) >= dayStart).length;
    const events = await repositories.audit.list({ limit: 30 });
    sendData(response, {
      portfolio: { ...portfolio, equityHistory },
      activeSessions: activeSessions.map(sessionResource),
      riskBudget: {
        dailyLoss: { used: dailyLoss, limit: dailyLossLimit, percent: percent(dailyLoss, dailyLossLimit) },
        drawdown: { usedPercent: activeSessions[0]?.metrics?.maxDrawdown ?? null, limitPercent: 10, percent: percent(activeSessions[0]?.metrics?.maxDrawdown, 10) },
        exposure: { usedPercent: exposure, limitPercent: 80, percent: percent(exposure, 80) },
        ordersToday: { used: Math.min(ordersToday, 100), limit: 100, percent: percent(Math.min(ordersToday, 100), 100) }
      },
      activity: events,
      alerts: { items: alerts, unread },
      dataHealth: market.providerHealth()
    });
  }));
  return router;
}
