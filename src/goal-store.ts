import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type GoalStatus = "active" | "paused" | "completed" | "cancelled";

export interface GoalEvent {
  at: string;
  message: string;
  status: GoalStatus;
}

export type GoalRunStatus = "starting" | "running" | "completed" | "failed" | "stopped";
export const MAX_GOAL_RUNS = 5;

export interface GoalRun {
  agentId: string;
  target: string;
  status: GoalRunStatus;
  startedAt: string;
  updatedAt: string;
  response?: string;
  error?: string;
}

export interface Goal {
  id: string;
  workspaceRoot: string;
  title: string;
  successCriteria: string[];
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  events: GoalEvent[];
  runs?: GoalRun[];
}

const goalIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class GoalStore {
  constructor(private readonly baseDir = join(homedir(), ".devspace", "goals", "v1")) {}

  private directory(workspaceRoot: string): string {
    const key = createHash("sha256").update(workspaceRoot).digest("hex");
    return join(this.baseDir, key);
  }

  private file(workspaceRoot: string, id: string): string {
    if (!goalIdPattern.test(id)) throw new Error("Invalid goal ID.");
    return join(this.directory(workspaceRoot), `${id}.json`);
  }

  private async save(goal: Goal): Promise<void> {
    const directory = this.directory(goal.workspaceRoot);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.file(goal.workspaceRoot, goal.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(goal, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  }

  /**
   * Multiple MCP requests can run in distinct server instances. Serialize
   * updates on disk to prevent duplicate goal dispatch and lost event writes.
   */
  private async locked<T>(workspaceRoot: string, id: string, action: () => Promise<T>): Promise<T> {
    const directory = this.directory(workspaceRoot);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = this.file(workspaceRoot, id) + ".lock";
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const handle = await open(lock, "wx", 0o600);
        try {
          return await action();
        } finally {
          await handle.close();
          await unlink(lock).catch((error: unknown) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          });
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        // Recover locks left by a crashed process; normal critical sections
        // are only a short read-modify-write on one JSON record.
        try {
          if (Date.now() - (await stat(lock)).mtimeMs > 60_000) await unlink(lock);
        } catch (staleError) {
          if (!(staleError instanceof Error && "code" in staleError && staleError.code === "ENOENT")) {
            throw staleError;
          }
        }
        await delay(50);
      }
    }
    throw new Error("Goal is busy; retry the operation.");
  }

  async create(workspaceRoot: string, title: string, successCriteria: string[]): Promise<Goal> {
    const now = new Date().toISOString();
    const goal: Goal = {
      id: randomUUID(),
      workspaceRoot,
      title,
      successCriteria,
      status: "active",
      createdAt: now,
      updatedAt: now,
      events: [{ at: now, status: "active", message: "Goal created. The MCP host owns execution." }],
      runs: [],
    };
    await this.save(goal);
    return goal;
  }

  async get(workspaceRoot: string, id: string): Promise<Goal> {
    let parsed: Goal;
    try {
      parsed = JSON.parse(await readFile(this.file(workspaceRoot, id), "utf8")) as Goal;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error("Goal not found in this workspace.");
      }
      throw error;
    }
    if (parsed.id !== id || parsed.workspaceRoot !== workspaceRoot) {
      throw new Error("Goal workspace mismatch.");
    }
    parsed.runs ??= []; // Backwards compatible with goals created before runner support.
    return parsed;
  }

  async list(workspaceRoot: string): Promise<Goal[]> {
    let files: string[];
    try {
      files = await readdir(this.directory(workspaceRoot));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const goals = await Promise.all(
      files.filter((file) => goalIdPattern.test(file.replace(/\.json$/, "")) && file.endsWith(".json"))
        .map((file) => this.get(workspaceRoot, file.slice(0, -5))),
    );
    return goals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async update(
    workspaceRoot: string,
    id: string,
    status: GoalStatus,
    message: string,
  ): Promise<Goal> {
    return this.locked(workspaceRoot, id, async () => {
    const goal = await this.get(workspaceRoot, id);
    if (goal.status === "completed" || goal.status === "cancelled") {
      throw new Error("Terminal goals cannot be modified.");
    }
    if (goal.status === "paused" && status === "completed") {
      throw new Error("Resume the goal before marking it completed.");
    }
    if ((status === "paused" || status === "cancelled" || status === "completed")
        && goal.runs?.some((run) => run.status === "running" || run.status === "starting")) {
      throw new Error("Stop or finish the running agent before changing goal lifecycle.");
    }
    const now = new Date().toISOString();
    goal.status = status;
    goal.updatedAt = now;
    goal.events.push({ at: now, status, message });
    await this.save(goal);
    return goal;
    });
  }

  async reserveRun(workspaceRoot: string, id: string, target: string): Promise<GoalRun> {
    return this.locked(workspaceRoot, id, async () => {
      const goal = await this.get(workspaceRoot, id);
      if (goal.status !== "active") throw new Error("Only active goals can run.");
      const runs = goal.runs ?? [];
      if (runs.some((run) => run.status === "starting" || run.status === "running")) {
        throw new Error("A goal agent is already running. Check goal_status first.");
      }
      if (runs.length >= MAX_GOAL_RUNS) throw new Error("Goal run limit reached.");
      const now = new Date().toISOString();
      const run: GoalRun = {
        agentId: `goal-${goal.id}-${runs.length + 1}`,
        target,
        status: "starting",
        startedAt: now,
        updatedAt: now,
      };
      goal.runs = [...runs, run];
      goal.updatedAt = now;
      goal.events.push({ at: now, status: goal.status, message: `Starting agent ${run.agentId} (${target}).` });
      await this.save(goal);
      return run;
    });
  }

  async updateRun(
    workspaceRoot: string,
    id: string,
    agentId: string,
    status: GoalRunStatus,
    data: { response?: string; error?: string } = {},
  ): Promise<Goal> {
    return this.locked(workspaceRoot, id, async () => {
      const goal = await this.get(workspaceRoot, id);
      const run = goal.runs?.find((item) => item.agentId === agentId);
      if (!run) throw new Error("Run not found in this goal.");
      if (run.status === "completed" || run.status === "failed" || run.status === "stopped") {
        return goal; // An older poll must not overwrite a terminal state.
      }
      if (run.status === "running" && status === "starting") {
        return goal; // A late dispatch receipt cannot rewind an observed running agent.
      }
      const now = new Date().toISOString();
      const isTerminal = status === "completed" || status === "failed" || status === "stopped";
      if (run.status !== status || isTerminal) {
        goal.events.push({
          at: now,
          status: goal.status,
          message: `Agent ${agentId}: ${status}${data.error ? ` (${data.error.slice(0, 500)})` : ""}.`,
        });
      }
      run.status = status;
      run.updatedAt = now;
      if (data.response !== undefined) run.response = data.response.slice(0, 16_000);
      if (data.error !== undefined) run.error = data.error.slice(0, 2_000);
      goal.updatedAt = now;
      await this.save(goal);
      return goal;
    });
  }
}
