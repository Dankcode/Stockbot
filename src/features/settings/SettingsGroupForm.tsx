import { LockKeyhole, Save, SlidersHorizontal } from "lucide-react";
import * as React from "react";
import { api } from "../../lib/api";
import type { SettingGroup, SystemSettings } from "../../lib/types";

function initialValues(group: SettingGroup) {
  return Object.fromEntries(group.fields.map((field) => [field.key, field.secret ? "" : String(field.value ?? "")]));
}

export function SettingsGroupForm({ group, encryptionReady, onSaved }: {
  group: SettingGroup;
  encryptionReady: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const [values, setValues] = React.useState<Record<string, string>>(() => initialValues(group));
  const [dirty, setDirty] = React.useState<Set<string>>(() => new Set());
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    setValues(initialValues(group));
    setDirty(new Set());
  }, [group]);

  const updates = React.useMemo(() => {
    const next: Record<string, string> = {};
    for (const field of group.fields) {
      const value = values[field.key] ?? "";
      if (!dirty.has(field.key) || field.readOnly || (field.secret && value.trim() === "")) continue;
      next[field.key] = value;
    }
    return next;
  }, [dirty, group.fields, values]);

  const change = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty((current) => new Set(current).add(key));
    setMessage(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!Object.keys(updates).length) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await api.put<SystemSettings>("/settings", { settings: updates });
      await onSaved();
      setMessage("Settings saved. Stored secrets were not revealed.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save settings.");
    } finally {
      setSaving(false);
    }
  };

  const containsSecrets = group.fields.some((field) => field.secret);
  return (
    <section className="panel settings-section settings-editor">
      <header className="panel-header"><h2>{containsSecrets ? <LockKeyhole size={17} /> : <SlidersHorizontal size={17} />}{group.label}</h2></header>
      {!encryptionReady && containsSecrets ? <p className="settings-warning" role="status">Secret storage is locked until the server encryption key is configured.</p> : null}
      <form onSubmit={save}>
        <div className="settings-field-list">
          {group.fields.map((field) => (
            <label key={field.key}>
              <span>{field.label}</span>
              <input
                autoComplete={field.secret ? "new-password" : "off"}
                disabled={field.readOnly}
                placeholder={field.secret && field.hasValue ? "Stored — leave blank to keep" : field.secret ? "Not configured" : undefined}
                type={field.secret ? "password" : "text"}
                value={values[field.key] ?? ""}
                onChange={(event) => change(field.key, event.target.value)}
              />
              <small>{field.readOnly ? "Read-only" : field.secret && field.hasValue ? "Configured; blank preserves it" : field.key}</small>
            </label>
          ))}
        </div>
        <footer className="settings-form-footer">
          <div>{error ? <span className="inline-error" role="alert">{error}</span> : message ? <span className="positive" role="status">{message}</span> : null}</div>
          <button className="button secondary" disabled={saving || Object.keys(updates).length === 0} type="submit"><Save size={14} />{saving ? "Saving" : "Save group"}</button>
        </footer>
      </form>
    </section>
  );
}
