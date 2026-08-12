import { AppError } from "../http/errors.js";

export const SESSION_STATUSES = Object.freeze(["draft", "arming", "running", "paused", "stopping", "stopped", "halted", "errored"]);
export const TERMINAL_SESSION_STATUSES = new Set(["stopped", "halted", "errored"]);

const TRANSITIONS = Object.freeze({
  draft: { start: "arming" },
  arming: { armed: "running", complete: "stopped", fail: "errored", halt: "halted" },
  running: { pause: "paused", stop: "stopping", halt: "halted", fail: "errored" },
  paused: { resume: "running", stop: "stopping", halt: "halted", fail: "errored" },
  stopping: { complete: "stopped", fail: "errored", halt: "halted" },
  stopped: {},
  halted: {},
  errored: {}
});

export function transitionSession(status, event) {
  if (!SESSION_STATUSES.includes(status)) throw new AppError("INVALID_SESSION_STATE", `Unknown session status: ${status}`, 409);
  const next = TRANSITIONS[status]?.[event];
  if (!next) {
    if ((event === "halt" && status === "halted") || (event === "stop" && status === "stopped")) return status;
    throw new AppError("INVALID_SESSION_TRANSITION", `Cannot ${event} a ${status} session.`, 409, { status, event });
  }
  return next;
}

export function canTransition(status, event) {
  return Boolean(TRANSITIONS[status]?.[event]) || (event === "halt" && status === "halted") || (event === "stop" && status === "stopped");
}
