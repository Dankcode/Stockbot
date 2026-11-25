/**
 * The swarm's daily jobs, run by the scheduler's leader on each tick:
 *
 *   10:00 ET  Discovery run (opt-in: swarm.discovery_schedule)
 *   session   control arms buy their missing legs once; retired arms are sold to cash
 *   16:10 ET  equity snapshot of every arm + SPY/QQQ closes
 *   16:30 ET  review (opt-in: swarm.review_enabled), once snapshots are in
 *
 * Trading days only (NYSE calendar). Each once-a-day job is claimed in
 * swarm_job_runs, so two processes or a restart never run it twice.
 */
import { PRESETS } from "../discovery/screen.js";
import { marketSession } from "../risk/market-hours.js";
import { isTradingDate, nyDate, nyMinutes } from "./calendar.js";

export const AUTOMATION_SETTINGS = Object.freeze({
  discoverySchedule: "swarm.discovery_schedule",
  review: "swarm.review_enabled",
  discoveryPreset: "swarm.discovery_preset"
});
export const DISCOVERY_AT = 10 * 60;
export const SNAPSHOT_AT = 16 * 60 + 10;
export const REVIEW_AT = 16 * 60 + 30;
const CLOSE = 16 * 60;
const SNAPSHOT_RETRY_MS = 15 * 60_000;

export function createSwarmJobs({ repositories, experiments, review, discovery, clock = () => Date.now(), logger = console }) {
  const repo = repositories.swarmExperiments;
  const lastSnapshotAttempt = new Map();

  async function automation() {
    const read = async (key) => (await repositories.settings.get(key))?.value ?? null;
    const preset = await read(AUTOMATION_SETTINGS.discoveryPreset);
    return {
      discoverySchedule: (await read(AUTOMATION_SETTINGS.discoverySchedule)) === "true",
      review: (await read(AUTOMATION_SETTINGS.review)) === "true",
      discoveryPreset: PRESETS.some((entry) => entry.id === preset) ? preset : "balanced"
    };
  }

  async function setAutomation(changes, actor = "operator") {
    const at = clock();
    for (const [field, key] of Object.entries(AUTOMATION_SETTINGS)) {
      if (changes[field] === undefined) continue;
      if (field === "discoveryPreset" && !PRESETS.some((entry) => entry.id === changes[field])) continue;
      const value = field === "discoveryPreset" ? String(changes[field]) : changes[field] ? "true" : "false";
      await repositories.settings.set({ key, value, updatedAt: at });
    }
    const current = await automation();
    await repositories.audit.append({ id: `automation-${at}`, at, actor, action: "swarm_automation_set", entity: "swarm", entityId: null, detail: current });
    return current;
  }

  /** Claims (job, slot) once; runs `work`; records completed/failed with its detail. Returns null when already claimed. */
  async function once(job, slot, work) {
    if (!(await repo.claimJob({ job, slot, at: clock() }))) return null;
    try {
      const detail = await work();
      await repo.finishJob({ job, slot, status: "completed", detail: detail ?? {}, at: clock() });
      return { job, slot, status: "completed", detail };
    } catch (error) {
      logger.error?.(`Swarm job ${job} ${slot} failed:`, error);
      await repo.finishJob({ job, slot, status: "failed", detail: { error: error.message, code: error.code ?? null }, at: clock() });
      return { job, slot, status: "failed", error: error.message };
    }
  }

  async function missingSnapshots(arms, date) {
    const missing = [];
    for (const arm of arms) {
      if (date < arm.startDate) continue;
      const snapshots = await repo.listSnapshots(arm.id);
      if (snapshots.at(-1)?.date !== date) missing.push(arm);
    }
    return missing;
  }

  async function tick(at = clock()) {
    const date = nyDate(at);
    if (!isTradingDate(date)) return null;
    const minutes = nyMinutes(at);
    const settings = await automation();
    const done = [];

    if (settings.discoverySchedule && minutes >= DISCOVERY_AT && minutes < CLOSE) {
      const outcome = await once("discovery", date, async () => {
        const preset = PRESETS.find((entry) => entry.id === settings.discoveryPreset);
        const run = await discovery.startRun(preset.params);
        return { runId: run.id, preset: preset.id };
      });
      if (outcome) done.push(outcome);
    }

    const active = await repo.listExperiments({ status: "active" });
    for (const experiment of active) {
      const arms = await repo.listArms(experiment.id);
      if (marketSession("SPY", at).open) {
        for (const arm of arms) {
          if (arm.kind === "control" && arm.status === "active") {
            const legs = await experiments.ensureControl(arm, at);
            if (legs.length) done.push({ job: "control", arm: arm.label, legs });
          }
          if (arm.status === "retired") {
            const sold = await experiments.liquidateRetired(arm, at);
            if (sold) done.push({ job: "liquidate", arm: arm.label, closed: sold.closed.length, failed: sold.failed.length });
          }
        }
      }
      if (minutes >= SNAPSHOT_AT) {
        const missing = await missingSnapshots(arms, date);
        const key = `${experiment.id}:${date}`;
        if (missing.length && !(at - (lastSnapshotAttempt.get(key) ?? 0) < SNAPSHOT_RETRY_MS)) {
          lastSnapshotAttempt.set(key, at);
          const benchmarks = await experiments.recordBenchmarks(date, at).catch((error) => ({ error: error.message }));
          const results = [];
          for (const arm of missing) results.push({ arm: arm.label, ok: await experiments.snapshot(arm, date, at).catch(() => false) });
          done.push({ job: "snapshot", experiment: experiment.name, benchmarks, results });
        }
        if (settings.review && minutes >= REVIEW_AT && !(await missingSnapshots(arms, date)).length) {
          const outcome = await once(`review:${experiment.id}`, date, async () => {
            const result = await review.run(experiment.id, date);
            return { reviewed: result.reviewed ?? false, tradingDays: result.tradingDays, createdArm: result.createdArm?.label ?? null, retired: (result.verdicts ?? []).filter((row) => row.action?.startsWith("retired")).map((row) => row.label) };
          });
          if (outcome) done.push(outcome);
        }
      }
    }
    return done.length ? done : null;
  }

  return Object.freeze({ tick, automation, setAutomation });
}
