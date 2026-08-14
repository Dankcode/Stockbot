import type {
  DatabaseConnectionInput,
  DatabaseConnectionProfile,
  DatabaseConnectionSettings,
  DatabaseLocation
} from "../../lib/types";

export type DatabaseConnectionDraft = Omit<DatabaseConnectionInput, "port"> & { port: string };

export type DatabaseLocationDraftState = {
  draft: DatabaseConnectionDraft;
  advanced: boolean;
  passwordConfigured: boolean;
};

export type DatabaseLocationDrafts = Record<DatabaseLocation, DatabaseLocationDraftState>;

export function draftFromProfile(profile: DatabaseConnectionProfile): DatabaseConnectionDraft {
  return {
    location: profile.location,
    hostname: profile.hostname,
    connectAddress: profile.connectAddress ?? "",
    port: String(profile.port),
    database: profile.database,
    username: profile.username,
    password: "",
    sslMode: profile.sslMode
  };
}

function defaultDraft(location: DatabaseLocation, profile?: DatabaseConnectionProfile): DatabaseConnectionDraft {
  return {
    location,
    hostname: location === "local" ? "127.0.0.1" : "",
    connectAddress: "",
    port: "5432",
    database: profile?.database || "stockbot",
    username: profile?.username || "stockbot",
    password: "",
    sslMode: location === "local" ? "disable" : "require"
  };
}

export function locationDraftsFromSettings(settings?: DatabaseConnectionSettings): DatabaseLocationDrafts {
  const profile = settings?.configuration ?? undefined;
  const drafts: DatabaseLocationDrafts = {
    local: { draft: defaultDraft("local", profile), advanced: false, passwordConfigured: false },
    remote: { draft: defaultDraft("remote", profile), advanced: false, passwordConfigured: false }
  };
  if (profile) {
    drafts[profile.location] = {
      draft: draftFromProfile(profile),
      advanced: Boolean(profile.connectAddress),
      passwordConfigured: profile.passwordConfigured
    };
  }
  return drafts;
}

export function selectedLocation(settings?: DatabaseConnectionSettings): DatabaseLocation {
  return settings?.configuration?.location ?? "local";
}

export function preserveAndSelectLocation(
  states: DatabaseLocationDrafts,
  currentDraft: DatabaseConnectionDraft,
  currentAdvanced: boolean,
  currentPasswordConfigured: boolean,
  location: DatabaseLocation
) {
  const nextStates: DatabaseLocationDrafts = {
    ...states,
    [currentDraft.location]: {
      draft: { ...currentDraft },
      advanced: currentAdvanced,
      passwordConfigured: currentPasswordConfigured
    }
  };
  const selected = nextStates[location];
  return {
    states: nextStates,
    selected: {
      ...selected,
      draft: { ...selected.draft }
    }
  };
}
