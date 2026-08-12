import * as React from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { CommandPalette } from "../components/navigation/CommandPalette";
import { Sidebar, destinations } from "../components/navigation/Sidebar";
import { StatusBar } from "../components/navigation/StatusBar";
import { invalidateQueries } from "../lib/query";
import { useEventStream } from "../lib/useEventStream";

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

export function AppShell() {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const stream = useEventStream((event) => {
    if (["session", "fill", "equity", "risk", "alert"].includes(event.type)) {
      invalidateQueries("sessions");
      invalidateQueries("portfolio");
      invalidateQueries("overview");
    }
  });

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !isTypingTarget(event.target)) {
        const index = Number(event.key) - 1;
        if (index >= 0 && index < destinations.length) navigate(destinations[index].path);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return (
    <div className="app-shell">
      <StatusBar streamStatus={stream.status} />
      <Sidebar />
      <main className="route-content" id="main-content">
        <Outlet />
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
