import { CheckCircle2, ChevronDown, Database, FlaskConical, Save } from "lucide-react";
import * as React from "react";
import { ErrorState, LoadingState, StaleBadge } from "../../components/states/DataStates";
import { api } from "../../lib/api";
import type {
  DatabaseConnectionInput,
  DatabaseConnectionProfile,
  DatabaseConnectionSaveResult,
  DatabaseConnectionSettings,
  DatabaseConnectionTestResult,
  DatabaseLocation,
  DatabaseTlsMode
} from "../../lib/types";
import {
  draftFromProfile,
  locationDraftsFromSettings,
  preserveAndSelectLocation,
  selectedLocation,
  type DatabaseConnectionDraft as Draft
} from "./databaseConnectionDrafts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isLocation(value: unknown): value is DatabaseLocation {
  return value === "local" || value === "remote";
}

function isTlsMode(value: unknown): value is DatabaseTlsMode {
  return value === "disable" || value === "require" || value === "verify-full";
}

function profileFrom(value: unknown): DatabaseConnectionProfile {
  if (!isRecord(value)
    || !isLocation(value.location)
    || typeof value.hostname !== "string"
    || (value.connectAddress !== undefined && typeof value.connectAddress !== "string")
    || typeof value.port !== "number"
    || !Number.isInteger(value.port)
    || typeof value.database !== "string"
    || typeof value.username !== "string"
    || !isTlsMode(value.sslMode)
    || typeof value.passwordConfigured !== "boolean") {
    throw new Error("Database settings did not match the API contract.");
  }
  return value as DatabaseConnectionProfile;
}

function activeFrom(value: unknown): DatabaseConnectionSettings["active"] {
  if (!isRecord(value) || (value.dialect !== "postgres" && value.dialect !== "sqlite")) {
    throw new Error("Database settings did not match the API contract.");
  }
  if (value.dialect === "sqlite") return { dialect: "sqlite" };
  if (typeof value.hostname !== "string"
    || (value.connectAddress !== undefined && typeof value.connectAddress !== "string")
    || typeof value.port !== "number"
    || !Number.isInteger(value.port)
    || typeof value.database !== "string"
    || typeof value.username !== "string"
    || !isTlsMode(value.sslMode)) {
    throw new Error("Database settings did not match the API contract.");
  }
  return value as DatabaseConnectionSettings["active"];
}

export function databaseSettingsFrom(payload: unknown): DatabaseConnectionSettings {
  if (!isRecord(payload)
    || typeof payload.restartRequired !== "boolean") {
    throw new Error("Database settings did not match the API contract.");
  }
  return {
    configuration: payload.configuration === null ? null : profileFrom(payload.configuration),
    active: activeFrom(payload.active),
    restartRequired: payload.restartRequired
  };
}

export async function fetchDatabaseSettings() {
  return databaseSettingsFrom(await api.get<unknown>("/settings/database"));
}

function initialDraft(settings?: DatabaseConnectionSettings): Draft | null {
  if (!settings) return null;
  const states = locationDraftsFromSettings(settings);
  return states[selectedLocation(settings)].draft;
}

function comparable(draft: Draft, includePassword = true) {
  return JSON.stringify({
    ...draft,
    hostname: draft.hostname.trim(),
    connectAddress: draft.connectAddress?.trim() ?? "",
    port: draft.port.trim(),
    database: draft.database.trim(),
    username: draft.username.trim(),
    password: includePassword ? draft.password?.trim() ?? "" : ""
  });
}

function connectionInput(draft: Draft): DatabaseConnectionInput {
  const password = draft.password?.trim();
  return {
    location: draft.location,
    hostname: draft.hostname.trim(),
    connectAddress: draft.connectAddress?.trim() || undefined,
    port: Number(draft.port),
    database: draft.database.trim(),
    username: draft.username.trim(),
    sslMode: draft.sslMode,
    ...(password ? { password } : {})
  };
}

