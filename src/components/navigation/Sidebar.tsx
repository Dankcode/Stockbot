import { Bot, ChartNoAxesCombined, CircleGauge, Settings, SlidersHorizontal, TimerReset } from "lucide-react";
import * as React from "react";
import { NavLink } from "react-router-dom";

type Destination = { path: string; label: string; icon: typeof CircleGauge; end?: boolean };

export const destinations: Destination[] = [
  { path: "/", label: "Overview", icon: CircleGauge, end: true },
  { path: "/markets", label: "Markets", icon: ChartNoAxesCombined },
  { path: "/strategies", label: "Strategies", icon: Bot },
  { path: "/sessions", label: "Sessions", icon: TimerReset },
  { path: "/settings", label: "Settings", icon: Settings }
];

export function Sidebar() {
  const [compact, setCompact] = React.useState(false);
  return (
    <aside className={`sidebar${compact ? " compact" : ""}`} aria-label="Primary navigation">
      <nav>
        {destinations.map(({ path, label, icon: Icon, end }) => (
          <NavLink key={path} to={path} end={end} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
            <Icon size={19} strokeWidth={1.75} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <button className="sidebar-collapse" type="button" aria-pressed={compact} onClick={() => setCompact((value) => !value)}>
        <SlidersHorizontal size={17} />
        <span>{compact ? "Expand HUD" : "Compact HUD"}</span>
      </button>
    </aside>
  );
}
