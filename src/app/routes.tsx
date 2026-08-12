import * as React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { LoadingState } from "../components/states/DataStates";
import { AppShell } from "./AppShell";

const OverviewPage = React.lazy(() => import("../features/overview/OverviewPage").then((module) => ({ default: module.OverviewPage })));
const MarketsPage = React.lazy(() => import("../features/markets/MarketsPage").then((module) => ({ default: module.MarketsPage })));
const StrategiesPage = React.lazy(() => import("../features/strategies/StrategiesPage").then((module) => ({ default: module.StrategiesPage })));
const StrategyDetailPage = React.lazy(() => import("../features/strategies/StrategyDetailPage").then((module) => ({ default: module.StrategyDetailPage })));
const SessionsPage = React.lazy(() => import("../features/sessions/SessionsPage").then((module) => ({ default: module.SessionsPage })));
const SessionDetailPage = React.lazy(() => import("../features/sessions/SessionDetailPage").then((module) => ({ default: module.SessionDetailPage })));
const SessionComparePage = React.lazy(() => import("../features/sessions/SessionComparePage").then((module) => ({ default: module.SessionComparePage })));
const SettingsPage = React.lazy(() => import("../features/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));

function RouteFallback() {
  return <div className="route-fallback"><LoadingState title="Loading destination" /></div>;
}

export function AppRoutes() {
  return (
    <React.Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="markets" element={<MarketsPage />} />
          <Route path="strategies" element={<StrategiesPage />} />
          <Route path="strategies/:algorithmId" element={<StrategyDetailPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="sessions/compare" element={<SessionComparePage />} />
          <Route path="sessions/:sessionId" element={<SessionDetailPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </React.Suspense>
  );
}
