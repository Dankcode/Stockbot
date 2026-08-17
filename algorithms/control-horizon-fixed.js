// HORIZON PACK CONTROL — exposure-matched, deterministic, information-free.
//
// The congruent partner to every `horizon-*` strategy. Set `horizon` to the same band
// as the strategy you are testing and this control trades on the same rough turnover
// and time-in-market with no reference to price at all.
//
// This is the control that separates two claims a horizon comparison constantly
// confuses:
//
//   1. "The monthly variant beat the daily variant because the rules work better
//       at that horizon."
//   2. "The monthly variant beat the daily variant because it traded 20x less and
//       paid 20x less slippage."
//
// Claim 2 is the default explanation and it needs to be ruled out first. Run this
// control at each horizon before attributing anything to the method.
//
// Bands are expressed on 1day bars, matching the horizon pack:
//   daily   ~2 bars held    weekly  ~5 bars held
//   monthly ~21 bars held   yearly  ~252 bars held
//
// An unrecognized `horizon` falls back to weekly rather than throwing, so a typo
// produces a visibly wrong exposure instead of a dead run.
export default {
  name: "Control — Horizon Fixed Interval",
  author: "Stockbot control group",
  description: "Exposure-matched horizon control: buys on a fixed cadence and holds a fixed span for the selected horizon band, ignoring price entirely.",
  params: {
    horizon: "weekly",
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

    // dutyCycle is the fraction of bars the control intends to be invested. Cadence
    // follows from it, so exposure stays comparable across horizons while turnover
    // scales with the band the same way the strategies' do.
    const duty = Math.min(0.95, Math.max(0.05, Number(params.dutyCycle ?? 0.4)));
    const cadence = Math.max(1, Math.round(hold / duty));

    return { hold, cadence, holdUntil: -1 };
  },

  signal({ index, params, state, position }) {
    const warmup = Number.isFinite(params.warmupBars) ? Math.max(1, Math.trunc(params.warmupBars)) : 1;
    if (index < warmup) return null;

    if (position.qty > 0) {
      if (index >= state.holdUntil) {
        return { action: "sell", reason: `Horizon control exit after ${state.hold} bars (${params.horizon})` };
      }
      return null;
    }

    if ((index - warmup) % state.cadence === 0) {
      state.holdUntil = index + state.hold;
      return { action: "buy", reason: `Horizon control entry on ${state.cadence}-bar cadence (${params.horizon})` };
    }
    return null;
  }
};
