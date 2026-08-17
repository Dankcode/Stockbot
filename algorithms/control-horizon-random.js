// HORIZON PACK CONTROL — the null hypothesis, per horizon.
//
// Same idea as control-random-entry.js, but its entry rate and holding period are
// derived from a `horizon` band so the null distribution you build is turnover-matched
// to the `horizon-*` strategy you are testing.
//
// This matters more than it sounds. A daily strategy might take 200 trades in a window
// where a yearly strategy takes 2. Comparing either against a single generic random
// control is meaningless — the control has to trade like the thing it is controlling
// for, or you are measuring transaction costs and calling it skill.
//
// Deterministic by construction: a SplitMix32 finalizer over a monotonic counter seeded
// from `params.seed`, advanced exactly once per bar. Same seed and same bars always
// produce the same trades, which keeps Stockbot's result cache honest. No Math.random.
//
// Run seeds 1..20 at each horizon and compare your strategy against the resulting
// distribution, never against one draw. See docs/HORIZON_PACK.md and docs/CONTROL_GROUP.md.
export default {
  name: "Control — Horizon Random Entry",
  author: "Stockbot control group",
  description: "Turnover-matched horizon control: deterministic seeded pseudo-random entries and exits scaled to the selected horizon band. Vary `seed` to build a null distribution.",
  params: {
    horizon: "weekly",
    seed: 1,
    dutyCycle: 0.4,
    warmupBars: 1
  },

  init({ params }) {
    const bands = {
      daily: 2,
      weekly: 5,
      monthly: 21,
      yearly: 252
    };
    const hold = bands[String(params.horizon)] ?? bands.weekly;
    const duty = Math.min(0.95, Math.max(0.05, Number(params.dutyCycle ?? 0.4)));

    // Expected cycle length is hold/duty bars, of which `hold` are invested. The flat
    // stretch therefore averages hold*(1/duty - 1) bars, and a per-bar entry chance of
    // its reciprocal reproduces that in expectation.
    const flatBars = Math.max(1, hold * (1 / duty - 1));
    const entryProbability = Math.min(1, 1 / flatBars);

    const seed = Number.isFinite(params.seed) ? Math.trunc(params.seed) : 1;
    return {
      counter: (seed >>> 0) || 1,
      minHold: Math.max(1, Math.round(hold * 0.5)),
      maxHold: Math.max(1, Math.round(hold * 1.5)),
      entryProbability,
      holdUntil: -1
    };
  },

  signal({ index, params, state, position }) {
    const warmup = Number.isFinite(params.warmupBars) ? Math.max(1, Math.trunc(params.warmupBars)) : 1;
    if (index < warmup) return null;

    state.counter = (state.counter + 0x9e3779b9) >>> 0;
    let mixed = state.counter;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
    mixed = (mixed ^ (mixed >>> 15)) >>> 0;
    const draw = mixed / 4294967296;

    if (position.qty > 0) {
      if (index >= state.holdUntil) {
        return { action: "sell", reason: `Horizon control exit (${params.horizon}, seed ${params.seed})` };
      }
      return null;
    }

    if (draw < state.entryProbability) {
      const span = state.maxHold - state.minHold + 1;
      const offset = Math.floor((draw / Math.max(state.entryProbability, 1e-12)) * span) % span;
      state.holdUntil = index + state.minHold + offset;
      return { action: "buy", reason: `Horizon control entry (${params.horizon}, seed ${params.seed})` };
    }
    return null;
  }
};
