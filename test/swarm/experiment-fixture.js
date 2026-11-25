import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createLedger } from "../../server/broker/ledger.js";
import { createPaperBroker } from "../../server/broker/paper-broker.js";
import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";
import { createExperimentService } from "../../server/swarm/experiments.js";
import { createIntentService } from "../../server/swarm/intents.js";
import { createSwarmJobs } from "../../server/swarm/jobs.js";
import { createReviewService } from "../../server/swarm/review.js";
import { createSwarmService } from "../../server/swarm/service.js";

const FILL_MODEL = { slippageBps: 0, fixedCommission: 0, perShareCommission: 0, quantityPrecision: 6 };

/** Real repositories, ledger, broker and swarm services on scratch SQLite with a settable clock and prices. */
export async function experimentHarness(t, { now }) {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-experiment-"));
  const client = await createClient(pathToFileURL(join(directory, "stockbot.db")).href);
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await migrate(client);
  const repositories = createRepositories(client);
  const state = { now, prices: { SPY: 500, QQQ: 400 }, bars: {} };
  const clock = () => state.now;
  let idCounter = 0;
  const idFactory = () => `id-${String(++idCounter).padStart(5, "0")}`;
  const market = {
    async getQuote(symbol) { return { symbol, price: state.prices[symbol] ?? 50, status: "real", source: "alpaca", at: state.now }; },
    async getBars(symbol) { return { symbol, source: "alpaca", bars: state.bars[symbol] ?? [] }; }
  };
  const ledger = createLedger({ client, repositories, clock });
  await ledger.ensureDefaultAccount({ createdAt: now });
  const broker = createPaperBroker({ ledger, market, fillModel: FILL_MODEL, quoteFreshnessMs: 5_000, clock });
  const swarm = createSwarmService({ client, repositories, market, broker, ledger, clock });
  const intents = createIntentService({ client, repositories, market, broker, ledger, swarm, clock });
  const experiments = createExperimentService({ repositories, swarm, broker, ledger, market, clock, idFactory });
  const review = createReviewService({ repositories, experiments, swarm, clock, idFactory });
  const discoveryCalls = [];
  const discovery = { async startRun(params) { discoveryCalls.push({ at: state.now, params }); return { id: `run-${discoveryCalls.length}` }; } };
  const jobs = createSwarmJobs({ repositories, experiments, review, discovery, clock, logger: { error() {} } });
  return { client, repositories, state, ledger, broker, swarm, intents, experiments, review, jobs, discoveryCalls, idFactory };
}
