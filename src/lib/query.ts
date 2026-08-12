import * as React from "react";

type QueryStatus = "idle" | "loading" | "success" | "error";

type QueryEntry<T> = {
  data?: T;
  error?: Error;
  status: QueryStatus;
  updatedAt: number;
  isFetching: boolean;
  promise?: Promise<T>;
};

type QueryOptions = {
  enabled?: boolean;
  refreshMs?: number;
  staleAfterMs?: number;
};

const cache = new Map<string, QueryEntry<unknown>>();
const listeners = new Map<string, Set<() => void>>();

function entryFor<T>(key: string): QueryEntry<T> {
  let entry = cache.get(key);
  if (!entry) {
    entry = { status: "idle", updatedAt: 0, isFetching: false };
    cache.set(key, entry);
  }
  return entry as QueryEntry<T>;
}

function publish(key: string, entry: QueryEntry<unknown>) {
  cache.set(key, entry);
  listeners.get(key)?.forEach((listener) => listener());
}

function subscribe(key: string, listener: () => void) {
  const bucket = listeners.get(key) ?? new Set<() => void>();
  bucket.add(listener);
  listeners.set(key, bucket);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) listeners.delete(key);
  };
}

async function execute<T>(key: string, fetcher: () => Promise<T>) {
  const current = entryFor<T>(key);
  if (current.promise) return current.promise;

  const promise = fetcher();
  publish(key, {
    ...current,
    status: current.data === undefined ? "loading" : current.status,
    isFetching: true,
    promise
  });
  try {
    const data = await promise;
    publish(key, { data, status: "success", updatedAt: Date.now(), isFetching: false });
    return data;
  } catch (error) {
    const previous = entryFor<T>(key);
    const normalized = error instanceof Error ? error : new Error(String(error));
    publish(key, {
      data: previous.data,
      error: normalized,
      status: previous.data === undefined ? "error" : "success",
      updatedAt: previous.updatedAt,
      isFetching: false
    });
    throw normalized;
  }
}

export function invalidateQuery(key: string) {
  const current = entryFor(key);
  publish(key, { ...current, updatedAt: 0 });
  window.dispatchEvent(new CustomEvent("stockbot:query-invalidated", { detail: key }));
}

export function invalidateQueries(prefix: string) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) invalidateQuery(key);
  }
}

export function useQuery<T>(key: string, fetcher: () => Promise<T>, options: QueryOptions = {}) {
  const { enabled = true, refreshMs = 0, staleAfterMs = 30_000 } = options;
  const fetcherRef = React.useRef(fetcher);
  fetcherRef.current = fetcher;
  const [clock, setClock] = React.useState(() => Date.now());
  const snapshot = React.useSyncExternalStore(
    React.useCallback((listener) => subscribe(key, listener), [key]),
    React.useCallback(() => entryFor<T>(key), [key]),
    React.useCallback(() => entryFor<T>(key), [key])
  );

  const refetch = React.useCallback(() => execute(key, () => fetcherRef.current()).catch(() => undefined), [key]);

  React.useEffect(() => {
    if (!enabled) return;
    const current = entryFor<T>(key);
    if (current.data === undefined || Date.now() - current.updatedAt > staleAfterMs) void refetch();
  }, [enabled, key, refetch, staleAfterMs]);

  React.useEffect(() => {
    if (!enabled || refreshMs <= 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [enabled, refreshMs, refetch]);

  React.useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible" && Date.now() - entryFor<T>(key).updatedAt > staleAfterMs) {
        void refetch();
      }
    };
    const onInvalidated = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) void refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("stockbot:query-invalidated", onInvalidated);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("stockbot:query-invalidated", onInvalidated);
    };
  }, [enabled, key, refetch, staleAfterMs]);

  React.useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), Math.min(Math.max(staleAfterMs, 1_000), 10_000));
    return () => window.clearInterval(timer);
  }, [staleAfterMs]);

  return {
    data: snapshot.data,
    error: snapshot.error,
    status: snapshot.status,
    isLoading: snapshot.status === "idle" || snapshot.status === "loading",
    isFetching: snapshot.isFetching,
    isStale: snapshot.updatedAt > 0 && clock - snapshot.updatedAt > staleAfterMs,
    updatedAt: snapshot.updatedAt,
    refetch
  };
}
