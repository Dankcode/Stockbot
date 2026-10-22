import crypto from "node:crypto";

export const SUPERVISOR_LEASE = "swarm-supervisor";
const LEASE_TTL_MS = 3 * 60 * 1_000;
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function zonedParts(at, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23"
  }).formatToParts(at);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

/** UTC instant of a wall-clock time in a zone (DST-correct for whole-minute zones). */
export function zonedInstant({ year, month, day, hour, minute }, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    guess -= asUtc - Date.UTC(year, month - 1, day, hour, minute);
  }
  return guess;
}

/** A wall time that does not exist (spring-forward gap) runs at the first valid minute after it, never early. */
function dailyDueAt(parts, hour, minute, timeZone) {
  const wall = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour, minute };
  let dueAt = zonedInstant(wall, timeZone);
  const landed = zonedParts(dueAt, timeZone);
  if (Number(landed.hour) * 60 + Number(landed.minute) < hour * 60 + minute && landed.day === parts.day) dueAt += 60 * 60_000;
  return dueAt;
}

/**
 * Daily slots whose whole window passed in the last `lookbackDays` days, so a
 * supervisor that was down records them as expired instead of leaving no trace.
 */
export function missedDailySlots(plan, now, lookbackDays = 3) {
  const missed = [];
  plan.cadence.forEach((entry, index) => {
    const { schedule } = entry;
    if (schedule.type !== "daily") return;
    const windowMs = entry.expiresAfterMinutes * 60_000;
    for (let back = 0; back <= lookbackDays; back += 1) {
      const parts = zonedParts(now - back * 86_400_000, schedule.timezone);
      if (!schedule.weekdays.includes(WEEKDAY[parts.weekday])) continue;
      const [hour, minute] = schedule.at.split(":").map(Number);
      const dueAt = dailyDueAt(parts, hour, minute, schedule.timezone);
      if (dueAt + windowMs <= now) {
        missed.push({ kind: entry.task, slot: `daily:${index}:${parts.year}-${parts.month}-${parts.day}`, dueAt, expiresAt: dueAt + windowMs });
      }
    }
  });
  return missed;
}

/**
 * The cadence slots that are open at `now`. Only the current window is ever
 * returned, so a supervisor that was down does not backfill a burst of stale
 * research cycles when it comes back.
 */
export function openSlots(plan, now) {
  const slots = [];
  plan.cadence.forEach((entry, index) => {
    const windowMs = entry.expiresAfterMinutes * 60_000;
    const { schedule } = entry;
    if (schedule.type === "interval") {
      const periodMs = schedule.minutes * 60_000;
      const start = Math.floor(now / periodMs) * periodMs;
      const end = start + Math.min(windowMs, periodMs);
      if (now < end) slots.push({ kind: entry.task, slot: `interval:${index}:${start}`, dueAt: start, expiresAt: end });
      return;
    }
    // Today's slot, and yesterday's in case its window runs past midnight.
    for (const back of [0, 1]) {
      const parts = zonedParts(now - back * 86_400_000, schedule.timezone);
      if (!schedule.weekdays.includes(WEEKDAY[parts.weekday])) continue;
      const [hour, minute] = schedule.at.split(":").map(Number);
      const dueAt = dailyDueAt(parts, hour, minute, schedule.timezone);
      if (now >= dueAt && now < dueAt + windowMs) {
        slots.push({ kind: entry.task, slot: `daily:${index}:${parts.year}-${parts.month}-${parts.day}`, dueAt, expiresAt: dueAt + windowMs });
      }
    }
  });
  return slots;
}

export function createSwarmScheduler({
  repositories,
  intents,
  clock = () => Date.now(),
  idFactory = () => crypto.randomUUID(),
  holder = `supervisor:${crypto.randomUUID()}`,
  intervalMs = 60_000,
  logger = console
}) {
  const repo = repositories.swarm;
  let timer = null;
  let running = null;

  async function tick() {
    const at = clock();
    const leader = await repo.acquireLease({ name: SUPERVISOR_LEASE, holder, at, ttlMs: LEASE_TTL_MS });
    if (!leader) return { leader: false, created: 0, expired: 0, reconciled: 0 };
    const expired = await repo.expireTasks(at);
    let created = 0;
    for (const agent of await repo.listAgents()) {
      if (agent.status !== "active") continue;
      const plan = await repo.getActivePlan(agent.id);
      if (!plan) continue;
      for (const slot of openSlots(plan.planJson, at)) {
        const inserted = await repo.insertTask({
          id: idFactory(), agentId: agent.id, planId: plan.id, ...slot, createdBy: "scheduler", createdAt: at
        });
        if (inserted) created += 1;
      }
      // Only slots the active plan was live for; a slot that already has a row is untouched.
      for (const slot of missedDailySlots(plan.planJson, at).filter((entry) => entry.dueAt >= plan.activatedAt)) {
        await repo.insertTask({
          id: idFactory(), agentId: agent.id, planId: plan.id, ...slot, status: "expired", errorCode: "supervisor_unavailable",
          errorDetail: "No supervisor was running during this slot's window.", createdBy: "scheduler", createdAt: at
        });
      }
    }
    const reconciled = intents ? (await intents.reconcileStranded()).length : 0;
    return { leader: true, created, expired, reconciled };
  }

  /** Operator-triggered pass. A process that is not the running supervisor gives the lease straight back. */
  async function tickOnce() {
    const outcome = await tick();
    if (!timer && outcome.leader) await repo.releaseLease({ name: SUPERVISOR_LEASE, holder });
    return outcome;
  }

  function start() {
    if (timer) return;
    const run = () => {
      if (running) return;
      running = tick().catch((error) => logger.error?.("Swarm scheduler tick failed:", error)).finally(() => { running = null; });
    };
    timer = setInterval(run, intervalMs);
    timer.unref?.();
    run();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await running;
    await repo.releaseLease({ name: SUPERVISOR_LEASE, holder });
  }

  return Object.freeze({ tick, tickOnce, start, stop, holder });
}
