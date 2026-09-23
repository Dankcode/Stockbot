import { recommendSymbols } from "../experiments/selection.js";
import { presentSymbolSelection } from "../scoring/symbol.js";

export function createSelectionService({ market }) {
  if (!market?.getBars || !market?.selectionUniverse) throw new TypeError("Selection service requires market bars and a selection universe.");

  async function recommend({ range = "1Y", source = "auto", limit = 10 } = {}) {
    const universe = await market.selectionUniverse({ source, limit: 100 });
    if (universe.forwardTestOnly) market.markForwardTestOnly?.(universe.symbols);
    const ranked = await recommendSymbols({
      universe: universe.symbols,
      getBars: (symbol, requestedRange) => market.getBars(symbol, requestedRange),
      range,
      limit: Math.max(1, Math.min(25, Number(limit) || 10)),
      concurrency: 4
    });
    return presentSymbolSelection(ranked, universe);
  }

  return { recommend };
}
