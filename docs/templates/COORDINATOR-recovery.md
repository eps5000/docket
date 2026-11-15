<!--
Runbook for whoever coordinates agents against Task Lite: an Orca orchestrator agent, a script, or the owner.
Paste it, or link it, into the coordinator's instructions. Task Lite records; the coordinator acts (owner decision 26).
-->

# Coordinator runbook: dispatching, parking, recovering

## When you dispatch a worker
1. **Write the brief** you would want to re-send after a crash: target, constraints, evidence, and how to report.
2. **Tell the worker** to `claim_lead` with:
   - `workspace`: `path`, `branch`, `base_ref`, `base_sha`;
   - `orchestrator`: `name` plus your IDs, for example Orca's `dispatch_id`, `task_id` and `run_id`;
   - `brief`: the exact text you sent.

   If the worker can't, claim on its behalf and give it the `run_id`.
3. **Tell the worker** to:
   - push work in progress at every checklist step (`report_commit … pushed: true`);
   - declare long-lived resources (dev servers, sessions, containers) with `heartbeat resources_started`, and release them before `finish_run`;
   - `park_run` whenever it has to wait, instead of going quiet.

## When a worker has to wait for you
Have it `park_run` with `waiting_on: { orchestrator: true }` (or the items it needs). A parked worker keeps its claim, and its worktree counts as **in use**. When you're ready, send it more work. Its next call resumes it.

## Before you prune worktrees or clean up
1. Call `recovery_report`.
2. **Prune only workspaces in `safe_to_prune`.** Never prune `in_use`, `parked` or `at_risk`. Idle is not finished.
3. Stop or end every resource in `orphaned_resources`. Then mark it released (or let the resumed run release it).

## After a crash or restart (yours, Orca's or Task Lite's)
1. `recovery_report { include_briefs: true }`.
2. **For each interrupted or stale entry:**
   1. **Find the code.**
      - If the worktree at `workspace.path` exists, reuse it.
      - If it's gone, recreate it from `pushed_sha` on `branch`.
      - If `dirty` was true or `head_sha` ≠ `pushed_sha`, some work may be lost. Say so in the new brief. The owner already sees "Unpushed work may be lost" under Problems.
   2. **Re-dispatch** a worker with the **stored brief, unchanged**, plus: "Resume from the checklist. Call `claim_lead` first, then `get_context` and `get_item`."
   3. **Clean up** that run's unreleased resources.
3. **For each parked entry:**
   - `resume_ready` is true: send the worker more work, or re-dispatch it as above if its process is gone.
   - Otherwise: leave it. It's waiting on purpose.
4. **Re-check:** a second `recovery_report` should show nothing interrupted that you haven't re-dispatched, and no orphaned resources.

## Never
- Treat an idle worktree or terminal as finished. Check its workspace state.
- Rebuild a mandate from memory or chat history when Task Lite has the brief.
- Leave a process, dev server or session running without a declared resource that someone will release.
