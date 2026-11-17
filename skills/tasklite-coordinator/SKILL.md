---
name: tasklite-coordinator
description: Coordinate several agents against Task Lite. Covers choosing and dispatching ready work, writing restartable briefs, monitoring through the change feed, handling parked workers, pruning worktrees safely, and recovering after a crash. Use when you're an orchestrator, such as an Orca coordinator, a dispatch script or the owner running workers, deciding which agents work on which Task Lite items.
---

# Coordinating agents with Task Lite

**Task Lite records; you act.** It never launches agents, checks folders or stops processes. It tells you:

- what's ready;
- who holds what;
- what each run was told and where its work lives;
- what was left running.

You dispatch workers, create and prune worktrees, and clean up. Workers follow `tasklite-worker`; tell them to use it.

## 1. Every time you start, including after any crash or restart

1. Call `whoami`, then `list_projects`.
2. Call `recovery_report`. It's read-only and cheap. If anything is interrupted, stale, parked and ready to resume, or orphaned, handle it first (§6).
3. Call `get_changes` with no cursor, and save the returned `next_cursor`. That cursor is your watch position (§4).

## 2. Choosing work

- **Find candidates:** `search_items { project, filter: "ready_to_start" }`. Results are sorted by priority, then by how many items each would unblock, so take them in order.
- **Ready means unblocked and unclaimed.** Two Ready items never block each other in Task Lite. They can still collide in code, though: same files, same migration. Use your judgement, and keep items from the same epic in one worker when they touch the same area.
- **Mind the owner's review queue.** If `search_items { filter: "waiting_for_review" }` is long, prefer work that doesn't add another packet, such as items with no human review. The owner's attention is the scarcest resource.
- **Resumable work comes first:** `filter: "resumable"` is work the owner sent back.
- **Don't dispatch** items in Inbox or Planning, or items claimed by someone else. You'd only get `validation` or `conflict`.

## 3. Dispatching a worker

1. **Create the worktree:** a new branch from an up-to-date base. Record the path, branch, base ref and base SHA.
2. **Write the brief.** It's stored unchanged and re-sent after a crash, so make it self-contained about the _environment_, and leave the _item content_ to Task Lite:
   ```text
   Work Task Lite item RCP-17 using the tasklite-worker skill.
   Worktree: C:/work/rcp-17 · branch rcp-17-week-reload · base origin/main @ 9a10624
   Claim with claim_lead, passing this workspace, orchestrator {name:"orca", dispatch_id:"<id>"}
   and this brief verbatim. Then get_context; don't ask me for the requirements.
   Constraints: <tests to run, dirs not to touch, PR rules>.
   If you must wait for me, park_run with waiting_on {orchestrator:true}. Don't end silently.
   ```
   Don't copy the description or acceptance criteria into the brief. They live in Task Lite, and copies go stale.
3. **The worker claims** with `workspace`, `orchestrator` and `brief`. If a worker can't reach Task Lite, claim on its behalf with the same fields, and give it the `run_id`.

## 4. Monitoring: the change feed, not polling

Call `get_changes { cursor, types: [...] }`, then save the new `next_cursor`. Watch for:

| Event                                     | What it means for you                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `claim.rejected`                          | Two workers raced for one item. Re-assign the loser.                                       |
| `run.parked`                              | A worker is waiting on purpose. Leave it, and send work when you're ready.                 |
| `question.asked`                          | Owner input is needed. **Don't answer for the owner**; that worker's dependent work waits. |
| `packet.submitted`                        | Handed to the owner. The worker should finish its run.                                     |
| `review.decided`                          | Changes requested? The item becomes `resumable`; dispatch it again.                        |
| `run.ended`                               | Check the item's status and the workspace state before reusing or pruning anything.        |
| `resource.declared` / `resource.released` | Track what's running on the host.                                                          |

For a detailed look at one worker, use `get_item { id, view: "summary" }`. Don't loop over items reading them in full.

## 5. Parked workers

- **When a worker has to wait for you,** it calls `park_run { waiting_on: { orchestrator: true } }`. It keeps its claim, and its worktree counts as **in use**.
- **When you're ready,** send it more work. Its next call un-parks it.
- **Parked on items:** `recovery_report` shows `resume_ready: true` once those items clear. Resume it promptly: after 30 minutes the owner sees "ready to resume, unattended".
- **Parked for over 24 hours:** the owner sees it under Problems. Resume it, or have it `release_lead`.

## 6. Pruning and crash recovery

**Before pruning any worktree or killing any process:**

1. Call `recovery_report`.
2. **Prune only workspaces in `safe_to_prune`.** Never prune `in_use`, `parked` or `at_risk`, and treat `unknown` as not safe. **Idle is not finished.**
3. Stop every entry in `orphaned_resources`, using its locator. The resumed run, or the owner, marks it released. (A resource only counts as orphaned 15 minutes after its run ended. Right after a crash, look at the interrupted runs' own unreleased `run.resources` too.)

**After a crash (yours, a worker's or Task Lite's):** call `recovery_report { include_briefs: true }`. Then, for each interrupted or stale entry:

Skip entries with no workspace and no brief: you didn't dispatch them, so leave them to the owner.

1. **Find the code:**
   - if the worktree at `workspace.path` still exists, reuse it;
   - if it's gone, recreate it from `pushed_sha` on its `branch`;
   - if `dirty` was true or `head_sha` was ahead of `pushed_sha`, work may be lost. Say so in the new brief. The owner already sees it under Problems.
2. **Re-dispatch** with the **stored brief, unchanged**, plus: "Resume from the checklist: `claim_lead` first, then `get_context` and `get_item`." Have the worker pass `brief_document_version_id` from the report rather than the text, so the same stored version is reused instead of copied. Start the new prompt with the stored brief exactly as the report gives it, and put everything you add (the resume line, the lost-work warning) after it. Never edit lines inside it.
3. **Clean up** that run's unreleased resources: everything in its `run.resources` that has no `released_at`.

**For parked entries:** a parked run keeps its claim through a crash, so a new worker's `claim_lead` would get `conflict`.

- If `resume_ready` is true and the worker's process is still alive, send it more work.
- If the process is gone, re-dispatch a worker with the parked run's **`run_id`** from the report, and tell it: "Don't claim. Continue under run `<run_id>`: your first call with it resumes the parked run; then `get_context` and `get_item`."
- Otherwise leave it: it's waiting on purpose.

**Finally,** call `recovery_report` again. Nothing interrupted should be left un-dispatched, and nothing should be orphaned.

## Owner-only (don't do these for the owner)

- Answering `ask_owner` questions, and making review decisions.
- Moving items to Ready, unless the project's `AGENTS.md` says agents may.
- Confirming or withdrawing owner decisions.
- Releasing another worker's live claim. Only the owner can release a stale one, from the UI.

## Never

- Treat an idle worktree or terminal as finished. Check its workspace state.
- Rebuild a brief from memory or chat history when Task Lite has it.
- Leave a process, dev server or session running without a declared resource.
- Run two workers on one item. Use subagents under one lead instead (`tasklite-lead-subagents`).
