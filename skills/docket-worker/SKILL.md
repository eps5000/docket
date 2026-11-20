---
name: docket-worker
description: Work one Docket item end to end through the docket MCP server. Covers finding and claiming work, getting context, planning, recording progress and evidence, waiting the right way, and handing off or closing. Use whenever you're asked to work on a Docket item (an ID like RCP-14), pick up ready work, or resume work the owner sent back.
---

# Working a Docket item

Docket enforces claims, dependencies and review gates for you. This skill is the **efficient order of calls** and the habits that keep your runs cheap and recoverable.

The project has its own rules: who moves work to Ready, when human review is needed, the branch naming, the checks to run. They're in the project's **Workflow notes**, which `get_context` gives you as its `workflow:` section; the repo's `AGENTS.md` / `CLAUDE.md` (the Docket section, installed from Agent files) points you there. Where they differ from this skill, they win.

**Asked to onboard a repo or set up a project?** That isn't item work: call `onboard_project` and follow the guide it returns (`docket-coordinator` §7 has the gist).

## 1. Start: four calls or fewer

1. **Find work:**
   - **Given an item ID?** Skip the search.
   - **Otherwise:** `search_items { project, filter: "resumable" }` first. That's work sent back to you, and it comes before new work. **If it returns anything, take the first result** and claim it. Don't inspect candidates with `get_item` first: `get_context` after the claim tells you everything.
   - **Only if nothing is resumable:** `search_items { project, filter: "ready_to_start", limit: 5 }`, and take the first result. Ready work is already sorted by priority, then by how much it unblocks.
