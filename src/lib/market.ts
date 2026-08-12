import {
  MarketQuoteSchema,
  type Quote,
  type UnavailableQuote
} from "../../packages/shared/schemas.js";
import {
  MarketBarsSchema,
  MarketSearchSchema,
  ProviderHealthListSchema
} from "./contracts";
import { api } from "./api";
import type { MarketAsset, MarketBars, ProviderHealth } from "./types";

export async function fetchMarketSearch(query: string): Promise<MarketAsset[]> {
  return api.getValidated(
    `/market/search?q=${encodeURIComponent(query)}&limit=20`,
    MarketSearchSchema
  );
}

export async function fetchMarketQuote(symbol: string): Promise<Quote | UnavailableQuote> {
  return api.getValidated(`/market/quote/${encodeURIComponent(symbol)}`, MarketQuoteSchema);
}

export async function fetchMarketBars(symbol: string, range: string): Promise<MarketBars> {
  return api.getValidated(
    `/market/bars/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}`,
    MarketBarsSchema
  );
}

export function providersFrom(payload: unknown): ProviderHealth[] {
  return ProviderHealthListSchema.parse(payload);
}

export async function fetchProviderHealth() {
  return api.getValidated("/market/health", ProviderHealthListSchema);
}
