// SENTIMENT PACK CONTROL — the congruent partner to sentiment-gated-momentum.js.
//
// Byte-for-byte the same technical rules: EMA(9/21) cross entries, cross-down exit,
// same protective stop, same defaults. The ONLY difference is that this file never
// reads `research`. It is the counterfactual: what the same strategy would have done
// with no AI summary in the loop at all.
//
// Run both over the same symbol, window, and fill model. The difference between them
// is the entire measured value of the research pipeline — the scraping, the AI CLI,
// the snapshots, the provenance. Nothing else in Stockbot isolates that.
//
// Read the comparison carefully, because there are three distinct outcomes and only
// one of them is good news:
//
//   gated > blind   The gate filtered out losing entries. Verify it survives the
//                   horizon controls before believing it — a filter that simply
//                   reduces exposure will look like alpha on a symbol that fell.
//   gated ~ blind   The research changed nothing. It is cost, not signal.
//   gated < blind   The gate removed winning entries. Common, and worth knowing:
//                   sentiment often peaks after the move it is describing.
//
// A caveat this control cannot remove: research snapshots exist only where a `run`
// succeeded. If your plan only started producing snapshots last month, the gated
// variant is flat for the rest of the window and will "lose" for reasons that have
// nothing to do with sentiment. Compare over the covered range, or the comparison
// is measuring your scraper's uptime.
export default {
  name: "Control — Sentiment Blind",
  author: "Stockbot control group",
  description: "Research-blind counterfactual: identical EMA(9/21) momentum rules to Sentiment-Gated Momentum, with the research gate removed entirely.",
  params: {
    fast: 9,
    slow: 21,
    stopLossPercent: 8
  },

  signal({ index, bar, params, indicators, position }) {
    if (index < params.slow) return null;

    const fast = indicators.ema(params.fast);
    const slow = indicators.ema(params.slow);

    if (position.qty > 0) {
      if (bar.close <= position.entryPrice * (1 - params.stopLossPercent / 100)) {
        return { action: "sell", reason: `Protective stop at ${params.stopLossPercent}%` };
      }
      const crossedDown = fast[index - 1] >= slow[index - 1] && fast[index] < slow[index];
      if (crossedDown) {
        return { action: "sell", reason: `EMA(${params.fast}) crossed below EMA(${params.slow})` };
      }
      return null;
    }

    const crossedUp = fast[index - 1] <= slow[index - 1] && fast[index] > slow[index];
    const alreadyTrending = index === params.slow && fast[index] > slow[index];
    if (crossedUp || alreadyTrending) {
      return { action: "buy", reason: `EMA(${params.fast}) crossed above EMA(${params.slow}) — ungated` };
    }
    return null;
  }
};
