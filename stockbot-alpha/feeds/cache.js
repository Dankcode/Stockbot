/**
 * On-disk JSON cache for feed data, plus a shared rate limiter.
 *
 * Feed data is expensive to fetch, rate-limited at the source, and immutable
 * once published — which makes it close to an ideal caching target. Cache keys
 * include the provider, symbol and time window, so re-running a backtest costs
 * nothing and a walk-forward sweep over 40 folds hits the network once.
 *
 * Deliberately files-on-disk rather than the SQL layer: this package needs to
 * work today, before the database in docs/plan/02-architecture.md exists. The
 * `store` interface is narrow enough to swap for a repository later.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Token-bucket rate limiter.
 *
 * SEC's fair-access policy caps at 10 requests/second and will 403 you (and
 * briefly block your IP) if you exceed it. Alpaca has its own per-plan limits.
 * Rather than sprinkling sleeps through the providers, each provider owns a
 * limiter configured to its source's published ceiling.
 */
export class RateLimiter {
  /**
   * @param {number} requestsPerSecond
   */
  constructor(requestsPerSecond) {
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new RangeError("RateLimiter: requestsPerSecond must be a positive number");
    }
    this.intervalMs = 1000 / requestsPerSecond;
    this.nextSlot = 0;
  }

  /** Resolves when the caller is clear to issue a request. */
  async take() {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    const waitMs = slot - now;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * Fetch with retry on transient failures and rate-limit responses.
 *
 * Honors `Retry-After` when present — both SEC and Alpaca send it, and
 * ignoring it is how you get escalated from throttled to blocked.
 *
 * @param {string} url
 * @param {object} init
 * @param {object} [options]
 * @param {RateLimiter} [options.limiter]
 * @param {number} [options.retries=3]
 * @param {number} [options.timeoutMs=20000]
 * @returns {Promise<Response>}
 */
export async function politeFetch(url, init = {}, options = {}) {
  const { limiter, retries = 3, timeoutMs = 20000 } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (limiter) await limiter.take();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30000, 500 * 2 ** attempt);
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        // 4xx other than 429 is a request problem — retrying will not help.
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} from ${url}: ${body.slice(0, 300)}`);
      }

      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      const retryable = error.name === "AbortError" || /^HTTP 5|^HTTP 429/.test(error.message);
      if (!retryable || attempt === retries) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 500 * 2 ** attempt)));
    }
  }

  throw lastError ?? new Error(`politeFetch: exhausted retries for ${url}`);
}

/** Stable cache key from an arbitrary descriptor object. */
export function cacheKey(descriptor) {
  const canonical = JSON.stringify(descriptor, Object.keys(descriptor).sort());
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const label = String(descriptor.provider ?? "feed").replace(/[^a-zA-Z0-9-_]/g, "-");
  const symbol = String(descriptor.symbol ?? "all").replace(/[^a-zA-Z0-9-_.]/g, "-");
  return `${label}__${symbol}__${hash}`;
}

export class FeedCache {
  /**
   * @param {string} dir
   * @param {object} [options]
   * @param {number} [options.ttlMs] undefined = never expires (correct for
   *   historical windows, which are immutable). Set a TTL for windows whose
   *   right edge is "now".
   */
  constructor(dir, options = {}) {
    this.dir = dir;
    this.ttlMs = options.ttlMs;
    fs.mkdirSync(dir, { recursive: true });
  }

  pathFor(key) {
    return path.join(this.dir, `${key}.json`);
  }

  /** @returns {object|null} */
  read(key) {
    const file = this.pathFor(key);
    if (!fs.existsSync(file)) return null;
    try {
      const payload = JSON.parse(fs.readFileSync(file, "utf8"));
      if (this.ttlMs != null && Date.now() - payload.cachedAt > this.ttlMs) return null;
      return payload;
    } catch {
      // A corrupt cache entry should be a cache miss, not a crash.
      return null;
    }
  }

  /** @param {object} data */
  write(key, data, meta = {}) {
    const file = this.pathFor(key);
    const tmp = `${file}.${process.pid}.tmp`;
    const payload = { cachedAt: Date.now(), ...meta, data };
    // Write-then-rename so a killed process cannot leave a half-written entry
    // that later parses as valid JSON.
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
    return payload;
  }

  /**
   * Read through to `producer` on miss.
   * @param {string} key
   * @param {() => Promise<object>} producer
   */
  async through(key, producer, meta = {}) {
    const hit = this.read(key);
    if (hit) return { ...hit, fromCache: true };
    const data = await producer();
    return { ...this.write(key, data, meta), fromCache: false };
  }

  stats() {
    const files = fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")) : [];
    const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(this.dir, f)).size, 0);
    return { entries: files.length, bytes };
  }
}
