---
name: tasklite-worker
description: Work one Task Lite item end to end through the tasklite MCP server. Covers finding and claiming work, getting context, planning, recording progress and evidence, waiting the right way, and handing off or closing. Use whenever you're asked to work on a Task Lite item (an ID like RCP-14), pick up ready work, or resume work the owner sent back.
---

# Working a Task Lite item

Task Lite enforces claims, dependencies and review gates for you. This skill is the **efficient order of calls** and the habits that keep your runs cheap and recoverable.

The project's `AGENTS.md` / `CLAUDE.md` has its own rules: who moves work to Ready, when human review is needed, and the branch naming. Where they differ from this skill, they win.

## 1. Start: four calls or fewer

1. **Identify yourself:** `whoami`, once per session. Note `lease_s` and `stale_after_s`.
2. **Find work:**
   - **Given an item ID?** Skip the search.
   - **Otherwise:** `search_items { project, filter: "resumable" }` first. That's work sent back to you, and it comes before new work. Then `search_items { project, filter: "ready_to_start", limit: 5 }`.
   - **Take the first result.** Ready work is already sorted by priority, then by how much it unblocks.
3. **Claim it:** `claim_lead`, with:
   - `agent_label`: your worker name, if you have one;
   - `workspace`: `repo`, `path` (your worktree), `branch`, `base_ref`, `base_sha`;
   - `brief` and `orchestrator`: if a coordinator dispatched you, the brief text exactly as you received it, plus its IDs.

   Keep the returned `run_id`, and **pass it on every call from now on**. That's what keeps your claim alive.

   If you get `conflict`, someone else holds the item. Pick another one. Never retry in a loop, and never work on an item you haven't claimed.
4. **Get context:** `get_context { id }`. One call gathers the outcome, the acceptance criteria, the decisions you must follow, the epic and label briefs, blockers and planning docs.

**Then, only if needed:**
- `get_item { id }`: when the context shows unread owner notes or an answered question, or when you're resuming. It delivers notes, answers and review decisions **once**, so read them.
- `get_review { id }` first: when resuming work the owner sent back. Their "changes" notes are already steps in your checklist.

## 2. Plan

- **`set_plan`:** 3–8 one-line steps, each a verifiable piece of progress. Steps aren't tickets. Create a new item only when a piece needs its own blocker, owner or review.
- **`set_checks`:** what you'll verify yourself, stated concretely. For example "Planner unit tests pass" or "Reload keeps the selected week (e2e)", never "it works".
- **Human review:** if the project rules say this item needs it and none is declared, `declare_human_review` now. Write plain instructions the owner can follow in minutes. See `tasklite-review-packet`.
- **Changing the plan later:** patch it, and give a `reason`. Send only the steps that change. Don't silently drop a step: mark it `skipped`, with a note.

## 3. The loop, per step

1. `update_step { step_id, state: "current" }`.
2. Do the work.
3. Commit, **push**, then `report_commit { sha, branch, pushed: true }`. Push work in progress at every step: a pushed commit survives a crash or a pruned worktree; an unpushed one may not.
4. `update_check` as checks pass or fail, with evidence: the command and its result, one line.
5. `update_step { state: "done" }`.

**Along the way:**
- **Stay live.** Any call with `run_id` renews your lease. In a long stretch with nothing to record, send `heartbeat { run_id, note }`, well inside `stale_after_s`.
- **Pausing with uncommitted changes?** Send `heartbeat { workspace: { dirty: true } }` first.
- **Started something long-lived?** That means a dev server, a session, a container, a temp directory or a held port. Declare it with `heartbeat { resources_started: [{ kind, label, locator }] }`, and keep the `rsc_…` IDs. The locator must be precise enough for someone else to find it: a port, a pid, a session ID or a path.
- **Something the owner should know?** A surprise, a choice you made, a risk: `add_note`, in one or two sentences.
- **Decisions.** Follow the decisions `get_context` gave you; owner decisions are authoritative. If you set a convention other agents must follow (an interface, a naming rule, a library choice), record it with `publish_decision`, scoped as narrowly as it applies. To challenge an owner decision, use `ask_owner`. Never work around it.

## 4. When you can't carry on

| Situation | Do this |
|---|---|
| You need a product decision | `ask_owner`: one question, the options you see, and your recommendation. Stop the work that depends on it. If you're ending the session, `finish_run` with a summary saying what you're waiting for. |
| You're waiting for another item to land | `park_run { reason, waiting_on: { items: [...] } }` |
| You're waiting for the coordinator to send more work | `park_run { reason, waiting_on: { orchestrator: true } }` |
| A single step is blocked | `update_step { state: "blocked", note }`, and carry on with other steps |
| You're stopping before the work is done | Push, `report_commit`, release your resources, then `release_lead { reason }`. The item goes back to Ready with your plan kept. |
| Something broke and you can't continue | `finish_run { result: "failed", error }` |
| A write returns `conflict` | Read `current` in the error. Re-apply your change only if it still makes sense. |

**Never just go quiet.** A silent run looks stale and loses its claim. A parked run keeps it, and its worktree is protected from pruning. Any later call with your `run_id` un-parks you.

## 5. Finish

1. **Push everything** and report every commit with `pushed: true`.
2. **Release every resource** you declared: `heartbeat { resources_released: [{ resource_id }] }`.
3. **Then hand off or close:**
   - **No human review items:** once the checks pass, `set_status { status: "done" }`. That also finishes your run.
   - **Human review declared:** `submit_packet` (see `tasklite-review-packet`), then `finish_run { result: "finished", summary }`.
4. **Treat `finish_run` warnings as mistakes to fix.** For example `! 2 commits not pushed` or `! 1 resource still declared`. Each one leaves your workspace marked at risk.
5. **A commit after handing off?** Still `report_commit` it. If an open packet was built from an older commit, it's marked out of date for the owner.

## Token habits

- **Read once.** Call `get_context` once per item. Don't re-read the item after each write: mutation results already carry the new version.
- **Read small:**
  - `get_item { view: "summary" }` for status checks;
  - `fields: [...]` to trim reads further;
  - `get_changes` with a cursor to watch for updates, instead of polling `get_item`.
- **Write small.** `set_plan`, `set_checks` and `update_item` patch, so send only what changed.
- **Pass an `idempotency_key`** on any write you might retry after a timeout.
- **Keep text short:**
  - steps: one line;
  - notes: one or two sentences;
  - evidence: the command and its result.
- **Never paste secrets.** The write is rejected and nothing is stored.

## Don't

- Work on an item you haven't claimed, or one someone else holds.
- Create tickets for checklist steps.
- Close with `set_status` while human review items are undecided. It fails; use `submit_packet`.
- Move items to Ready unless the project rules allow it.
- Leave a dev server, session or container running without declaring it.
- Keep state only in your own memory or chat. Task Lite is the record, and the next agent starts from it.
