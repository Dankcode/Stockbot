import assert from "node:assert/strict";
import test from "node:test";
import { EventHub } from "../../server/http/event-hub.js";

test("SSE uses stable channel names while retaining the specific event type", () => {
  const hub = new EventHub();
  hub.publish("session.state", { sessionId: "session-1" });
  hub.publish("order.filled", { orderId: "order-1" });
  const chunks = [];
  let close;
  const response = {
    writeHead(status, headers) { assert.equal(status, 200); assert.equal(headers["Content-Type"], "text/event-stream"); },
    write(chunk) { chunks.push(chunk); return true; },
    on(event, listener) { if (event === "close") close = listener; }
  };
  hub.attach(response, "0");
  const body = chunks.join("");
  assert.match(body, /event: session/);
  assert.match(body, /"type":"session\.state"/);
  assert.match(body, /event: fill/);
  close();
});
