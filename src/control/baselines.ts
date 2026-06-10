import type { Asset } from "../types";

export type BaselineResult = {
  name: string;
  allocation: number;
  note: string;
};

export function compareBaselines(asset: Asset): BaselineResult[] {
  return [
    {
      name: "Buy and Hold SPY",
      allocation: asset.symbol === "SPY" ? 100 : 0,
      note: "Passive benchmark for broad-market exposure."
    },
    {
      name: "Equal Weight Movers",
      allocation: Math.abs(asset.changePercent) >= 1 ? 10 : 0,
      note: "Simple control that buys volatility without strategy intelligence."
    },
    {
      name: "Cash",
      allocation: 0,
      note: "Zero-risk baseline used to compare drawdown and opportunity cost."
    }
  ];
}
