import type { LocalAgentClient } from "./local-agent-client.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import type { LocalAgentWriteMode } from "./local-agent-runtime.js";
import { GoalStore, type Goal, type GoalRun, type GoalRunStatus } from "./goal-store.js";

type GoalAgentClient = Pick<LocalAgentClient, "start" | "get" | "stopAgent">;

function agentRunStatus(record: LocalAgentRecord): GoalRunStatus {
  switch (record.status) {
    case "idle": return "completed";
    case "error": return "failed";
    case "stopped": return "stopped";
    case "starting": return "starting";
    case "running": return "running";
  }
}

function buildPrompt(goal: Goal, run: GoalRun): string {
  return [
    "You are carrying out one supervised, inspectable DevSpace goal run.",
    `Goal: ${goal.title}`,
    "Success criteria (verify each, do not declare success without evidence):",
    ...goal.successCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    `Run ${goal.runs?.length ?? 1} of 5; execution ID: ${run.agentId}.`,
    "Follow repository instructions. Work only inside the authorized workspace.",
    "Run relevant tests. Summarize changed files, test results, unresolved issues, and",
    "which criteria are satisfied. Do not claim the overall goal is complete unless",
    "every criterion has been tested. Do not launch indefinite loops or external services.",
  ].join("\n");
}

/**
 * Dispatches one actual agent turn to the existing DevSpace daemon. The daemon
 * may outlive the MCP request; records and goal status remain inspectable.
 * No unbounded autonomous retry loop lives in the MCP server.
 */
export class GoalRunner {
  constructor(
    private readonly goals: GoalStore,
    private readonly agents: GoalAgentClient,
  ) {}

  async run(
    workspaceRoot: string,
    goalId: string,
    target: string,
    writeMode: Extract<LocalAgentWriteMode, "read_only" | "allowed"> = "allowed",
  ): Promise<Goal> {
    const goal = await this.goals.get(workspaceRoot, goalId);
    if (goal.status !== "active") throw new Error("Resume the goal before running it.");
    const last = goal.runs?.at(-1);
    if (last?.status === "running") throw new Error("Goal agent is already running.");
    // Re-dispatch a reserved agent ID when an earlier MCP request was interrupted.
    // The daemon deduplicates by agent ID + dispatch signature.
    const run = last?.status === "starting"
      ? last
      : await this.goals.reserveRun(workspaceRoot, goalId, target);
    if (run.target !== target) throw new Error("Pending goal run uses a different agent target.");
    const persisted = await this.goals.get(workspaceRoot, goalId);
    const result = await this.agents.start({
      agentId: run.agentId,
      target,
      prompt: buildPrompt(persisted, run),
      workspaceRoot,
      writeMode,
    });
    if (result.isErr()) {
      // Provider and target validation are definitive; a new bounded run
      // may use a different target. Transport failures are ambiguous and
      // must retain the reservation so re-dispatch remains idempotent.
      if (["AgentTargetError", "AgentProviderUnavailableError", "AgentScopeError"].includes(result.error.name)) {
        await this.goals.updateRun(workspaceRoot, goalId, run.agentId, "failed", {
          error: result.error.message,
        });
      }
      // A transport error might occur after successful daemon dispatch.
      // Retain the deterministic agent ID for safe retry instead of
      // allocating a second agent which could duplicate destructive work.
      throw new Error(`Unable to confirm goal agent dispatch: ${result.error.message}`);
    }
    return this.goals.updateRun(workspaceRoot, goalId, run.agentId, agentRunStatus(result.value), {
      response: result.value.latestResponse,
      error: result.value.error,
    });
  }

  async observe(workspaceRoot: string, goalId: string): Promise<Goal> {
    const goal = await this.goals.get(workspaceRoot, goalId);
    const run = goal.runs?.at(-1);
    if (!run || !["starting", "running"].includes(run.status)) return goal;
    const observation = await this.agents.get(run.agentId, { workspaceRoot });
    if (observation.isErr()) {
      // A daemon may still be starting, or temporarily unavailable. Avoid
      // guessing completion or allocating a replacement agent.
      return goal;
    }
    return this.goals.updateRun(workspaceRoot, goalId, run.agentId, agentRunStatus(observation.value), {
      response: observation.value.latestResponse,
      error: observation.value.error,
    });
  }

  async stop(
    workspaceRoot: string,
    goalId: string,
    disposition: "paused" | "cancelled",
  ): Promise<Goal> {
    const observed = await this.observe(workspaceRoot, goalId);
    if (observed.status === "completed" || observed.status === "cancelled") {
      throw new Error("Cannot stop a terminal goal.");
    }
    const run = observed.runs?.at(-1);
    if (run && (run.status === "starting" || run.status === "running")) {
      const stopped = await this.agents.stopAgent(run.agentId, { workspaceRoot });
      if (stopped.isErr()) throw new Error(`Cannot verify agent stopped: ${stopped.error.message}`);
      const actual = agentRunStatus(stopped.value);
      if (actual === "starting" || actual === "running") {
        throw new Error("Agent is still running; goal lifecycle was not changed.");
      }
      await this.goals.updateRun(workspaceRoot, goalId, run.agentId, actual, {
        response: stopped.value.latestResponse,
        error: stopped.value.error,
      });
    }
    return this.goals.update(workspaceRoot, goalId, disposition, `Goal ${disposition}; agent stopped or already finished.`);
  }
}
