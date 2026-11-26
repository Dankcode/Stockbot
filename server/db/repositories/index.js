import { createAccountsRepository } from "./accounts.js";
import { createAlertsRepository } from "./alerts.js";
import { createAlgorithmsRepository } from "./algorithms.js";
import { createAuditRepository } from "./audit.js";
import { createDiscoveryRepository } from "./discovery.js";
import { createExperimentsRepository } from "./experiments.js";
import { createOrdersRepository } from "./orders.js";
import { createRiskRepository } from "./risk.js";
import { createResearchRepository } from "./research.js";
import { createSessionsRepository } from "./sessions.js";
import { createSettingsRepository } from "./settings.js";
import { createStrategyPicksRepository } from "./strategy-picks.js";
import { createSwarmRepository } from "./swarm.js";
import { createSwarmExperimentsRepository } from "./swarm-experiments.js";

export {
  createAccountsRepository,
  createAlertsRepository,
  createAlgorithmsRepository,
  createAuditRepository,
  createDiscoveryRepository,
  createExperimentsRepository,
  createOrdersRepository,
  createResearchRepository,
  createRiskRepository,
  createSessionsRepository,
  createSettingsRepository,
  createStrategyPicksRepository,
  createSwarmExperimentsRepository,
  createSwarmRepository
};

export function createRepositories(client) {
  return Object.freeze({
    accounts: createAccountsRepository(client),
    alerts: createAlertsRepository(client),
    algorithms: createAlgorithmsRepository(client),
    audit: createAuditRepository(client),
    discovery: createDiscoveryRepository(client),
    experiments: createExperimentsRepository(client),
    orders: createOrdersRepository(client),
    research: createResearchRepository(client),
    risk: createRiskRepository(client),
    sessions: createSessionsRepository(client),
    settings: createSettingsRepository(client),
    strategyPicks: createStrategyPicksRepository(client),
    swarm: createSwarmRepository(client),
    swarmExperiments: createSwarmExperimentsRepository(client)
  });
}
