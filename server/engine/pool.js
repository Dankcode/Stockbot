import os from "node:os";
import { Worker } from "node:worker_threads";

const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4
});

function engineError(message, code, detail) {
  const error = new Error(message);
  error.name = code === "ENGINE_TIMEOUT" ? "EngineTimeoutError" : "EngineError";
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function deserializeError(payload) {
  const error = engineError(payload?.message ?? "Engine worker failed.", payload?.code ?? "ENGINE_TASK_FAILED");
  error.name = payload?.name ?? error.name;
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

export class EnginePool {
  constructor({
    size = Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length)),
    timeoutMs = 10_000,
    resourceLimits = DEFAULT_RESOURCE_LIMITS,
    workerUrl = new URL("./worker.js", import.meta.url)
  } = {}) {
    if (!Number.isInteger(size) || size <= 0) throw new TypeError("Engine pool size must be a positive integer.");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Engine timeout must be positive.");

    this.size = size;
    this.timeoutMs = timeoutMs;
    this.resourceLimits = Object.freeze({ ...DEFAULT_RESOURCE_LIMITS, ...resourceLimits });
    this.workerUrl = workerUrl;
    this.closed = false;
    this.nextTaskId = 1;
    this.queue = [];
    this.slots = Array.from({ length: size }, (_, index) => ({ index, worker: null, current: null }));
    for (const slot of this.slots) this.#spawn(slot);
  }

  #spawn(slot) {
    if (this.closed) return;
    const worker = new Worker(this.workerUrl, {
      type: "module",
      resourceLimits: this.resourceLimits
    });
    slot.worker = worker;

    worker.on("message", (message) => {
      if (slot.worker !== worker || !slot.current || slot.current.id !== message.id) return;
      const task = slot.current;
      this.#clearTask(slot, task);
      if (message.ok) task.resolve(message.result);
      else task.reject(deserializeError(message.error));
      this.#dispatch();
    });
    worker.on("error", (error) => {
      if (slot.worker !== worker) return;
      this.#replace(slot, engineError(error.message, "ENGINE_WORKER_ERROR"));
    });
    worker.on("exit", (code) => {
      if (slot.worker !== worker || this.closed) return;
      const error = code === 0 ? null : engineError(`Engine worker exited with code ${code}.`, "ENGINE_WORKER_EXIT");
      this.#replace(slot, error);
    });
    this.#dispatch();
  }

  #clearTask(slot, task) {
    if (task.timer) clearTimeout(task.timer);
    if (task.signal && task.abortHandler) task.signal.removeEventListener("abort", task.abortHandler);
    if (slot.current === task) slot.current = null;
  }

  #replace(slot, taskError) {
    const worker = slot.worker;
    slot.worker = null;
    const task = slot.current;
    if (task) {
      this.#clearTask(slot, task);
      task.reject(taskError ?? engineError("Engine worker stopped before completing the task.", "ENGINE_WORKER_EXIT"));
    }
    const termination = worker ? worker.terminate().catch(() => undefined) : Promise.resolve();
    termination.finally(() => {
      if (!this.closed && slot.worker === null) this.#spawn(slot);
    });
  }

  #dispatch() {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (!slot.worker || slot.current || this.queue.length === 0) continue;
      let task = this.queue.shift();
      while (task?.signal?.aborted) {
        task.reject(engineError("Engine task was aborted.", "ENGINE_ABORTED"));
        task = this.queue.shift();
      }
      if (!task) continue;

      slot.current = task;
      task.slot = slot;
      task.timer = setTimeout(() => {
        if (slot.current !== task) return;
        this.#replace(
          slot,
          engineError(`Engine task exceeded ${task.timeoutMs} ms.`, "ENGINE_TIMEOUT", {
            timeoutMs: task.timeoutMs,
            kind: task.kind
          })
        );
      }, task.timeoutMs);
      slot.worker.postMessage({ id: task.id, kind: task.kind, payload: task.payload });
    }
  }

  submit(kind, payload, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (this.closed) return Promise.reject(engineError("Engine pool is closed.", "ENGINE_POOL_CLOSED"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError("Task timeout must be positive."));
    }

    return new Promise((resolve, reject) => {
      const task = {
        id: this.nextTaskId++,
        kind,
        payload,
        timeoutMs,
        signal,
        resolve,
        reject,
        timer: null,
        abortHandler: null,
        slot: null
      };
      if (signal?.aborted) {
        reject(engineError("Engine task was aborted.", "ENGINE_ABORTED"));
        return;
      }
      if (signal) {
        task.abortHandler = () => {
          const queuedIndex = this.queue.indexOf(task);
          if (queuedIndex >= 0) {
            this.queue.splice(queuedIndex, 1);
            reject(engineError("Engine task was aborted.", "ENGINE_ABORTED"));
          } else if (task.slot?.current === task) {
            this.#replace(task.slot, engineError("Engine task was aborted.", "ENGINE_ABORTED"));
          }
        };
        signal.addEventListener("abort", task.abortHandler, { once: true });
      }
      this.queue.push(task);
      this.#dispatch();
    });
  }

  validateAlgorithm({ algorithmSource, filename = "algorithm.js" }, options) {
    return this.submit("validate", { algorithmSource, filename }, options);
  }

  evaluateSignal({ algorithmSource, filename = "algorithm.js", bars, params, position, state }, options) {
    return this.submit("signal", { algorithmSource, filename, bars, params, position, state }, options);
  }

  runBacktest({ algorithmSource, filename = "algorithm.js", bars, params, ...options }, taskOptions) {
    return this.submit(
      "backtest",
      { algorithmSource, filename, bars, params, options },
      taskOptions
    );
  }

  get stats() {
    return Object.freeze({
      size: this.size,
      active: this.slots.filter((slot) => slot.current).length,
      queued: this.queue.length,
      closed: this.closed
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const closedError = engineError("Engine pool closed before completing the task.", "ENGINE_POOL_CLOSED");
    for (const task of this.queue.splice(0)) {
      if (task.signal && task.abortHandler) task.signal.removeEventListener("abort", task.abortHandler);
      task.reject(closedError);
    }
    const terminations = this.slots.map((slot) => {
      const task = slot.current;
      if (task) {
        this.#clearTask(slot, task);
        task.reject(closedError);
      }
      const worker = slot.worker;
      slot.worker = null;
      return worker ? worker.terminate().catch(() => undefined) : Promise.resolve();
    });
    await Promise.all(terminations);
  }
}

export function createEnginePool(options) {
  return new EnginePool(options);
}
