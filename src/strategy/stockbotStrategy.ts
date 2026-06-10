import type { Asset } from "../types";

export type StrategySignal = {
  symbol: string;
  action: "buy" | "hold" | "trim";
  conviction: number;
  reason: string;
};

export function evaluateStockbotMomentum(asset: Asset): StrategySignal {
  const momentum = asset.changePercent;
  const volumeScore = Math.min(asset.volume / 4_000_000, 1);
  const conviction = Math.max(0, Math.min(100, 45 + momentum * 7 + volumeScore * 18));

  if (momentum > 2.5 && conviction > 65) {
    return {
      symbol: asset.symbol,
      action: "buy",
      conviction: Math.round(conviction),
      reason: "Price and volume momentum are both above the watch threshold."
    };
  }

  if (momentum < -2) {
    return {
      symbol: asset.symbol,
      action: "trim",
      conviction: Math.round(100 - conviction),
      reason: "Downside move is large enough to protect paper capital."
    };
  }

  return {
    symbol: asset.symbol,
    action: "hold",
    conviction: Math.round(conviction),
    reason: "Setup is not strong enough to beat the control group yet."
  };
}
