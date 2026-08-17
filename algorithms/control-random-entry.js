// CONTROL — the null hypothesis.
//
// Trades on a deterministic pseudo-random schedule that carries no market information.
// This is the control that tells you whether a strategy's edge is real or whether any
// sequence of trades with a similar exposure profile would have looked the same on this
// symbol over this window.
//
// If your strategy does not clearly beat a spread of seeds here, it has not demonstrated
// an edge — it has demonstrated that the symbol went up.
//
// Determinism matters. Stockbot caches results by (version, params, symbol, window,
// bar hash, fill model), so a control that called a real random source would silently
// invalidate reproducibility and make cached and fresh runs disagree. Instead this uses
// a small deterministic PRNG (SplitMix32-style mixing over an explicit counter) seeded
// only from `params.seed`. Same seed and same bars always produce the same trades.
//
// Run it across several seeds (10 is a reasonable minimum) and compare your strategy
// against the DISTRIBUTION of control outcomes, not against a single lucky or unlucky
// draw. See docs/CONTROL_GROUP.md for the procedure.
export default {
  name: "Control — Random Entry",
  author: "Stockbot control group",
  description: "Information-free control: enters and exits on a deterministic seeded pseudo-random schedule. Vary `seed` to build a null distribution.",
  params: {
    seed: 1,
    entryProbability: 0.05,
    minHoldBars: 5,
    maxHoldBars: 20,
    warmupBars: 1
  },

  init({ params }) {
    const seed = Number.isFinite(params.seed) ? Math.trunc(params.seed) : 1;
    return { counter: (seed >>> 0) || 1, holdUntil: -1 };
  },

  signal({ index, params, state, position }) {
    const warmup = Number.isFinite(params.warmupBars) ? Math.max(1, Math.trunc(params.warmupBars)) : 1;
    if (index < warmup) return null;

    // SplitMix32 finalizer over a monotonic counter. Advanced exactly once per bar so
    // the draw sequence depends only on the seed and the bar index, never on the path
    // the strategy happened to take.
    state.counter = (state.counter + 0x9e3779b9) >>> 0;
    let mixed = state.counter;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
    mixed = (mixed ^ (mixed >>> 15)) >>> 0;
    const draw = mixed / 4294967296;

    const minHold = Math.max(1, Math.trunc(params.minHoldBars ?? 5));
    const maxHold = Math.max(minHold, Math.trunc(params.maxHoldBars ?? 20));

    if (position.qty > 0) {
      if (index >= state.holdUntil) {
        return { action: "sell", reason: `Control exit after randomized hold (seed ${params.seed})` };
      }
      return null;
    }

    const probability = Math.min(1, Math.max(0, Number(params.entryProbability ?? 0.05)));
    if (draw < probability) {
      const span = maxHold - minHold + 1;
      state.holdUntil = index + minHold + Math.floor(draw / Math.max(probability, 1e-12) * span) % span;
      return { action: "buy", reason: `Control entry from seeded draw (seed ${params.seed})` };
    }
    return null;
  }
};
