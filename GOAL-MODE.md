# Host-driven Goal Mode (experimental)

This fork adds **persistent, workspace-scoped goals** to DevSpace's MCP tool
surface. Goals are checkpoints for the **MCP host** (ChatGPT, Claude, or another
orchestrator), not a hidden background agent or an autonomous worker.

## Usage

1. Call `open_workspace` and keep its `workspace_id`.
2. Call `create_goal` with a title and observable `success_criteria`.
3. Optionally call `run_goal` with an enabled agent target (for example
   `codex`) to dispatch **one bounded agent turn** into DevSpace's existing
   local agent daemon. A run is not an unlimited autonomous loop.
4. After meaningful work, call `update_goal` with `status: "active"` and
   an evidence-based progress message.
5. Call `goal_status` or `list_goals` after reconnecting to recover context.
6. To stop an executing goal, call `stop_goal` (`paused` or `cancelled`).
   To resume a paused goal, call `update_goal` with `status: "active"`.
   Mark a goal `completed` only after validating every criterion, or
   `cancelled` to close it without completion.

For clients supporting custom command prompts, an equivalent user instruction is:

```text
/goal Fix failing tests; criteria: the project test suite passes.
Open the workspace, create a DevSpace goal, work on it using available tools,
record evidence and status, and finish only after verifying the criteria.
```

**Important:** `/goal` is not a native ChatGPT slash command supplied by MCP.
The user-facing command syntax depends on the MCP host. The MCP tools
`create_goal`, `goal_status`, `list_goals`, `update_goal`, `run_goal`,
and `stop_goal` are portable.

## Persistence and boundaries

Goal records are JSON files beneath `~/.devspace/goals/v1/`, partitioned by a
SHA-256 hash of the canonical workspace root obtained from the existing
`WorkspaceRegistry`. No model credentials are stored. Goal IDs are UUIDs and
all goal tools first resolve an authorized workspace.

An explicitly dispatched `run_goal` turn executes in the existing DevSpace
local agent daemon and can continue after the MCP client disconnects. Agent
progress is reconciled through `goal_status`. Each goal allows at most five
agent turns; a goal is never marked complete based only on the agent response.
Goal status remains `active` until the host verifies the criteria and marks
it `completed`. Only one run per goal may be active at a time. For an
indefinite autonomous planning/retry loop a separate security review, execution
budget, and scheduler would still be required.
