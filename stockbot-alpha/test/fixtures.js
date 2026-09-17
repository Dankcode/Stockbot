/**
 * Deterministic synthetic fixtures.
 *
 * Synthetic data is the right choice for *unit* tests — it lets us assert exact
 * arithmetic and construct precise boundary conditions. It is the wrong choice
 * for evaluating a strategy, which is the distinction the code review's finding
 * C1 is about: synthetic bars behind a `dataStatus: "real"` label. Here they are
 * clearly labelled and never leave the test directory.
 */

const HOUR = 3_600_000;

/** Seeded PRNG so fixtures are byte-identical across runs. */
export function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a bar series.
 *
 * @param {object} [options]
 * @param {number} [options.count=200]
 * @param {number} [options.startMs]
 * @param {number} [options.intervalMs=HOUR]
 * @param {number} [options.startPrice=100]
 * @param {number} [options.driftPerBar=0] fractional drift
 * @param {number} [options.volatility=0.01]
 * @param {number} [options.seed=42]
 */
export function makeBars({
  count = 200,
  startMs = Date.UTC(2025, 0, 6, 14, 30),
  intervalMs = HOUR,
  startPrice = 100,
  driftPerBar = 0,
  volatility = 0.01,
  seed = 42
} = {}) {
  const rand = mulberry32(seed);
  const bars = [];
  let close = startPrice;

  for (let i = 0; i < count; i += 1) {
    const open = close;
    const shock = (rand() - 0.5) * 2 * volatility;
    close = Math.max(0.01, open * (1 + driftPerBar + shock));
    const wick = Math.abs(shock) * open * 0.6 + open * 0.0005;
    bars.push({
      time: new Date(startMs + i * intervalMs).toISOString(),
      open: round(open),
      high: round(Math.max(open, close) + wick),
      low: round(Math.min(open, close) - wick),
      close: round(close),
      volume: Math.round(500_000 + rand() * 500_000)
    });
  }
  return bars;
}

/** A strictly monotonic upward series — useful for exact arithmetic assertions. */
export function makeRamp({ count = 50, startMs = Date.UTC(2025, 0, 6, 14, 30), intervalMs = HOUR, startPrice = 100, step = 1 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const open = startPrice + i * step;
    const close = open + step * 0.5;
    return {
      time: new Date(startMs + i * intervalMs).toISOString(),
      open: round(open),
      high: round(close + 0.25),
      low: round(open - 0.25),
      close: round(close),
      volume: 1_000_000
    };
  });
}

/**
 * Build synthetic news events at explicit offsets from a base time.
 *
 * @param {Array<{offsetMs: number, headline: string, symbols?: string[], summary?: string}>} specs
 * @param {number} baseMs
 */
export function makeEvents(specs, baseMs = Date.UTC(2025, 0, 6, 14, 30)) {
  return specs.map((spec, i) => ({
    id: `fixture:${i}`,
    source: "fixture",
    publishedAt: baseMs + spec.offsetMs,
    symbols: spec.symbols ?? ["TEST"],
    headline: spec.headline,
    summary: spec.summary ?? "",
    url: `https://example.invalid/${i}`,
    meta: spec.meta ?? {}
  }));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export { HOUR };
