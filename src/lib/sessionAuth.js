export const SESSION_API_TOKEN_STORAGE_KEY = "stockbot:mutation-api-token";

function normalizeToken(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function createSessionTokenStore(storage = null) {
  const listeners = new Set();
  let token = "";

  try {
    token = normalizeToken(storage?.getItem(SESSION_API_TOKEN_STORAGE_KEY));
  } catch {
    // Memory-only fallback for browsers where session storage is unavailable.
  }

  const publish = () => listeners.forEach((listener) => listener());
  const clear = () => {
    const changed = token.length > 0;
    token = "";
    try {
      storage?.removeItem(SESSION_API_TOKEN_STORAGE_KEY);
    } catch {
      // Clearing the in-memory value is sufficient for this page.
    }
    if (changed) publish();
  };

  return {
    get() {
      return token;
    },
    isConfigured() {
      return token.length > 0;
    },
    set(value) {
      const next = normalizeToken(value);
      if (!next) {
        clear();
        return;
      }
      if (next === token) return;
      token = next;
      try {
        storage?.setItem(SESSION_API_TOKEN_STORAGE_KEY, token);
      } catch {
        // The in-memory value still lasts until this page is unloaded.
      }
      publish();
    },
    clear,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function browserSessionStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const sessionTokenStore = createSessionTokenStore(browserSessionStorage());

export const getSessionApiToken = () => sessionTokenStore.get();
export const isSessionApiTokenConfigured = () => sessionTokenStore.isConfigured();
export const setSessionApiToken = (value) => sessionTokenStore.set(value);
export const clearSessionApiToken = () => sessionTokenStore.clear();
export const subscribeSessionApiToken = (listener) => sessionTokenStore.subscribe(listener);
