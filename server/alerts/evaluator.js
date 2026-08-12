import crypto from "node:crypto";

function compare(value, operator, threshold) {
  if (operator === "gt") return value > threshold;
  if (operator === "gte") return value >= threshold;
  if (operator === "lt") return value < threshold;
  if (operator === "lte") return value <= threshold;
  if (operator === "eq") return value === threshold;
  return false;
}

export function alertMatches(alert, event) {
  const condition = alert.condition ?? alert.conditionJson ?? {};
  if (alert.triggerType === "risk_event") {
    const ranks = { info: 0, warn: 1, block: 2, halt: 3 };
    return event.type === "risk_event" && (ranks[event.severity] ?? -1) >= (ranks[condition.minimumSeverity || "warn"] ?? 1);
  }
  if (alert.triggerType === "session_state") return event.type === "session_state" && (condition.statuses || []).includes(event.status);
  if (alert.triggerType === "signal") return event.type === "signal" && (!condition.symbol || condition.symbol === event.symbol) && (!condition.action || condition.action === event.action);
  if (alert.triggerType === "metric_threshold") return event.type === "metric" && event.key === condition.metric && compare(event.value, condition.operator, condition.value);
  if (alert.triggerType === "schedule") return event.type === "schedule" && event.scheduleId === alert.id;
  return false;
}

export function createAlertEvaluator(repository, channel, clock = () => Date.now()) {
  return async function evaluate(event, sessionId = null) {
    const alerts = repository.listEnabled ? await repository.listEnabled() : await repository.list({ enabledOnly: true });
    const deliveries = [];
    for (const alert of alerts) {
      if (!alertMatches(alert, event)) continue;
      const at = clock();
      const suppressed = repository.claimFiring
        ? !(await repository.claimFiring(alert.id, at, alert.cooldownMs))
        : alert.lastFiredAt != null && at - alert.lastFiredAt < alert.cooldownMs;
      const deliveryInput = {
        id: crypto.randomUUID(),
        alertId: alert.id,
        sessionId,
        at,
        status: suppressed ? "suppressed" : "sent",
        payload: event,
        errorDetail: null
      };
      const delivery = repository.createDelivery ? await repository.createDelivery(deliveryInput) : await repository.addDelivery(deliveryInput);
      if (!suppressed) {
        try {
          await channel.send({ alert, delivery, event });
          if (!repository.claimFiring) {
            if (repository.markFired) await repository.markFired(alert.id, at);
            else await repository.update(alert.id, { lastFiredAt: at });
          }
        } catch (error) {
          if (repository.restoreFiring) await repository.restoreFiring(alert.id, at, alert.lastFiredAt ?? null);
          if (repository.markDeliveryFailed) await repository.markDeliveryFailed(delivery.id, error instanceof Error ? error.message : String(error));
          delivery.status = "failed";
        }
      }
      deliveries.push(delivery);
    }
    return deliveries;
  };
}
