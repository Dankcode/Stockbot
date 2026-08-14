import { createAccountsRepository } from "./accounts.js";
import { createAlertsRepository } from "./alerts.js";
import { createAlgorithmsRepository } from "./algorithms.js";
import { createAuditRepository } from "./audit.js";
import { createOrdersRepository } from "./orders.js";
import { createRiskRepository } from "./risk.js";
import { createResearchRepository } from "./research.js";
import { createSessionsRepository } from "./sessions.js";
import { createSettingsRepository } from "./settings.js";

export {
  createAccountsRepository,
  createAlertsRepository,
  createAlgorithmsRepository,
  createAuditRepository,
  createOrdersRepository,
  createResearchRepository,
  createRiskRepository,
  createSessionsRepository,
  createSettingsRepository
};

export function createRepositories(client) {
  return Object.freeze({
    accounts: createAccountsRepository(client),
    alerts: createAlertsRepository(client),
    algorithms: createAlgorithmsRepository(client),
    audit: createAuditRepository(client),
    orders: createOrdersRepository(client),
    research: createResearchRepository(client),
    risk: createRiskRepository(client),
    sessions: createSessionsRepository(client),
    settings: createSettingsRepository(client)
  });
}
