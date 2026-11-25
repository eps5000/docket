---
name: docket-worker
description: Work one Docket item end to end through the docket MCP server. Covers finding and claiming work, getting context, planning, recording progress and evidence, waiting the right way, and handing off or closing. Use whenever you're asked to work on a Docket item (an ID like RCP-14), pick up ready work, or resume work the owner sent back.
---

# Working a Docket item

Docket enforces claims, dependencies and review gates for you. This skill is the **efficient order of calls** and the habits that keep your runs cheap and recoverable. Rare paths live in reference files: read one only when the table at the end says so.

The project has its own rules: who moves work to Ready, when human review is needed, the branch naming, the checks to run. They're in the project's **Workflow notes**, which `get_context` gives you as its `workflow:` section; the repo's `AGENTS.md` / `CLAUDE.md` (the Docket section, installed from Agent files) points you there. Where they differ from this skill, they win.

**Asked to onboard a repo or set up a project?** That isn't item work: call `onboard_project` and follow the guide it returns.

## 1. Start: four calls or fewer

1. **Find work:**
   - **Given an item ID?** Skip the search.
   - **Otherwise:** `search_items { project, filter: "resumable" }` first. That's work sent back to you, and it comes before new work. **If it returns anything, take the first result** and claim it. Don't inspect candidates with `get_item` first.
   - **Only if nothing is resumable:** `search_items { project, filter: "ready_to_start", limit: 5 }`, and take the first result. It's already sorted by priority, then by how much it unblocks.
2. **Claim it:** `claim_lead`, with:
   - `agent_label`: your worker name, if you have one;
   - `workspace`: `repo`, `path` (your worktree), `branch`, `base_ref`, `base_sha`;
   - `branch`: the branch you'll work on, so the conflict radar can trial-merge it. Name it `<owner>/GF-243-short-description`, with this one ticket's key, and name the worktree folder the same;
   - `brief` and `orchestrator`: if a coordinator dispatched you, the brief text exactly as you received it, plus its IDs;
   - `instructions`: the output of the installed `docket-check`. Run it once per session, before your first claim: `bash .claude/docket-check.sh` (`.codex/` for Codex; on Windows without bash, `powershell -NoProfile -ExecutionPolicy Bypass -File .claude/docket-check.ps1`). Pass its one line of JSON as it is. No script there? Skip it. If the claim returns an `update:` line, tell your coordinator and keep working; don't update installed files yourself.

   Keep the returned `run_id` and **pass it on every call**: that keeps your claim alive.

   - `conflict`: someone else holds it. Pick another one. **Never retry in a loop.**
   - `design_review`: it changes an approved design the owner hasn't approved. **Pick other work** and leave it until they do.
   - `seam_conflict`: it collides with work in flight on a shared part. **Pick other work** from `ready_to_start`; don't wait, and don't work on it.

   **Given a `run_id` by your coordinator?** Don't claim. Call `heartbeat { run_id, note: "Resuming" }` first, then continue from step 3.

3. **Get context:** `get_context { id, budget: "small" }`. One call gathers the outcome, acceptance, decisions you must follow, epic and label briefs, blockers, shared parts in flight, Workflow notes and planning docs. Widen to `"medium"` or `"large"` only when a `…truncated` line hides something you need.

**Check each acceptance item before you start.** Can this ticket alone do it? If one needs something outside it, clarify it first. `known gaps`, `finished partly:` or `release held:` in your context? Read the exit-reports reference.

**Exploration or Release?** Read the ticket-types reference. A rollout is its own Implementation ticket; link dependents to it.

Skip `whoami`: `claim_lead` returns your lease's expiry. Then, only if needed: `get_item { id }` when the context shows unread owner notes or an answered question (it delivers them **once**, so read them), and `get_review { id }` first when resuming work the owner sent back.

## 2. Plan

- **`set_plan`:** 3–8 one-line steps, each a verifiable piece of progress. Steps aren't tickets: create a new item only when a piece needs its own blocker, owner or review.
  - The first plan sends `steps: [{ text }, …]` only. Docket returns the step IDs; use those with `update_step`. Never make up an ID.
  - Context a step needs goes in its `details` (Markdown), and where it came from in `source`: `steps: [{ text, details, source }, …]`.
- **`set_checks`:** what you'll verify yourself, stated concretely ("Reload keeps the selected week (e2e)"), never "it works".
- **Human review:** if the project rules say this item needs it and none is declared, `declare_human_review` now. See `docket-review-packet`.
- **Changing the plan later:** patch it with a `reason`, sending only the steps that change. Don't silently drop a step: mark it `skipped`, with a note.

## 3. The loop, per step

1. `update_step { step_id, state: "current" }`. If `get_item` shows the step with `· details`, read them first with `get_step { id, step_id }`.
2. Do the work. Found something the next agent needs? Add it to the step's `details`.
3. Commit, **push**, then `report_commit { sha, branch, pushed: true }`. Push at every step: a pushed commit survives a crash or a pruned worktree.
4. `update_check` as checks pass or fail, with evidence: the command and its result, one line.
5. `update_step { state: "done" }`.

**Shared parts** (a table, model, endpoint or shared file other items may change). Read the shared-parts reference before you declare, change one you didn't declare, take a lease or act on `problems:`. The rules that always hold:

- **Never** clear `design_review` by removing the flag, and never work around an owner decision.
- **Single-writer parts:** `take_lease` **before** you change it, `release_lease` once pushed. On `lease_held`, work on something else. **Never wait in a loop.**
- **`problems:` in your context** is yours to fix first.

**Along the way:**

