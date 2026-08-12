import * as React from "react";
import { apiUrl } from "./api";

export type StreamStatus = "connecting" | "open" | "error" | "closed" | "unsupported";

export type StreamEvent = {
  type: string;
  data: unknown;
  lastEventId?: string;
};

export function useEventStream(onEvent?: (event: StreamEvent) => void) {
  const handlerRef = React.useRef(onEvent);
  handlerRef.current = onEvent;
  const [status, setStatus] = React.useState<StreamStatus>("connecting");
  const [lastEventAt, setLastEventAt] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!("EventSource" in window)) {
      setStatus("unsupported");
      return;
    }
    const source = new EventSource(apiUrl("/stream"));
    const receive = (type: string, message: MessageEvent<string>) => {
      let data: unknown = message.data;
      try {
        data = JSON.parse(message.data);
      } catch {
        // Text frames are valid; leave them as-is.
      }
      setLastEventAt(Date.now());
      handlerRef.current?.({ type, data, lastEventId: message.lastEventId || undefined });
    };
    source.onopen = () => setStatus("open");
    source.onerror = () => setStatus("error");
    source.onmessage = (event) => receive("message", event);
    const eventTypes = ["session", "fill", "equity", "risk", "alert"];
    const listeners = eventTypes.map((type) => {
      const listener = (event: Event) => receive(type, event as MessageEvent<string>);
      source.addEventListener(type, listener);
      return [type, listener] as const;
    });
    return () => {
      listeners.forEach(([type, listener]) => source.removeEventListener(type, listener));
      source.close();
      setStatus("closed");
    };
  }, []);

  return { status, lastEventAt };
}
