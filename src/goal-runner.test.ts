import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoalRunner } from "./goal-runner.js";
import { GoalStore } from "./goal-store.js";
import type { LocalAgentClient } from "./local-agent-client.js";
import type { LocalAgentRecord } from "./local-agent-store.js";

test("runner dispatches one agent, observes completion, and persists evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new GoalStore(directory);
  const goal = await store.create("/repo", "Fix regression", ["npm test passes"]);
  let started = 0;
  let prompt = "";
  const agent = (status: "running" | "idle" | "stopped"): LocalAgentRecord => ({
    id: `goal-${goal.id}-1`,
    workspaceRoot: "/repo",
    profileName: "codex",
    providerInstanceId: "codex",
    driver: "codex",
    writeMode: "allowed",
    status,
    latestResponse: status === "idle" ? "Tests pass." : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as LocalAgentRecord);
  const mock = {
    start: async (input: { prompt: string }) => {
      started++;
      prompt = input.prompt;
      return { isErr: () => false, value: agent("running") };
    },
    get: async () => ({ isErr: () => false, value: agent("idle") }),
    stopAgent: async () => ({ isErr: () => false, value: agent("stopped") }),
  } as unknown as Pick<LocalAgentClient, "start" | "get" | "stopAgent">;
  const runner = new GoalRunner(store, mock);
  const first = await runner.run("/repo", goal.id, "codex");
  assert.equal(first.runs?.[0]?.status, "running");
  assert.match(prompt, /npm test passes/);
  await assert.rejects(runner.run("/repo", goal.id, "codex"), /already running/);
  assert.equal(started, 1);
  const observed = await runner.observe("/repo", goal.id);
  assert.equal(observed.runs?.[0]?.status, "completed");
  assert.equal(observed.runs?.[0]?.response, "Tests pass.");
  assert.equal(observed.status, "active", "verification is host-owned");
});

test("runner stop requests agent cancellation before goal pause", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new GoalStore(directory);
  const goal = await store.create("/repo", "Task", ["Done"]);
  const run = await store.reserveRun("/repo", goal.id, "codex");
  let stopped = false;
  const base = { id: run.agentId, workspaceRoot: "/repo", status: "running" } as LocalAgentRecord;
  const mock = {
    start: async () => ({ isErr: () => false, value: base }),
    get: async () => ({ isErr: () => false, value: base }),
    stopAgent: async () => {
      stopped = true;
      return { isErr: () => false, value: { ...base, status: "stopped" } };
    },
  } as unknown as Pick<LocalAgentClient, "start" | "get" | "stopAgent">;
  const outcome = await new GoalRunner(store, mock).stop("/repo", goal.id, "paused");
  assert.equal(stopped, true);
  assert.equal(outcome.status, "paused");
  assert.equal(outcome.runs?.[0]?.status, "stopped");
});
