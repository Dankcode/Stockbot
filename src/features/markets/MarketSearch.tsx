import { Search, X } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../../components/states/DataStates";
import type { MarketAsset } from "../../lib/types";

export function MarketSearch({
  query,
  selectedSymbol,
  results,
  loading,
  error,
  onQueryChange,
  onSelect,
  onRetry
}: {
  query: string;
  selectedSymbol: string;
  results?: MarketAsset[];
  loading: boolean;
  error?: Error;
  onQueryChange: (value: string) => void;
  onSelect: (asset: MarketAsset) => void;
  onRetry: () => void;
}) {
  const hasQuery = query.trim().length > 0;
  return (
    <section className="panel market-search-panel" aria-label="Symbol search">
      <form className="market-search-form" role="search" onSubmit={(event) => event.preventDefault()}>
        <Search size={17} aria-hidden="true" />
        <input
          aria-controls="market-search-results"
          aria-label="Search market symbols"
          autoComplete="off"
          placeholder="Search symbol, company or sector"
          spellCheck={false}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query ? <button className="icon-button" type="button" aria-label="Clear symbol search" onClick={() => onQueryChange("")}><X size={15} /></button> : null}
      </form>
      <div className="market-search-results" id="market-search-results" role="listbox" aria-label="Market search results">
        {!hasQuery ? <EmptyState compact title="Search for a market symbol" detail="Quotes and bars load only after you choose an API result." /> : null}
        {hasQuery && loading ? <LoadingState compact title="Searching symbols" /> : null}
        {hasQuery && error ? <ErrorState compact title="Search unavailable" detail={error.message} onRetry={onRetry} /> : null}
        {hasQuery && !loading && !error && results?.length === 0 ? <EmptyState compact title="No matching symbols" detail="The market catalog returned no results." /> : null}
        {hasQuery && !loading && !error && results?.map((asset) => (
          <button
            className={asset.symbol === selectedSymbol ? "selected" : ""}
            key={asset.symbol}
            role="option"
            aria-selected={asset.symbol === selectedSymbol}
            type="button"
            onClick={() => onSelect(asset)}
          >
            <strong>{asset.symbol}</strong>
            <span>{asset.name}</span>
            <small>{asset.sector ?? asset.matchReason ?? "Metadata unavailable"}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
