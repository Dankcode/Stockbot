import assert from "node:assert/strict";
import test from "node:test";
import { createAlertEvaluator } from "../../server/alerts/evaluator.js";
import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";

test("concurrent alert evaluation claims one cooldown delivery", async (t) => {
  const client = await createClient("file::memory:");
  await migrate(client);
  const repositories = createRepositories(client);
  await repositories.accounts.create({ id: "paper", name: "Paper", mode: "paper", startingCash: 1_000_000 });
  await repositories.alerts.create({
    id: "risk-alert",
    accountId: "paper",
    name: "Risk warning",
    triggerType: "risk_event",
    condition: { minimumSeverity: "warn" },
    channel: "in_app",
    cooldownMs: 60_000
  });
  let sent = 0;
  let now = 1_786_200_000_000;
  const evaluate = createAlertEvaluator(repositories.alerts, { async send() { sent += 1; } }, () => now);
  t.after(() => client.close());

  await Promise.all([
    evaluate({ type: "risk_event", severity: "warn" }),
    evaluate({ type: "risk_event", severity: "warn" })
  ]);
  assert.equal(sent, 1);
  assert.deepEqual(
    (await repositories.alerts.listDeliveries({ limit: 10 })).map((delivery) => delivery.status).sort(),
    ["sent", "suppressed"]
  );

  now += 60_001;
  await evaluate({ type: "risk_event", severity: "halt" });
  assert.equal(sent, 2);
});