function connectionValidation(draft: Draft, passwordConfigured: boolean) {
  if (!draft.hostname.trim()) return "Enter the PostgreSQL server hostname.";
  const port = Number(draft.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return "Port must be an integer from 1 to 65535.";
  if (!draft.database.trim()) return "Enter the PostgreSQL database name.";
  if (!draft.username.trim()) return "Enter the PostgreSQL username.";
  if (!passwordConfigured && !draft.password?.trim()) return "Enter the PostgreSQL password.";
  return null;
}

function tlsLabel(mode: DatabaseTlsMode) {
  if (mode === "verify-full") return "Certificate and hostname verified";
  if (mode === "require") return "Encrypted";
  return "Not encrypted";
}

export function DatabaseConnectionForm({ settings, isLoading, error, isStale, updatedAt, onRetry }: {
  settings?: DatabaseConnectionSettings;
  isLoading: boolean;
  error?: Error;
  isStale: boolean;
  updatedAt: number;
  onRetry: () => Promise<unknown>;
}) {
  const locationDrafts = React.useRef(locationDraftsFromSettings(settings));
  const [draft, setDraft] = React.useState<Draft | null>(() => initialDraft(settings));
  const [baseline, setBaseline] = React.useState(() => {
    const initial = initialDraft(settings);
    return initial ? comparable(initial, false) : "";
  });
  const [passwordConfigured, setPasswordConfigured] = React.useState(settings?.configuration?.passwordConfigured ?? false);
  const [advanced, setAdvanced] = React.useState(() => Boolean(settings?.configuration?.connectAddress));
  const [testing, setTesting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [testMessage, setTestMessage] = React.useState<string | null>(null);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [restartRequired, setRestartRequired] = React.useState(settings?.restartRequired ?? false);

  React.useEffect(() => {
    if (!settings) return;
    const nextStates = locationDraftsFromSettings(settings);
    const next = nextStates[selectedLocation(settings)];
    locationDrafts.current = nextStates;
    setDraft(next.draft);
    setBaseline(comparable(next.draft, false));
    setAdvanced(next.advanced);
    setPasswordConfigured(next.passwordConfigured);
    setRestartRequired(settings.restartRequired);
  }, [settings]);

  const update = <Key extends keyof Draft>(key: Key, value: Draft[Key]) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, [key]: value };
      locationDrafts.current = {
        ...locationDrafts.current,
        [next.location]: {
          ...locationDrafts.current[next.location],
          draft: next
        }
      };
      return next;
    });
    setTestMessage(null);
    setSaveMessage(null);
    setFormError(null);
  };

  const chooseLocation = (location: DatabaseLocation) => {
    if (!draft || draft.location === location) return;
    const next = preserveAndSelectLocation(locationDrafts.current, draft, advanced, passwordConfigured, location);
    locationDrafts.current = next.states;
    setDraft(next.selected.draft);
    setAdvanced(next.selected.advanced);
    setPasswordConfigured(next.selected.passwordConfigured);
    setTestMessage(null);
    setSaveMessage(null);
    setFormError(null);
  };

  const validation = draft ? connectionValidation(draft, passwordConfigured) : null;
  const dirty = draft ? comparable(draft) !== baseline : false;

  const testConnection = async () => {
    if (!draft || validation) return;
    setTesting(true);
    setFormError(null);
    setTestMessage(null);
    try {
      const result = await api.post<DatabaseConnectionTestResult>("/settings/database/test", connectionInput(draft));
      if (!result.ok) throw new Error("PostgreSQL did not accept the connection settings.");
      const identity = result.user && result.database
        ? ` Connected to ${result.database} as ${result.user}.`
        : "";
      setTestMessage(`Connection successful.${identity} ${result.tls ? "TLS is active." : "TLS is disabled."}`);
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Unable to test the PostgreSQL connection.");
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || validation || !dirty) return;
    setSaving(true);
    setFormError(null);
    setSaveMessage(null);
    try {
      const result = await api.put<DatabaseConnectionSaveResult>("/settings/database", connectionInput(draft));
      if (!result.configuration) throw new Error("The server did not return the saved PostgreSQL configuration.");
      const next = draftFromProfile(result.configuration);
      setDraft(next);
      setBaseline(comparable(next, false));
      setPasswordConfigured(result.configuration.passwordConfigured);
      setRestartRequired(result.restartRequired);
      locationDrafts.current = {
        ...locationDrafts.current,
        [next.location]: {
          draft: next,
          advanced,
          passwordConfigured: result.configuration.passwordConfigured
        }
      };
      setTestMessage(null);
      setSaveMessage(result.restartRequired
        ? "Saved. Restart Stockbot to activate this connection."
        : "Database connection saved and active.");
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Unable to save the database connection.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel settings-section settings-editor database-connection-panel">
      <header className="panel-header">
        <h2><Database size={17} /> Database connection</h2>
        <div className="database-panel-status">
          {isStale ? <StaleBadge updatedAt={updatedAt} /> : null}
          {settings || restartRequired ? <span className={restartRequired ? "warning" : "positive"}>{restartRequired ? "Restart required" : settings?.active.dialect === "sqlite" ? "SQLite active" : "PostgreSQL active"}</span> : null}
        </div>
      </header>
      {isLoading && !draft ? <LoadingState compact title="Loading database settings" /> : null}
      {error && !draft ? <ErrorState compact title="Database settings unavailable" detail={error.message} onRetry={onRetry} /> : null}
      {draft ? (
        <form onSubmit={save}>
          <div className="database-form-intro">
            <p>Choose where PostgreSQL runs. Stockbot saves the connection for its server process; credentials never enter the frontend bundle.</p>
            <div className="database-location-options" role="radiogroup" aria-label="PostgreSQL location">
              <button className={draft.location === "local" ? "selected" : ""} type="button" role="radio" aria-checked={draft.location === "local"} onClick={() => chooseLocation("local")}>
                <strong>Local PostgreSQL</strong>
                <span>PostgreSQL runs on this machine, normally at loopback.</span>
              </button>
              <button className={draft.location === "remote" ? "selected" : ""} type="button" role="radio" aria-checked={draft.location === "remote"} onClick={() => chooseLocation("remote")}>
                <strong>Remote / private PostgreSQL</strong>
                <span>PostgreSQL runs on another machine reached through a LAN or private VPN such as Tailscale.</span>
              </button>
            </div>
          </div>

          <div className="database-field-grid">
            <label>
              <span>Server hostname</span>
              <input required autoComplete="off" spellCheck={false} placeholder={draft.location === "local" ? "127.0.0.1" : "database.internal"} value={draft.hostname} onChange={(event) => update("hostname", event.target.value)} />
              <small>{draft.location === "local" ? "Use 127.0.0.1 when PostgreSQL listens locally." : "The hostname used for PostgreSQL and TLS verification."}</small>
            </label>
            <label>
              <span>Port</span>
              <input required inputMode="numeric" min={1} max={65535} type="number" value={draft.port} onChange={(event) => update("port", event.target.value)} />
              <small>PostgreSQL normally uses 5432.</small>
            </label>
            <label>
              <span>Database</span>
              <input required autoComplete="off" spellCheck={false} placeholder="stockbot" value={draft.database} onChange={(event) => update("database", event.target.value)} />
              <small>The database Stockbot will migrate and use.</small>
            </label>
            <label>
              <span>Username</span>
              <input required autoComplete="username" spellCheck={false} placeholder="stockbot" value={draft.username} onChange={(event) => update("username", event.target.value)} />
              <small>Use a dedicated PostgreSQL role.</small>
            </label>
            <label>
              <span>Password</span>
              <input autoComplete="new-password" type="password" placeholder={passwordConfigured ? "Stored — leave blank to keep" : "Enter PostgreSQL password"} value={draft.password ?? ""} onChange={(event) => update("password", event.target.value)} />
              <small>{passwordConfigured ? "A password is stored; blank preserves it." : "The password is write-only and will not be shown again."}</small>
            </label>
            <label>
              <span>TLS</span>
              <select value={draft.sslMode} onChange={(event) => update("sslMode", event.target.value as DatabaseTlsMode)}>
                <option value="disable">Disabled</option>
                <option value="require">Require encryption</option>
                <option value="verify-full">Verify certificate and hostname</option>
              </select>
              <small>{tlsLabel(draft.sslMode)}</small>
            </label>
          </div>

          <div className="database-advanced-section">
            <button className="database-advanced-toggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced((current) => {
              const next = !current;
              locationDrafts.current = {
                ...locationDrafts.current,
                [draft.location]: { ...locationDrafts.current[draft.location], advanced: next }
              };
              return next;
            })}>
              <ChevronDown size={15} className={advanced ? "expanded" : ""} /> Advanced network address
            </button>
            {advanced ? (
              <label>
                <span>Connect address or IP <small>Optional</small></span>
                <input autoComplete="off" spellCheck={false} placeholder="192.168.1.20 or private IPv6" value={draft.connectAddress ?? ""} onChange={(event) => update("connectAddress", event.target.value)} />
                <small>Use only when Stockbot must dial an address different from the server hostname. The hostname remains the TLS identity.</small>
              </label>
            ) : null}
          </div>

          <aside className="database-switch-notice">
            <strong>Switching databases does not copy data.</strong>
            <span>The selected database must contain its own Stockbot history. Saving prepares the connection; a service restart activates it.</span>
          </aside>

          {validation && dirty ? <p className="database-validation" role="status">{validation}</p> : null}
          <footer className="settings-form-footer database-form-footer">
            <div aria-live="polite">
              {formError ? <span className="inline-error" role="alert">{formError}</span>
                : saveMessage ? <span className="positive" role="status">{saveMessage}</span>
                  : testMessage ? <span className="positive" role="status"><CheckCircle2 size={13} /> {testMessage}</span>
                    : <span className="muted">Test before saving when changing hosts or credentials.</span>}
            </div>
            <div>
              <button className="button secondary" disabled={testing || saving || Boolean(validation)} type="button" onClick={() => void testConnection()}><FlaskConical size={14} />{testing ? "Testing" : "Test connection"}</button>
              <button className="button primary" disabled={saving || testing || Boolean(validation) || !dirty} type="submit"><Save size={14} />{saving ? "Saving" : "Save connection"}</button>
            </div>
          </footer>
        </form>
      ) : null}
    </section>
  );
}
