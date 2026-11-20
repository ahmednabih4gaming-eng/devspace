import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type GoalStatus = "active" | "paused" | "completed" | "cancelled";

export interface GoalEvent {
  at: string;
  message: string;
  status: GoalStatus;
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
    const goal = await this.get(workspaceRoot, id);
    if (goal.status === "completed" || goal.status === "cancelled") {
      throw new Error("Terminal goals cannot be modified.");
    }
    if (goal.status === "paused" && status === "completed") {
      throw new Error("Resume the goal before marking it completed.");
    }
    const now = new Date().toISOString();
    goal.status = status;
    goal.updatedAt = now;
    goal.events.push({ at: now, status, message });
    await this.save(goal);
    return goal;
  }
}
