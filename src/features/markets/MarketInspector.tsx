import { Activity, Database, Gauge, Radio } from "lucide-react";
import { formatPercent, formatVolume } from "../../../packages/shared/format.js";
import type { Quote, UnavailableQuote } from "../../../packages/shared/schemas.js";
import { EmptyState, ErrorState, LoadingState, StaleBadge } from "../../components/states/DataStates";
import type { MarketBars, ProviderHealth } from "../../lib/types";

function marketPrice(value: number | null | undefined) {
  return value == null || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function timestamp(value: number | null | undefined) {
  return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium" }).format(value) : "—";
}

function QuotePanel({ quote, loading, error, stale, updatedAt, onRetry }: {
  quote?: Quote | UnavailableQuote;
  loading: boolean;
  error?: Error;
  stale: boolean;
  updatedAt: number;
  onRetry: () => void;
}) {
  return (
    <section className="panel market-inspector-section">
      <header className="panel-header"><h2><Radio size={16} /> Quote</h2>{stale ? <StaleBadge updatedAt={updatedAt} /> : null}</header>
      {loading ? <LoadingState compact title="Loading quote" /> : null}
      {error ? <ErrorState compact title="Quote unavailable" detail={error.message} onRetry={onRetry} /> : null}
      {quote?.status === "unavailable" ? <ErrorState compact title="Quote unavailable" detail={quote.error} onRetry={onRetry} /> : null}
      {quote && quote.status !== "unavailable" ? (
        <dl className="market-definition-list">
          <div className="quote-primary"><dt>Last</dt><dd>{marketPrice(quote.price)}</dd></div>
          <div><dt>Change</dt><dd className={quote.change >= 0 ? "positive" : "negative"}>{marketPrice(quote.change)} · {formatPercent(quote.changePercent, { signed: true })}</dd></div>
          <div><dt>Previous close</dt><dd>{marketPrice(quote.previousClose)}</dd></div>
          <div><dt>Volume</dt><dd>{formatVolume(quote.volume)}</dd></div>
          <div><dt>Observed</dt><dd>{timestamp(quote.at)}</dd></div>
          <div><dt>Provider</dt><dd>{quote.source}</dd></div>
        </dl>
      ) : null}
      {!loading && !error && !quote ? <EmptyState compact title="No symbol selected" /> : null}
    </section>
  );
}

function DiagnosticsPanel({ marketBars }: { marketBars?: MarketBars }) {
  const rows = marketBars ? [
    ["RSI (14)", marketBars.diagnostics.rsi == null ? "—" : marketBars.diagnostics.rsi.toFixed(2)],
    ["EMA (9)", marketPrice(marketBars.diagnostics.emaFast)],
    ["EMA (21)", marketPrice(marketBars.diagnostics.emaSlow)],
    ["ATR (14)", marketPrice(marketBars.diagnostics.atr)],
    ["VWAP", marketPrice(marketBars.diagnostics.vwap)]
  ] : [];
  return (
    <section className="panel market-inspector-section">
      <header className="panel-header"><h2><Gauge size={16} /> Diagnostics</h2></header>
      {rows.length ? <dl className="market-definition-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <EmptyState compact title="Diagnostics unavailable" detail="Select a symbol with real bars." />}
    </section>
  );
}

function HealthPanel({ providers, loading, error, onRetry }: { providers?: ProviderHealth[]; loading: boolean; error?: Error; onRetry: () => void }) {
  return (
    <section className="panel market-inspector-section">
      <header className="panel-header"><h2><Database size={16} /> Providers</h2></header>
      {loading ? <LoadingState compact title="Loading provider health" /> : null}
      {error ? <ErrorState compact title="Provider health unavailable" detail={error.message} onRetry={onRetry} /> : null}
      {providers?.length ? <ul className="market-provider-list">{providers.map((provider) => <li key={provider.id}><span className={`health-dot health-${provider.status}`} /><div><strong>{provider.name ?? provider.id}</strong><small>{provider.message ?? provider.status}</small></div><span>{provider.latencyMs == null ? "—" : `${provider.latencyMs} ms`}</span></li>)}</ul> : !loading && !error ? <EmptyState compact title="No providers reported" /> : null}
    </section>
  );
}

export function MarketInspector({ quote, quoteLoading, quoteError, quoteStale, quoteUpdatedAt, marketBars, providers, providersLoading, providersError, onRetryQuote, onRetryProviders }: {
  quote?: Quote | UnavailableQuote;
  quoteLoading: boolean;
  quoteError?: Error;
  quoteStale: boolean;
  quoteUpdatedAt: number;
  marketBars?: MarketBars;
  providers?: ProviderHealth[];
  providersLoading: boolean;
  providersError?: Error;
  onRetryQuote: () => void;
  onRetryProviders: () => void;
}) {
  return <aside className="market-inspector" aria-label="Market inspector"><QuotePanel quote={quote} loading={quoteLoading} error={quoteError} stale={quoteStale || quote?.status === "stale"} updatedAt={quoteUpdatedAt} onRetry={onRetryQuote} /><DiagnosticsPanel marketBars={marketBars} /><HealthPanel providers={providers} loading={providersLoading} error={providersError} onRetry={onRetryProviders} /></aside>;
}
