import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GoalStore } from "./goal-store.js";

test("goals are durable and isolated by workspace", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-goals-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new GoalStore(directory);
  const created = await store.create("/work/project-a", "Fix tests", ["All tests pass"]);
  assert.equal(created.status, "active");
  assert.equal((await store.list("/work/project-a")).length, 1);
  assert.deepEqual(await store.list("/work/project-b"), []);
  await assert.rejects(store.get("/work/project-b", created.id), /not found/);

  const resumedStore = new GoalStore(directory);
  const saved = await resumedStore.get("/work/project-a", created.id);
  assert.deepEqual(saved.successCriteria, ["All tests pass"]);
  assert.equal(saved.events.length, 1);

  const paused = await resumedStore.update("/work/project-a", created.id, "paused", "Blocked on CI");
  assert.equal(paused.status, "paused");
  await assert.rejects(
    resumedStore.update("/work/project-a", created.id, "completed", "Not tested"),
    /Resume the goal/,
  );
  const active = await resumedStore.update("/work/project-a", created.id, "active", "CI restored");
  assert.equal(active.events.length, 3);
  const complete = await resumedStore.update("/work/project-a", created.id, "completed", "All tests pass");
  assert.equal(complete.status, "completed");
  await assert.rejects(
    resumedStore.update("/work/project-a", created.id, "active", "Reopen"),
    /Terminal goals/,
  );
});

test("rejects invalid identifiers before reading files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-goals-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new GoalStore(directory);
  await assert.rejects(store.get("/work", "../../sensitive"), /Invalid goal ID/);
});

test("bounded agent reservations survive restarts and prevent concurrent runs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-goals-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new GoalStore(directory);
  const goal = await store.create("/work", "Build", ["Smoke test passes"]);
  const first = await store.reserveRun("/work", goal.id, "codex");
  assert.equal(first.status, "starting");
  await assert.rejects(store.reserveRun("/work", goal.id, "codex"), /already running/);
  await assert.rejects(store.update("/work", goal.id, "completed", "unverified"), /Stop or finish/);
  await store.updateRun("/work", goal.id, first.agentId, "running");
  const stopped = await new GoalStore(directory).updateRun("/work", goal.id, first.agentId, "stopped");
  assert.equal(stopped.runs?.[0]?.status, "stopped");
  const second = await store.reserveRun("/work", goal.id, "claude");
  assert.notEqual(second.agentId, first.agentId);
  await store.updateRun("/work", goal.id, second.agentId, "completed", { response: "Tests passed" });
  await store.update("/work", goal.id, "completed", "Verified tests");
  assert.equal((await store.get("/work", goal.id)).runs?.length, 2);
});

test("simultaneous reservations create only one run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-goals-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new GoalStore(directory);
  const goal = await store.create("/work", "Review", ["No blockers"]);
  const attempts = await Promise.allSettled(
    Array.from({ length: 4 }, () => new GoalStore(directory).reserveRun("/work", goal.id, "codex")),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.get("/work", goal.id)).runs?.length, 1);
});
