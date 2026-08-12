import * as React from "react";
import { Play, RefreshCw } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CHART_RANGES, getRangeConfig, isRangeKey } from "../../../packages/shared/ranges.js";
import { MarketChart } from "../../charts";
import { EmptyState, ErrorState, LoadingState, StaleBadge } from "../../components/states/DataStates";
import { fetchMarketBars, fetchMarketQuote, fetchMarketSearch, fetchProviderHealth } from "../../lib/market";
import { invalidateQueries, useQuery } from "../../lib/query";
import type { MarketAsset } from "../../lib/types";
import { CreateSessionDialog } from "../sessions/CreateSessionDialog";
import { MarketInspector } from "./MarketInspector";
import { MarketSearch } from "./MarketSearch";

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9./-]{0,31}$/;
const QUOTE_STALE_MS = 15_000;

function selectedFrom(value: string | null) {
  const symbol = value?.trim().toUpperCase() ?? "";
  return SYMBOL_PATTERN.test(symbol) ? symbol : "";
}

export function MarketsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedSymbol = selectedFrom(searchParams.get("symbol"));
  const range = isRangeKey(searchParams.get("range")) ? searchParams.get("range")! : "1D";
  const [query, setQuery] = React.useState(selectedSymbol);
  const [createOpen, setCreateOpen] = React.useState(false);
  const deferredQuery = React.useDeferredValue(query.trim());
  const search = useQuery(`market:search:${deferredQuery}`, () => fetchMarketSearch(deferredQuery), { enabled: deferredQuery.length > 0, staleAfterMs: 30_000 });
  const quote = useQuery(`market:quote:${selectedSymbol}`, () => fetchMarketQuote(selectedSymbol), { enabled: Boolean(selectedSymbol), refreshMs: 10_000, staleAfterMs: 15_000 });
  const bars = useQuery(`market:bars:${selectedSymbol}:${range}`, () => fetchMarketBars(selectedSymbol, range), { enabled: Boolean(selectedSymbol), refreshMs: range === "1H" || range === "1D" ? 30_000 : 0, staleAfterMs: 60_000 });
  const providers = useQuery("market:health", fetchProviderHealth, { refreshMs: 30_000, staleAfterMs: 45_000 });

  React.useEffect(() => setQuery(selectedSymbol), [selectedSymbol]);
  React.useEffect(() => {
    if (bars.data) {
      void providers.refetch();
      invalidateQueries("overview");
    }
  }, [bars.data, providers.refetch]);

  const selectSymbol = (asset: MarketAsset) => {
    setQuery(asset.symbol);
    setSearchParams({ symbol: asset.symbol, range });
  };
  const selectRange = (next: string) => {
    if (!isRangeKey(next)) return;
    setSearchParams(selectedSymbol ? { symbol: selectedSymbol, range: next } : { range: next });
  };
  const interval = bars.data?.interval ?? getRangeConfig(range).interval;
  const selectedProvider = bars.data?.source;
  const providerStatus = providers.data?.find((provider) => provider.id === selectedProvider);
  const quoteObservedAt = quote.data && quote.data.status !== "unavailable" ? quote.data.at : 0;
  const quoteAgeStale = quoteObservedAt > 0 && Date.now() - quoteObservedAt > QUOTE_STALE_MS;
  const quoteStale = quote.isStale || Boolean(quoteAgeStale);
  const staleAt = quoteAgeStale ? quoteObservedAt : Math.min(...[bars.updatedAt, quote.updatedAt].filter(Boolean));

  return (
    <div className="markets-page page-stack">
      <header className="page-heading">
        <div><h1>Markets</h1>{bars.isStale || quoteStale ? <StaleBadge updatedAt={staleAt} /> : null}</div>
        <div className="page-actions"><button className="button secondary" type="button" onClick={() => void Promise.all([quote.refetch(), bars.refetch(), providers.refetch()])}><RefreshCw size={14} /> Refresh</button><button className="button primary" disabled={!selectedSymbol} type="button" onClick={() => setCreateOpen(true)}><Play size={14} /> Run this strategy</button></div>
      </header>
      <MarketSearch query={query} selectedSymbol={selectedSymbol} results={search.data} loading={search.isLoading && deferredQuery.length > 0} error={search.error} onQueryChange={setQuery} onSelect={selectSymbol} onRetry={search.refetch} />
      <div className="market-workspace">
        <section className="panel market-chart-panel">
          <header className="market-chart-header">
            <div><h2>{selectedSymbol || "No symbol selected"}</h2><span>{selectedProvider ? `${selectedProvider} · ${interval}` : "Choose an API search result to open a chart."}</span></div>
            <div className="range-controls" aria-label="Chart range">{CHART_RANGES.map((item) => <button className={range === item.key ? "active" : ""} aria-pressed={range === item.key} disabled={!selectedSymbol} key={item.key} type="button" onClick={() => selectRange(item.key)}>{item.label}</button>)}</div>
          </header>
          {selectedProvider && providerStatus && providerStatus.status !== "healthy" ? <div className="market-provenance-warning" role="status">Provider {selectedProvider}: {providerStatus.message ?? providerStatus.status}</div> : null}
          {!selectedSymbol ? <EmptyState title="Select a symbol" detail="Search results come from the market catalog; no quote or candle defaults are substituted." /> : null}
          {selectedSymbol && bars.isLoading ? <LoadingState title="Loading real market bars" /> : null}
          {selectedSymbol && bars.error && !bars.data ? <ErrorState title="Bars unavailable" detail={bars.error.message} onRetry={bars.refetch} /> : null}
          {bars.data?.bars.length ? <MarketChart bars={bars.data.bars} range={bars.data.range} interval={bars.data.interval} height={470} movingAverage={9} showVwap ariaLabel={`${selectedSymbol} ${range} market chart`} /> : bars.data ? <EmptyState title="No bars returned" detail="The selected provider returned no real candles for this range." /> : null}
        </section>
        <MarketInspector
          quote={quote.data}
          quoteLoading={Boolean(selectedSymbol) && quote.isLoading}
          quoteError={quote.error}
          quoteStale={quoteStale}
          quoteUpdatedAt={quoteAgeStale ? quoteObservedAt : quote.updatedAt}
          marketBars={bars.data}
          providers={providers.data}
          providersLoading={providers.isLoading}
          providersError={providers.error}
          onRetryQuote={quote.refetch}
          onRetryProviders={providers.refetch}
        />
      </div>
      <CreateSessionDialog open={createOpen} initialSymbol={selectedSymbol} initialRange={range} onClose={() => setCreateOpen(false)} onCreated={(session) => { setCreateOpen(false); invalidateQueries("sessions"); navigate(`/sessions/${session.id}`); }} />
    </div>
  );
}
