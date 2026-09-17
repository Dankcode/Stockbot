/**
 * Experiment execution.
 *
 * The runner does not know how an arm is executed. It is handed an `execute(arm, plan)`
 * function and its only jobs are ordering, concurrency, failure isolation and progress
 * reporting. That indirection is the point: the same plan runs through the loopback API
 * (`scripts/experiment.js`, where results land in the backtest cache and the dashboard
 * shows them), through an in-process engine (the offline harness, no provider needed),
 * or through a stub (the tests) with no branching anywhere in this file.
 *
 * A failed arm never aborts the experiment. A 60-arm run that dies on arm 7 because one
 * provider hiccuped wastes the other 59, and the report is explicitly built to say
 * "incomplete" rather than to quietly average over the gaps.
 */

const DEFAULT_CONCURRENCY = 4;

/** Strategy arms run first so a long control sweep never delays the headline number. */
function executionOrder(plan) {
  return [...plan.arms].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "strategy" ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export async function runExperiment({ plan, execute, concurrency = DEFAULT_CONCURRENCY, onProgress, signal }) {
  if (typeof execute !== "function") {
    throw new TypeError("runExperiment requires an execute(arm, plan) function.");
  }
  const limit = Math.max(1, Math.min(16, Math.trunc(Number(concurrency)) || DEFAULT_CONCURRENCY));
  const queue = executionOrder(plan);
  const results = new Map();
  let completed = 0;
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;
      const arm = queue[index];
      const started = Date.now();
      try {
        const outcome = await execute(arm, plan);
        results.set(arm.key, Object.freeze({ arm, metrics: outcome?.metrics ?? null, result: outcome, error: null, ms: Date.now() - started }));
      } catch (cause) {
        results.set(arm.key, Object.freeze({
          arm,
          metrics: null,
          result: null,
          error: cause?.message ?? String(cause),
          code: cause?.code ?? null,
          ms: Date.now() - started
        }));
      }
      completed += 1;
      onProgress?.({ completed, total: queue.length, arm, ok: results.get(arm.key).error === null });
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  return results;
}

/**
 * Executor that drives the existing `/api/v1/algorithms/:id/backtest` endpoint. Using
 * the same endpoint the dashboard uses is deliberate: results, caching, provenance and
 * the built-in SPY/Cash controls stay identical to what an operator sees in the UI, and
 * an experiment can never disagree with the screen.
 */
export function createApiExecutor({ baseUrl, token, timeoutMs = 180_000, fetchImpl = fetch }) {
  return async function executeViaApi(arm, plan) {
    const response = await fetchImpl(new URL(`/api/v1/algorithms/${encodeURIComponent(arm.algorithmId)}/backtest`, baseUrl), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "x-stockbot-token": token },
      body: JSON.stringify({
        symbol: plan.symbol,
        range: plan.range,
        ...(Object.keys(arm.params).length > 0 ? { params: arm.params } : {}),
        ...(Object.keys(plan.fillModel ?? {}).length > 0 ? { fillModel: plan.fillModel } : {})
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      const error = new Error(`Stockbot API returned non-JSON HTTP ${response.status}.`);
      error.code = "EXPERIMENT_API_INVALID_RESPONSE";
      throw error;
    }
    if (!response.ok || payload?.error) {
      const error = new Error(payload?.error?.message ?? `Stockbot API returned HTTP ${response.status}.`);
      error.code = payload?.error?.code ?? "EXPERIMENT_API_ERROR";
      throw error;
    }
    const data = payload.data;
    const metrics = data?.metrics ?? data?.strategy?.metrics ?? data?.result?.metrics;
    if (!metrics) {
      const error = new Error("Backtest response contained no metrics.");
      error.code = "EXPERIMENT_API_SHAPE";
      throw error;
    }
    return { metrics, cache: data.cache ?? null, source: data.source ?? null, algorithmVersionId: data.algorithmVersionId ?? null };
  };
}
