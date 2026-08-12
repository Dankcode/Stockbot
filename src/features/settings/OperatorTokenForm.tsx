import { KeyRound, Save, Trash2 } from "lucide-react";
import * as React from "react";
import {
  clearSessionApiToken,
  isSessionApiTokenConfigured,
  setSessionApiToken,
  subscribeSessionApiToken
} from "../../lib/sessionAuth.js";

export function OperatorTokenForm() {
  const configured = React.useSyncExternalStore(
    subscribeSessionApiToken,
    isSessionApiTokenConfigured,
    () => false
  );
  const [draft, setDraft] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const normalized = draft.trim();

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (normalized.length < 32) return;
    setSessionApiToken(normalized);
    setDraft("");
    setMessage("API token set for this browser session. Its value remains hidden.");
  };

  const clear = () => {
    clearSessionApiToken();
    setDraft("");
    setMessage("API token cleared from this browser session.");
  };

  return (
    <section className="panel settings-section operator-token-panel">
      <header className="panel-header">
        <h2><KeyRound size={17} /> API mutation token</h2>
        <span className={configured ? "positive" : "muted"}>{configured ? "Session token set" : "Not set"}</span>
      </header>
      <form autoComplete="off" onSubmit={save}>
        <p id="operator-token-help">
          Enter the server&apos;s <code>STOCKBOT_API_TOKEN</code>. It is kept only in this tab&apos;s browser session
          and sent with POST, PUT, PATCH, and DELETE requests. The stored value is never shown here.
        </p>
        <label className="operator-token-field" htmlFor="operator-api-token">
          <span>Server API token</span>
          <input
            id="operator-api-token"
            aria-describedby="operator-token-help"
            autoComplete="off"
            minLength={32}
            placeholder={configured ? "Enter a replacement token" : "Enter at least 32 characters"}
            spellCheck={false}
            type="password"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setMessage(null);
            }}
          />
          <small>{configured ? "A token is available for mutations in this tab." : "No mutation credential is configured in this tab."}</small>
        </label>
        <footer className="settings-form-footer operator-token-actions">
          <span aria-live="polite">{message}</span>
          <div>
            <button className="button destructive" disabled={!configured} type="button" onClick={clear}><Trash2 size={14} /> Clear</button>
            <button className="button primary" disabled={normalized.length < 32} type="submit"><Save size={14} /> Set for session</button>
          </div>
        </footer>
      </form>
    </section>
  );
}
