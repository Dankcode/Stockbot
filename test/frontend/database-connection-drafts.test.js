import assert from "node:assert/strict";
import test from "node:test";

import {
  locationDraftsFromSettings,
  preserveAndSelectLocation
} from "../../src/features/settings/databaseConnectionDrafts.ts";

function remoteSettings() {
  return {
    configuration: {
      location: "remote",
      hostname: "postgres.private.example",
      connectAddress: "fd7a:115c:a1e0::42",
      port: 5432,
      database: "stockbot",
      username: "stockbot",
      sslMode: "verify-full",
      passwordConfigured: true
    },
    active: {
      dialect: "postgres",
      hostname: "postgres.private.example",
      connectAddress: "fd7a:115c:a1e0::42",
      port: 5432,
      database: "stockbot",
      username: "stockbot",
      sslMode: "verify-full"
    },
    restartRequired: false
  };
}

test("location drafts preserve independent unsaved local and remote edits", () => {
  let states = locationDraftsFromSettings(remoteSettings());
  const savedRemote = {
    ...states.remote.draft,
    hostname: "edited.private.example",
    connectAddress: "fd7a:115c:a1e0::99",
    database: "remote-paper",
    sslMode: "verify-full"
  };

  const localSelection = preserveAndSelectLocation(states, savedRemote, true, true, "local");
  states = localSelection.states;
  assert.equal(localSelection.selected.draft.hostname, "127.0.0.1");
  assert.equal(localSelection.selected.draft.sslMode, "disable");
  assert.equal(localSelection.selected.advanced, false);

  const editedLocal = {
    ...localSelection.selected.draft,
    port: "5544",
    database: "local-paper",
    password: "unsaved-local-password"
  };
  const remoteSelection = preserveAndSelectLocation(states, editedLocal, false, false, "remote");

  assert.deepEqual(remoteSelection.selected, {
    draft: savedRemote,
    advanced: true,
    passwordConfigured: true
  });
  assert.equal(remoteSelection.states.local.draft.database, "local-paper");
  assert.equal(remoteSelection.states.local.draft.password, "unsaved-local-password");
});

test("settings refresh creates fresh location caches", () => {
  const first = locationDraftsFromSettings(remoteSettings());
  first.remote.draft.hostname = "unsaved.private.example";
  first.local.draft.port = "6000";

  const refreshed = locationDraftsFromSettings(remoteSettings());
  assert.equal(refreshed.remote.draft.hostname, "postgres.private.example");
  assert.equal(refreshed.remote.draft.connectAddress, "fd7a:115c:a1e0::42");
  assert.equal(refreshed.remote.draft.sslMode, "verify-full");
  assert.equal(refreshed.local.draft.port, "5432");
});
