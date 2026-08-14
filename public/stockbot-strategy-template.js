/**
 * Stockbot plug-and-play strategy template
 *
 * 1. Rename this file.
 * 2. Adjust the metadata, parameters, and signal rules below.
 * 3. Upload the saved .js file from Stockbot → Strategies.
 * 4. Open the installed strategy and run a backtest.
 *
 * Strategy files are synchronous, long-only modules. They do not import
 * packages or access the network, filesystem, environment, or a live broker.
 */
export default {
  name: "My Moving Average Strategy",
  author: "Your name",
  description: "Buys when the fast moving average crosses above the slow average and exits on the reverse cross.",
  params: {
    fastPeriod: 10,
    slowPeriod: 30
  },

  signal({ index, params, indicators, position }) {
    if (index < params.slowPeriod) return null;

    const fast = indicators.sma(params.fastPeriod);
    const slow = indicators.sma(params.slowPeriod);
    const crossedUp = fast[index - 1] <= slow[index - 1] && fast[index] > slow[index];
    const crossedDown = fast[index - 1] >= slow[index - 1] && fast[index] < slow[index];

    if (position.qty === 0 && crossedUp) {
      return { action: "buy", reason: "Fast SMA crossed above slow SMA" };
    }
    if (position.qty > 0 && crossedDown) {
      return { action: "sell", reason: "Fast SMA crossed below slow SMA" };
    }
    return null;
  }
};
