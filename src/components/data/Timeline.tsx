import { AlertTriangle, CirclePlay, ShieldAlert } from "lucide-react";
import type { ActivityItem } from "../../lib/types";

function timeLabel(at: number) {
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(at);
}

export function Timeline({ items }: { items: ActivityItem[] }) {
  return (
    <ol className="timeline" aria-label="Activity">
      {items.map((item) => {
        const Icon = item.severity === "halt" || item.severity === "block" ? ShieldAlert : item.severity === "warn" ? AlertTriangle : CirclePlay;
        return (
          <li key={item.id} className={`timeline-item severity-${item.severity ?? "info"}`}>
            <time dateTime={new Date(item.at).toISOString()}>{timeLabel(item.at)}</time>
            <span className="timeline-marker"><Icon size={15} /></span>
            <div className="timeline-content">
              <strong>{item.title ?? item.type}</strong>
              {item.detail ? <span>{item.detail}</span> : null}
              {item.signalReason ? <small>{item.signalReason}</small> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
