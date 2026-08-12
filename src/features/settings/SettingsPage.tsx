import { Bell, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { EmptyState, ErrorState, LoadingState, StaleBadge } from "../../components/states/DataStates";
import { api, listFrom } from "../../lib/api";
import { fetchProviderHealth } from "../../lib/market";
import { useQuery } from "../../lib/query";
import type { SystemSettings } from "../../lib/types";
import { OperatorTokenForm } from "./OperatorTokenForm";
import { SettingsGroupForm } from "./SettingsGroupForm";

type RiskProfile = { id: string; name: string; isDefault?: boolean; rules?: unknown };
type Alert = { id: string; name: string; triggerType?: string; channel?: string; enabled?: boolean };

function settingsFrom(payload: unknown): SystemSettings {
  const source = payload && typeof payload === "object" && "settings" in payload
    ? (payload as { settings: unknown }).settings
    : payload;
  if (!source || typeof source !== "object") throw new Error("Settings did not match the API contract.");
  const record = source as Record<string, unknown>;
  if (typeof record.encryptionReady !== "boolean" || !Array.isArray(record.groups)) {
    throw new Error("Settings did not match the API contract.");
  }
  return source as SystemSettings;
}

export function SettingsPage() {
  const settings = useQuery("settings", async () => settingsFrom(await api.get<unknown>("/settings")), { staleAfterMs: 60_000 });
  const providers = useQuery("market:health", fetchProviderHealth, { refreshMs: 30_000, staleAfterMs: 45_000 });
  const risk = useQuery("risk:profiles", async () => listFrom<RiskProfile>(await api.get<unknown>("/risk/profiles"), ["profiles", "items"]), { staleAfterMs: 60_000 });
  const alerts = useQuery("alerts:list", async () => listFrom<Alert>(await api.get<unknown>("/alerts"), ["alerts", "items"]), { staleAfterMs: 60_000 });
  const refreshAll = () => Promise.all([settings.refetch(), providers.refetch(), risk.refetch(), alerts.refetch()]);

  return (
    <div className="settings-page page-stack">
      <header className="page-heading"><div><h1>Settings</h1>{settings.isStale ? <StaleBadge updatedAt={settings.updatedAt} /> : null}</div><button className="button secondary" type="button" onClick={() => void refreshAll()}><RefreshCw size={14} /> Refresh</button></header>
      {settings.isLoading ? <LoadingState title="Loading settings" /> : null}
      {settings.error && !settings.data ? <ErrorState title="Settings unavailable" detail={settings.error.message} onRetry={settings.refetch} /> : null}
      <div className="settings-grid">
        <OperatorTokenForm />
        {settings.data?.groups.map((group) => <SettingsGroupForm key={group.id} group={group} encryptionReady={settings.data!.encryptionReady} onSaved={settings.refetch} />)}
        <section className="panel settings-section"><header className="panel-header"><h2><Server size={17} /> Provider health</h2>{providers.isStale ? <StaleBadge updatedAt={providers.updatedAt} /> : null}</header>{providers.isLoading ? <LoadingState compact title="Loading providers" /> : providers.error ? <ErrorState compact detail={providers.error.message} onRetry={providers.refetch} /> : providers.data?.length ? <ul className="provider-list">{providers.data.map((provider) => <li key={provider.id}><span className={`health-dot health-${provider.status}`} /><div><strong>{provider.name ?? provider.id}</strong><small>{provider.message ?? provider.status}</small></div><span>{provider.latencyMs != null ? `${provider.latencyMs} ms` : "—"}</span></li>)}</ul> : <EmptyState compact title="No provider health" />}</section>
        <section className="panel settings-section"><header className="panel-header"><h2><ShieldCheck size={17} /> Risk profiles</h2></header>{risk.isLoading ? <LoadingState compact title="Loading risk profiles" /> : risk.error ? <ErrorState compact detail={risk.error.message} onRetry={risk.refetch} /> : risk.data?.length ? <ul className="settings-list">{risk.data.map((profile) => <li key={profile.id}><div><strong>{profile.name}</strong><small>{profile.isDefault ? "Default profile" : profile.id}</small></div></li>)}</ul> : <EmptyState compact title="No risk profiles" />}</section>
        <section className="panel settings-section"><header className="panel-header"><h2><Bell size={17} /> Alerts</h2></header>{alerts.isLoading ? <LoadingState compact title="Loading alerts" /> : alerts.error ? <ErrorState compact detail={alerts.error.message} onRetry={alerts.refetch} /> : alerts.data?.length ? <ul className="settings-list">{alerts.data.map((alert) => <li key={alert.id}><div><strong>{alert.name}</strong><small>{alert.triggerType ?? "Trigger unavailable"} · {alert.channel ?? "Channel unavailable"}</small></div><span className={alert.enabled ? "positive" : "muted"}>{alert.enabled ? "Enabled" : "Disabled"}</span></li>)}</ul> : <EmptyState compact title="No alerts configured" />}</section>
      </div>
    </div>
  );
}
