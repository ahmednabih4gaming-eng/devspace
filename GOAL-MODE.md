# Host-driven Goal Mode (experimental)

This fork adds **persistent, workspace-scoped goals** to DevSpace's MCP tool
surface. Goals are checkpoints for the **MCP host** (ChatGPT, Claude, or another
orchestrator), not a hidden background agent or an autonomous worker.

## Usage

1. Call `open_workspace` and keep its `workspace_id`.
2. Call `create_goal` with a title and observable `success_criteria`.
3. Use DevSpace's regular tools, subagents, and tests to perform the work.
4. After meaningful work, call `update_goal` with `status: "active"` and
   an evidence-based progress message.
5. Call `goal_status` or `list_goals` after reconnecting to recover context.
6. To stop, set `status: "paused"`; to resume, set `status: "active"`.
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
`create_goal`, `goal_status`, `list_goals`, and `update_goal` are portable.

## Persistence and boundaries

Goal records are JSON files beneath `~/.devspace/goals/v1/`, partitioned by a
SHA-256 hash of the canonical workspace root obtained from the existing
`WorkspaceRegistry`. No model credentials are stored. Goal IDs are UUIDs and
all goal tools first resolve an authorized workspace.

Goals do **not** execute on their own when the MCP host disconnects. For true
unattended execution a separately authenticated agent runtime, bounded task
budgets, cancellation, and recovery semantics would need to be designed.
