export class EventHub {
  #clients = new Set();
  #events = [];
  #nextId = 1;
  #limit;

  constructor({ historyLimit = 500 } = {}) { this.#limit = historyLimit; }

  publish(type, data) {
    const event = { id: String(this.#nextId++), type, at: Date.now(), data };
    this.#events.push(event);
    if (this.#events.length > this.#limit) this.#events.shift();
    for (const client of this.#clients) client(event);
    return event;
  }

  since(lastId) {
    const id = Number(lastId || 0);
    return this.#events.filter((event) => Number(event.id) > id);
  }

  subscribe(listener) {
    this.#clients.add(listener);
    return () => this.#clients.delete(listener);
  }

  attach(response, lastEventId) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const streamType = (type) => {
      if (type.startsWith("session.")) return type === "session.tick" ? "equity" : "session";
      if (type === "order.filled") return "fill";
      if (type.startsWith("risk.")) return "risk";
      if (type.startsWith("alert")) return "alert";
      return type;
    };
    const send = (event) => response.write(`id: ${event.id}\nevent: ${streamType(event.type)}\ndata: ${JSON.stringify({ type: event.type, at: event.at, ...event.data })}\n\n`);
    for (const event of this.since(lastEventId)) send(event);
    const heartbeat = setInterval(() => response.write(`: heartbeat ${Date.now()}\n\n`), 15_000);
    heartbeat.unref?.();
    this.#clients.add(send);
    response.on("close", () => { clearInterval(heartbeat); this.#clients.delete(send); });
  }
}
