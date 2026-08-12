import { api, listFrom } from "../../lib/api";
import type { Algorithm, AlgorithmVersion } from "../../lib/types";

export async function fetchAlgorithms() {
  return listFrom<Algorithm>(await api.get<unknown>("/algorithms"), ["algorithms", "items"]);
}

export async function fetchAlgorithm(id: string) {
  return api.get<Algorithm>(`/algorithms/${encodeURIComponent(id)}?source=true`);
}

export async function fetchAlgorithmVersions(id: string) {
  return listFrom<AlgorithmVersion>(await api.get<unknown>(`/algorithms/${encodeURIComponent(id)}/versions`), ["versions", "items"])
    .map((version) => ({ ...version, params: version.params ?? version.paramsJson ?? {} }));
}

export function unwrapBacktest(payload: unknown) {
  if (payload && typeof payload === "object" && "run" in payload) return (payload as Record<string, unknown>).run;
  if (payload && typeof payload === "object" && "result" in payload) return (payload as Record<string, unknown>).result;
  return payload;
}