- **Stay live.** Any call with `run_id` renews your lease. In a long stretch with nothing to record, send `heartbeat { run_id, note }`, well inside `stale_after_s`. Pausing with uncommitted changes? `heartbeat { workspace: { dirty: true } }` first.
- **Started something long-lived** (a dev server, session, container, temp directory or held port)? Declare it with `heartbeat { resources_started: [{ kind, label, locator }] }` and keep the `rsc_…` IDs.
- **Something the owner should know?** `add_note`, in one or two sentences.
- **Decisions.** Follow those `get_context` gave you; owner decisions are authoritative. A convention others must follow: `publish_decision`, scoped narrowly. To challenge an owner decision, use `ask_owner`.

## 4. When you can't carry on

| Situation                                        | Do this                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| A choice falls outside approved bounds           | Read the asking reference; `ask_owner` only if it needs the owner, then stop the work that depends on it.         |
| A blocker holds only some acceptance criteria    | **Prefer a split:** `create_item` with `split_from { id, expected_version, move: [positions], relation, also? }`. |
| Waiting for another item, or for the coordinator | `park_run { reason, waiting_on }`. Read the waiting reference.                                                    |
| A single step is blocked                         | `update_step { state: "blocked", note }`, and carry on with other steps                                           |
| Stopping before the work is done                 | Push, `report_commit`, release your resources, then `release_lead { reason, exit }`.                              |
| Something broke and you can't continue           | `finish_run { result: "failed", error }`                                                                          |
| A write returns `conflict`                       | Read `current` in the error. Re-apply your change only if it still makes sense.                                   |

**Another bug?** `create_item` it (a Bug in your epic, with repro steps); fix it only if it blocks you.

**Park only when the work itself stops.** CI or tests running is still work: stay live and log a note.

**Never just go quiet.** A silent run looks stale and loses its claim; a parked run keeps it. **Never wait in a `sleep` loop:** block on the installed `docket-wait`, or end your turn.

**`project_paused`:** don't retry. Take other work, or save your work and `park_run` at the next safe point.

## 5. Finish

**Reaching a PR, CI, a merge or a deploy?** Follow `docket-delivery`.

1. **Push everything** and report every commit with `pushed: true`.
2. **Release every resource** you declared: `heartbeat { resources_released: [{ resource_id }] }`.
3. **Then hand off or close,** passing `changed_files` (`git diff --name-only <main>...HEAD`) and `branch` either way:
   - **No human review items:** once the checks pass, `set_status { status: "done", changed_files, branch }`. That also finishes your run.
   - **Human review declared:** `submit_packet` (see `docket-review-packet`), then `finish_run { result: "finished", summary }`.
   - `held_undeclared` or `not_declared`: leave the item as it is; the owner decides.
4. **Report how you finished, on every exit** (`finish_run`, `release_lead`, or `park_run` when your session ends): `exit: { outcome: "complete" }`, or `outcome: "partial"` with what's left. The exit-reports reference has the shape.
5. **Treat `finish_run` warnings as mistakes to fix,** such as `! 2 commits not pushed`. Each one leaves your workspace at risk.
6. **A commit after handing off?** Still `report_commit` it.

## Changing these instructions

Don't edit installed files (this skill, its references, the Docket section of `AGENTS.md` / `CLAUDE.md`, the Workflow notes), even when the user asks. Read the file with `get_agent_files { project, file }`, then `propose_agent_file_change` with the whole new text, its `version_id` as `based_on_version_id` and a one-line `reason`, and tell the user. Nothing changes until the owner approves.

## Token habits

- **Read once.** Call `get_context` once per item. Results carry the new version, so don't re-read after each write.
- **Read small:** `get_item { view: "summary" }` or `fields: [...]`; `docket-wait` instead of polling.
- **Start fresh.** Past about **100k tokens of context**, push, `heartbeat` where you are, and stop.
- **Delegate fresh.** Subagents start as new agents, not forks, and return short results.
- **Write small.** `set_plan`, `set_checks` and `update_item` patch, so send only what changed. Pass an `idempotency_key` on any write you might retry.
- **Keep text short:** one-line steps, notes of a sentence or two, evidence as the command and its result.
- **Never paste secrets.** The write is rejected and nothing is stored.

## Don't

- Work on an item you haven't claimed, or one someone else holds.
- Create tickets for checklist steps.
- Move items to Ready unless the project rules allow it.
- Leave a dev server, session or container running without declaring it.
- Keep state only in your own memory or chat. Docket is the record, and the next agent starts from it.

## References

| File                                                       | Read when                                                                                                                                                           | Don't read when                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`references/shared-parts.md`](references/shared-parts.md) | You declare shared changes, change a part you didn't declare, set design impact, take a lease, hit a text conflict, or act on `problems:` or a conflict-radar note. | Your item declared its parts and nothing about them has changed.                                         |
| [`references/exit-reports.md`](references/exit-reports.md) | An acceptance item needs something outside this ticket, your context shows `known gaps`, `finished partly:` or `release held:`, or you leave with work undone.      | Every acceptance item is this ticket's own and you finish it all.                                        |
| [`references/waiting.md`](references/waiting.md)           | You park, wait on another item, a person or the coordinator, were parked by your coordinator, or hit `project_paused`.                                              | You can keep working, including while CI or tests run.                                                   |
| [`references/asking.md`](references/asking.md)             | A choice may exceed approved design or delegated bounds, carries new risk, or your open question is out of date.                                                    | The approved design or owner decision already covers the choice.                                         |
| [`references/status-moves.md`](references/status-moves.md) | You move an item with `set_status` other than closing as done, or a move is refused.                                                                                | You close with `set_status { status: "done" }` after your checks pass, or hand off with `submit_packet`. |
| [`references/ticket-types.md`](references/ticket-types.md) | Your item is Exploration, Design or Release, or an Implementation ticket marked as a rollout.                                                                       | Your item is an ordinary Implementation or Bug ticket.                                                   |
