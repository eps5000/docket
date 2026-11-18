---
name: docket-lead-subagents
description: Lead a Docket item while delegating to subagents. Covers one lead per item, child runs for subagents with their own connection, log_subagent with honest provenance for those without, resources and workspaces per child, and keeping the lead alive while subagents work. Use when you hold the lead on an item and are about to fan work out to subagents or helper agents.
---

# Leading an item with subagents

One item has **one lead**: you. Subagents never call `claim_lead` on your item. They'd get `conflict`, and the owner would see a rejected claim. They work **under** your run.

## 1. Choose how each subagent reports

| The subagent                                                          | Use                                                                                                                      | It records                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Has its own Docket connection (a separate agent process or worker) | `start_run { id, parent_run_id: <your run>, agent_label, workspace?, brief? }`, then give it the returned child `run_id` | Its own updates (checks, steps, notes), passing the child `run_id`, then `finish_run` |
| Has no connection (an in-process subagent or tool call)               | `log_subagent` when it reports back                                                                                      | Nothing. You record it.                                                               |

**Give a connected subagent's child run** its own `workspace` (if it has its own worktree) and its `brief` (the exact instructions you gave it), so a crash leaves it restartable too.

## 2. Provenance: be honest

| Value      | When to use it                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `observed` | You saw the subagent's run or output yourself: its test output, its diff, its child run in Docket |
| `relayed`  | You're passing on what it told you, without checking                                                 |

The owner sees the difference. Never mark relayed work as observed. Checks a connected subagent records itself carry its own provenance (see MCP_SPEC flow §7.7).

```
log_subagent { id: "RCP-14", run_id: "<lead>", step_id: "wst_…", name: "explorer",
  outcome: "Mapped 214 ingredient units in sample recipes", provenance: "relayed" }
```

`log_subagent` attaches a short line to a step. It never creates a ticket, so don't create tickets per subagent either.

## 3. You own the plan

- **Plan and steps are yours.** You write the plan (`set_plan`) and move the steps. Subagents report under the steps you assign them; they don't restructure the plan.
- **Divide work by step.** One subagent per step, or a clear part of one, makes logs and checks line up.
- **Merge, then report.** Integrate subagents' commits on your branch, push, and `report_commit` on the item yourself.

## 4. Keep things alive and tidy

- **Stay live while subagents work.** Waiting on your own subagents is active work, so don't `park_run`. Send `heartbeat { run_id, note: "waiting on 3 subagents: units, aisles, export" }` well inside the stale window.
- **Resources belong to whoever started them.** A connected subagent declares its own dev servers and sessions on its child run, and releases them before its `finish_run`. Anything you start for an in-process subagent, you declare on your run.
- **Wrap up children first.** Before you finish: every child run has finished, every child resource has been released, and everything is merged and pushed. Child runs left open, or child resources left running, show up in `recovery_report`.

## Don't

- Run two leads on one item, or have a subagent claim it.
- Mark relayed work `observed`.
- Let subagents create tickets for their pieces.
- Finish your lead run while child runs are still working.