2. **Claim it:** `claim_lead`, with:
   - `agent_label`: your worker name, if you have one;
   - `workspace`: `repo`, `path` (your worktree), `branch`, `base_ref`, `base_sha`;
   - `branch`: the branch you'll work on, so the conflict radar can trial-merge it;
   - `brief` and `orchestrator`: if a coordinator dispatched you, the brief text exactly as you received it, plus its IDs;
   - `instructions`: the output of the installed `docket-check`, so the owner knows which instructions you work from. Run it once per session, before your first claim, in one shell call: `bash .claude/docket-check.sh` (`.codex/` for Codex, `~/.claude/` for a user-wide install; on Windows without bash, `powershell -NoProfile -ExecutionPolicy Bypass -File .claude/docket-check.ps1`). It prints one line of JSON: pass it as it is, and reuse it for later claims in the session. No script there? Skip it.

   Keep the returned `run_id`, and **pass it on every call from now on**. That's what keeps your claim alive.

   If you get `conflict`, someone else holds the item. Pick another one. Never retry in a loop, and never work on an item you haven't claimed.

   If you get `seam_conflict`, the item changes a shared part (a table, model, endpoint or shared file) that another item in flight also changes. The owner has been asked whether they can run together. **Pick other work** from `ready_to_start` and leave this item; don't wait, and don't work on it.

   **Given a `run_id` by your coordinator** (you're resuming a parked run after a crash)? Don't claim. Pass that `run_id` on your first call, for example `heartbeat { run_id, note: "Resuming" }`. That resumes the run with its claim, workspace and brief. Then continue from step 3.

3. **Get context:** `get_context { id }`. One call gathers the outcome, the acceptance criteria, the decisions you must follow, the epic and label briefs, blockers, the shared parts this item and other in-flight items will change, the project's Workflow notes and planning docs. Follow the Workflow notes like the project's `AGENTS.md`.

`whoami` isn't needed to start: `claim_lead` returns your lease's expiry. Call it once only when you need your client name or the windows (`lease_s`, `stale_after_s`).

**Then, only if needed:**

- `get_item { id }`: when the context shows unread owner notes or an answered question, or when you're resuming. It delivers notes, answers and review decisions **once**, so read them.
- `get_review { id }` first: when resuming work the owner sent back. Their "changes" notes are already steps in your checklist.

## 2. Plan

- **`set_plan`:** 3–8 one-line steps, each a verifiable piece of progress. Steps aren't tickets. Create a new item only when a piece needs its own blocker, owner or review.
  - The first plan sends `steps: [{ text }, …]` only. Docket assigns the step IDs and returns them; use those with `update_step`. Never make up an ID: an unknown one is refused.
  - **Keep each step's `text` to one line.** Context a step needs (reproduction steps, file paths, what done looks like) goes in its `details` (Markdown), and where it came from in `source` (for example a Jira key): `steps: [{ text, details, source }, …]`. Like the rest of the plan, details patch: leave them out to keep them, send `null` to clear them.
- **`set_checks`:** what you'll verify yourself, stated concretely. For example "Planner unit tests pass" or "Reload keeps the selected week (e2e)", never "it works".
- **Human review:** if the project rules say this item needs it and none is declared, `declare_human_review` now. Write plain instructions the owner can follow in minutes. See `docket-review-packet`.
- **Changing the plan later:** patch it, and give a `reason`. Send only the steps that change. Don't silently drop a step: mark it `skipped`, with a note.

## 3. The loop, per step

1. `update_step { step_id, state: "current" }`. If `get_item` shows the step with `· details`, read them first with `get_step { id, step_id }`. (`get_context` already includes the current step's details; a `…truncated` line there means read the rest with `get_step`.)
2. Do the work. Found something the next agent needs for this step? Add it to the step's details: `update_step { step_id, state, details }`.
3. Commit, **push**, then `report_commit { sha, branch, pushed: true }`. Push work in progress at every step: a pushed commit survives a crash or a pruned worktree; an unpushed one may not.
4. `update_check` as checks pass or fail, with evidence: the command and its result, one line.
5. `update_step { state: "done" }`.

**Shared parts along the way:**

- **Change a shared part you didn't declare?** Add it now with `declare_shared_changes` (the whole list: it replaces the declaration). Name parts by their keys from `list_shared_parts`.
- **Declaring shared changes?** Pass `branches`, every branch the work is on (or `branch` for one), every time, also when you backfill a declaration for work already in progress. The list replaces the item's branches, and the conflict radar checks each one.
- **Single-writer parts** (such as a migrations snapshot): `take_lease { id, part }` **before** you generate or edit it, and `release_lease` as soon as the change is committed and pushed. If you get `lease_held`, work on another step or item; call `take_lease` again later. Never wait in a loop.
- **`problems:` in your context, or a "Docket's conflict radar" note,** is yours to fix first: it says what's wrong, what fixes it and who acts. Fix routine ones without asking: rebase a branch that's out of date with main, or drop an old draft branch from the item's branches with `declare_shared_changes`. Docket records both on the item. You have about a day before the owner sees it.
- **A fix that changes the plan** (split the work, change its scope or its order): `propose_resolution { problem, kind, plan_md, reason }` with the problem's ID from your context, then work on what doesn't depend on it. The owner's choice arrives as a note and in `get_context` `resolutions:`. After "go a different way", follow the note and propose again if you need to.

**Along the way:**

- **Stay live.** Any call with `run_id` renews your lease. In a long stretch with nothing to record, send `heartbeat { run_id, note }`, well inside `stale_after_s`.
- **Pausing with uncommitted changes?** Send `heartbeat { workspace: { dirty: true } }` first.
- **Started something long-lived?** That means a dev server, a session, a container, a temp directory or a held port. Declare it with `heartbeat { resources_started: [{ kind, label, locator }] }`, and keep the `rsc_…` IDs. The locator must be precise enough for someone else to find it: a port, a pid, a session ID or a path.
- **Something the owner should know?** A surprise, a choice you made, a risk: `add_note`, in one or two sentences.
- **Decisions.** Follow the decisions `get_context` gave you; owner decisions are authoritative. If you set a convention other agents must follow (an interface, a naming rule, a library choice), record it with `publish_decision`, scoped as narrowly as it applies. To challenge an owner decision, use `ask_owner`. Never work around it.

## 4. When you can't carry on

| Situation                                            | Do this                                                                                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| You need a product decision                          | `ask_owner`: one question, the options you see, and your recommendation. Stop the work that depends on it. If you're ending the session, `finish_run` with a summary saying what you're waiting for. |
| You're waiting for another item to land              | `park_run { reason, waiting_on: { items: [...] } }`                                                                                                                                                  |
| You're waiting for the coordinator to send more work | `park_run { reason, waiting_on: { orchestrator: true } }`                                                                                                                                            |
| A single step is blocked                             | `update_step { state: "blocked", note }`, and carry on with other steps                                                                                                                              |
| You're stopping before the work is done              | Push, `report_commit`, release your resources, then `release_lead { reason }`. The item goes back to Ready with your plan kept.                                                                      |
| Something broke and you can't continue               | `finish_run { result: "failed", error }`                                                                                                                                                             |
| A write returns `conflict`                           | Read `current` in the error. Re-apply your change only if it still makes sense.                                                                                                                      |

**Never just go quiet.** A silent run looks stale and loses its claim. A parked run keeps it, and its worktree is protected from pruning. Any later call with your `run_id` un-parks you.

## 5. Finish

1. **Push everything** and report every commit with `pushed: true`.
2. **Release every resource** you declared: `heartbeat { resources_released: [{ resource_id }] }`.
3. **Then hand off or close,** passing `changed_files` (the output of `git diff --name-only <main>...HEAD`) and `branch` either way:
   - **No human review items:** once the checks pass, `set_status { status: "done", changed_files, branch }`. That also finishes your run.
   - **Human review declared:** `submit_packet` (see `docket-review-packet`) with `changed_files` and `branch`, then `finish_run { result: "finished", summary }`.
   - Files that belong to shared parts the item didn't declare hold the hand-off for the owner: `submit_packet` returns `held_undeclared`, and `set_status` fails with `not_declared`. Leave the item as it is; the owner decides.
   - Handing off or closing ends your leases.
4. **Treat `finish_run` warnings as mistakes to fix.** For example `! 2 commits not pushed` or `! 1 resource still declared`. Each one leaves your workspace marked at risk.
5. **A commit after handing off?** Still `report_commit` it. If an open packet was built from an older commit, it's marked out of date for the owner.

## Changing these instructions

To change these instructions, use `get_agent_files` then `propose_agent_file_change`, and tell the user you've proposed it for the owner's approval. Don't edit installed files directly. That covers this skill, the Docket section of `AGENTS.md` / `CLAUDE.md` and the project's Workflow notes (`workflow`), even when the user asks you to edit them:

- read the file first, `get_agent_files { project, file }`, and change that text, not your installed copy;
- send the whole new text, the `version_id` you read as `based_on_version_id`, and a one-line `reason`;
- nothing changes until the owner approves; carry on with the current instructions.

## Token habits

- **Read once.** Call `get_context` once per item. Don't re-read the item after each write: mutation results already carry the new version.
- **Read small:**
  - `get_item { view: "summary" }` for status checks;
  - `fields: [...]` to trim reads further;
  - `get_changes` with a cursor to watch for updates, instead of polling `get_item`.
- **Write small.** `set_plan`, `set_checks` and `update_item` patch, so send only what changed.
- **Pass an `idempotency_key`** on any write you might retry after a timeout.
- **Keep text short:**
  - steps: one line, with longer context in their `details`;
  - notes: one or two sentences;
  - evidence: the command and its result.
- **Never paste secrets.** The write is rejected and nothing is stored.

## Don't

- Work on an item you haven't claimed, or one someone else holds.
- Create tickets for checklist steps.
- Close with `set_status` while human review items are undecided. It fails; use `submit_packet`.
- Move items to Ready unless the project rules allow it.
- Edit installed skill files or the Docket section of `AGENTS.md` / `CLAUDE.md`. Propose the change instead.
- Leave a dev server, session or container running without declaring it.
- Keep state only in your own memory or chat. Docket is the record, and the next agent starts from it.
