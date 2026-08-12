import { Bot, ChartNoAxesCombined, CircleGauge, Settings, TimerReset } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { api, listFrom } from "../../lib/api";
import { useQuery } from "../../lib/query";
import type { Algorithm, SessionSummary } from "../../lib/types";

type Command = { id: string; label: string; detail: string; path: string; icon: React.ComponentType<{ size?: number }> };

const routeCommands: Command[] = [
  { id: "overview", label: "Overview", detail: "Current account and bot state", path: "/", icon: CircleGauge },
  { id: "markets", label: "Markets", detail: "Quotes and charts", path: "/markets", icon: ChartNoAxesCombined },
  { id: "strategies", label: "Strategies", detail: "Algorithm library", path: "/strategies", icon: Bot },
  { id: "sessions", label: "Sessions", detail: "History and comparisons", path: "/sessions", icon: TimerReset },
  { id: "settings", label: "Settings", detail: "Account, data, risk and alerts", path: "/settings", icon: Settings }
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const sessions = useQuery("palette:sessions", async () => listFrom<SessionSummary>(await api.get<unknown>("/sessions?limit=20"), ["sessions", "items"]), { enabled: open, staleAfterMs: 30_000 });
  const algorithms = useQuery("palette:algorithms", async () => listFrom<Algorithm>(await api.get<unknown>("/algorithms"), ["algorithms", "items"]), { enabled: open, staleAfterMs: 60_000 });
  const symbols = useQuery(`palette:symbols:${query}`, async () => listFrom<{ symbol: string; name?: string }>(await api.get<unknown>(`/market/search?q=${encodeURIComponent(query)}`), ["results", "items"]), {
    enabled: open && query.trim().length >= 2,
    staleAfterMs: 15_000
  });

  const commands = React.useMemo(() => {
    const dynamic: Command[] = [
      ...(sessions.data ?? []).map((session) => ({ id: `session:${session.id}`, label: session.name, detail: `Session · ${session.status}`, path: `/sessions/${session.id}`, icon: TimerReset })),
      ...(algorithms.data ?? []).map((algorithm) => ({ id: `algorithm:${algorithm.id}`, label: algorithm.name, detail: "Strategy", path: `/strategies/${algorithm.id}`, icon: Bot })),
      ...(symbols.data ?? []).map((symbol) => ({ id: `symbol:${symbol.symbol}`, label: symbol.symbol, detail: symbol.name ?? "Market symbol", path: `/markets?symbol=${encodeURIComponent(symbol.symbol)}`, icon: ChartNoAxesCombined }))
    ];
    const needle = query.trim().toLowerCase();
    return [...routeCommands, ...dynamic].filter((command) => !needle || `${command.label} ${command.detail}`.toLowerCase().includes(needle)).slice(0, 12);
  }, [algorithms.data, query, sessions.data, symbols.data]);

  React.useEffect(() => setActiveIndex(0), [query]);
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  if (!open) return null;

  const choose = (command: Command) => {
    navigate(command.path);
    onClose();
  };
  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "ArrowDown") setActiveIndex((index) => Math.min(commands.length - 1, index + 1));
            if (event.key === "ArrowUp") setActiveIndex((index) => Math.max(0, index - 1));
            if (event.key === "Enter" && commands[activeIndex]) choose(commands[activeIndex]);
          }}
          placeholder="Jump to a destination, session, strategy or symbol"
          aria-label="Search Stockbot"
        />
        <div className="command-list" role="listbox">
          {commands.map((command, index) => {
            const Icon = command.icon;
            return (
              <button key={command.id} className={index === activeIndex ? "active" : ""} type="button" role="option" aria-selected={index === activeIndex} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(command)}>
                <Icon size={17} />
                <span><strong>{command.label}</strong><small>{command.detail}</small></span>
                <kbd>↵</kbd>
              </button>
            );
          })}
          {commands.length === 0 ? <div className="palette-empty">No matching command or real API result.</div> : null}
        </div>
        <footer><span>↑↓ Navigate</span><span>Enter Open</span><span>Esc Close</span></footer>
      </div>
    </div>
  );
}
