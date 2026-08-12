import assert from "node:assert/strict";
import test from "node:test";
import { canTransition, transitionSession } from "../../server/runtime/state-machine.js";

test("session lifecycle accepts the documented path", () => {
  let status = "draft";
  status = transitionSession(status, "start");
  assert.equal(status, "arming");
  status = transitionSession(status, "armed");
  assert.equal(status, "running");
  status = transitionSession(status, "pause");
  assert.equal(status, "paused");
  status = transitionSession(status, "resume");
  assert.equal(status, "running");
  status = transitionSession(status, "stop");
  assert.equal(status, "stopping");
  status = transitionSession(status, "complete");
  assert.equal(status, "stopped");
});

test("halt is terminal and idempotent", () => {
  assert.equal(transitionSession("running", "halt"), "halted");
  assert.equal(transitionSession("halted", "halt"), "halted");
  assert.equal(canTransition("halted", "resume"), false);
  assert.throws(() => transitionSession("halted", "resume"), /Cannot resume/);
});

test("backtests may complete during arming", () => {
  assert.equal(transitionSession("arming", "complete"), "stopped");
});
