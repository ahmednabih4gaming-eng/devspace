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
