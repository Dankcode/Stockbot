import crypto from "node:crypto";
import { createAlertEvaluator } from "./alerts/evaluator.js";
import { createInAppChannel } from "./alerts/channels/in-app.js";
import { createAlgorithmService } from "./algorithms/service.js";
import { createLedger, DEFAULT_ACCOUNT_ID } from "./broker/ledger.js";
import { createPaperBroker } from "./broker/paper-broker.js";
import { loadConfig } from "./config/index.js";
import { createClient } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { createRepositories } from "./db/repositories/index.js";
import { createEnginePool } from "./engine/pool.js";
import { createHttpApp } from "./http/app.js";
import { EventHub } from "./http/event-hub.js";
import { createMarketService } from "./market/chain.js";
import { createRiskEngine } from "./risk/engine.js";
import { DEFAULT_RISK_PROFILE } from "./risk/profile.js";
import { SessionScheduler } from "./runtime/scheduler.js";
import { createSupervisor } from "./runtime/supervisor.js";
import { createDatabaseSettingsService } from "./settings/database-service.js";
import { createSettingsService } from "./settings/service.js";

const STANDARD_FILL_MODEL = Object.freeze({
  slippageBps: 5,
  fixedCommission: 0,
  perShareCommission: 0,
  quantityPrecision: 6
});

function databaseHealth(client) {
  return {
    async health() {
      try {
        await client.query("SELECT 1 AS ok");
        return { ok: true, dialect: client.dialect };
      } catch (error) {
        return { ok: false, dialect: client.dialect, message: error.message };
      }
    }
  };
}

export async function createStockbot(options = {}) {
  const config = options.config ?? loadConfig();
  const client = options.client ?? await createClient(config.databaseUrl);
  await migrate(client);
  const repositories = createRepositories(client);
  const eventHub = options.eventHub ?? new EventHub();

  let market;
  const settings = createSettingsService(repositories.settings, config, () => market?.clearCaches());
  await settings.applyToRuntime();
  market = options.market ?? createMarketService(config);

  const enginePool = options.enginePool ?? createEnginePool({
    size: config.engineWorkers,
    timeoutMs: config.engineTimeoutMs
  });
  const algorithms = createAlgorithmService({
    config,
    enginePool,
    repository: repositories.algorithms,
    market
  });
  await algorithms.refresh(true);

  const ledger = createLedger({ client, repositories });
  const alertEvaluator = createAlertEvaluator(repositories.alerts, createInAppChannel(eventHub));
  const recordRiskEvent = async ({ failure, order, accountId, sessionId }) => {
    const event = await repositories.risk.addEvent({
      id: crypto.randomUUID(),
      sessionId: sessionId ?? null,
      accountId,
      at: Date.now(),
      ruleId: failure.ruleId,
      severity: failure.severity,
      actionTaken: "order_rejected",
      detail: failure,
      orderId: order?.id ?? null
    });
    eventHub.publish("risk.event", { event });
    await alertEvaluator({
      type: "risk_event",
      severity: event.severity,
      ruleId: event.ruleId,
      detail: event.detailJson,
      sessionId
    }, sessionId);
    return event;
  };
  const broker = createPaperBroker({
    ledger,
    market,
    riskEngine: createRiskEngine(DEFAULT_RISK_PROFILE),
    fillModel: STANDARD_FILL_MODEL,
    quoteFreshnessMs: config.quoteFreshnessMs,
    eventHub,
    riskEventRecorder: recordRiskEvent
  });
  const supervisor = createSupervisor({
    client,
    repositories,
    market,
    enginePool,
    ledger,
    broker,
    scheduler: options.scheduler ?? new SessionScheduler({ settleDelayMs: config.settleDelayMs }),
    eventHub,
    alertEvaluator,
    restartRunningSessions: config.restartRunningSessions,
    settleDelayMs: config.settleDelayMs,
    metricsVersion: algorithms.metricsVersion
  });
  const startup = await supervisor.bootstrap();
  const accountId = startup.account?.id ?? DEFAULT_ACCOUNT_ID;
  const database = databaseHealth(client);
  const databaseSettings = options.databaseSettings ?? createDatabaseSettingsService({ config, repositories });
  const context = {
    config,
    client,
    database,
    databaseSettings,
    repositories,
    eventHub,
    market,
    settings,
    enginePool,
    algorithms,
    ledger,
    broker,
    supervisor,
    accountId,
    startup
  };
  const app = createHttpApp(context);
  return {
    ...context,
    app,
    async close() {
      await supervisor.close();
      await enginePool.close();
      await client.close();
    }
  };
}

export { STANDARD_FILL_MODEL };
