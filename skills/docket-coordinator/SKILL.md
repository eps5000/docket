---
name: docket-coordinator
description: Coordinate several agents against Docket. Covers choosing and dispatching ready work, writing restartable briefs, monitoring through the change feed, handling parked workers, pruning worktrees safely, and recovering after a crash. Use when you're an orchestrator, such as an Orca coordinator, a dispatch script or the owner running workers, deciding which agents work on which Docket items.
---

# Coordinating agents with Docket

**Docket records; you act.** It never launches agents, checks folders or stops processes. It tells you:

- what's ready;
- who holds what;
- what each run was told and where its work lives;
- what was left running.

You dispatch workers, create and prune worktrees, and clean up. Workers follow `docket-worker`; tell them to use it. For a PR, CI, a merge or a deploy, follow `docket-delivery`. Owning an epic? Follow `docket-producer`. Rare paths live in reference files: read one only when the table at the end says so.

**Agent files are the owner's.** Don't edit installed files (skills, references, the `AGENTS.md` / `CLAUDE.md` section, Workflow notes) or a user-level client config, and don't tell workers to. To change them, use `get_agent_files` then `propose_agent_file_change`, and tell the user. Each project's **Workflow notes** reach every worker through `get_context`, so don't repeat them in briefs.

## Spend few tokens

Every model call resends your whole context, so the cheapest turn is the one you don't take.

- **Dispatch fresh.** Start each worker as a new agent. Never fork it or let it inherit your conversation: inherited context started workers at 132k tokens instead of 24–30k.
- **Brief = item ID, worktree, branch and how to report.** Docket holds the rest.
- **Snapshot, then wait.** `get_digest { project }`, act, then block on `docket-wait` (§4). With `cursor`, the digest returns only what changed.
- **Never poll.** No `sleep` loops, and no repeated `get_changes` or `get_digest` to check on things. Park real waits and end your turn.
- **Restart instead of carrying history.** Past about **100k tokens of context**, finish what's in hand, note the cursor and start a fresh session: `get_digest` and `recovery_report` rebuild the picture from Docket.
- **Subagents return short results:** the outcome, the commit, anything blocking. Details go in Docket.

## 1. Every time you start, including after any crash or restart

1. Call `whoami`, then `list_projects` if you don't know the project key.
2. Call `recovery_report`. It's read-only and cheap. If anything is interrupted, stale, parked and ready to resume, or orphaned, handle it first (§6).
3. Call `get_digest { project }`: what to start next, bottlenecks, ready work, runs, blockers, what waits on the owner, problems, leases and conflicts in one short read. Save its `cursor`: that's your watch position (§4).
4. **Take a Docket update before dispatching,** so new worktrees get current skills. The digest or a worker's claim has an `update:` line? Read the agent-files reference.

## 2. Choosing work

- **Find candidates:** the digest's `next_work` ranks what can start by priority, tickets unlocked and age, and `bottlenecks` names unowned Inbox or Planning tickets holding up real work (shape or assign those first). For more, `search_items { project, filter: "ready_to_start" }`, and take them in order.
- **Ready means unblocked and unclaimed.** Two Ready items can still collide in code: same files, same migration. Use your judgement, and keep items from the same epic in one worker when they touch the same area.
- **Mind the owner's review queue.** If `search_items { filter: "waiting_for_review" }` is long, prefer work that doesn't add another packet.
- **Resumable work comes first:** `filter: "resumable"` is work the owner sent back.
- **Don't dispatch** items in Inbox or Planning, or items claimed by someone else.

## 3. Dispatching a worker

1. **Create the worktree:** a new branch from an up-to-date base. Record the path, branch, base ref and base SHA.
2. **Write the brief.** It's stored unchanged and re-sent after a crash, so make it self-contained about the _environment_, and leave the _item content_ to Docket:
   ```text
   Work Docket item RCP-17 using the docket-worker skill.
   Worktree: C:/work/rcp-17 · branch rcp-17-week-reload · base origin/main @ 9a10624
   Claim with claim_lead, passing this workspace, orchestrator {name:"orca", dispatch_id:"<id>"}
   and this brief verbatim. Then get_context with budget "small"; don't ask me for the requirements.
   Constraints: <tests to run, dirs not to touch, PR rules>.
   If you must wait for me, park_run with waiting_on {orchestrator:true}. Don't end silently.
   ```
   Don't copy the description or acceptance criteria into the brief: copies go stale.
3. **The worker claims** with `workspace`, `orchestrator` and `brief`. If a worker can't reach Docket, read the agent-files reference.
4. **Handing one story between small workers?** Give every worker the same `producer` on `claim_lead`. A release then hands it on without it returning to Ready. To give it up, pass `release_story: true`.

## 4. Waiting: docket-wait, not polling

Block in one shell call. It spends no model tokens until a matching event arrives, and it rides out a Docket restart:

```bash
bash .claude/docket-wait.sh --cursor <cursor> --project RCP --timeout 540 \
  --types run.parked,run.park_expired,run.wait_flagged,run.resume_ready,run.activity,question.asked,packet.submitted,review.decided,run.ended,lease.ended
```

- **Where it is:** next to `docket-check` (`.codex/` for Codex). On Windows without bash: `powershell -NoProfile -ExecutionPolicy Bypass -File .claude/docket-wait.ps1`, with the same flags.
- **Set your shell tool's timeout above `--timeout`,** or run it as a background command that wakes you when it exits.
- **It prints** `changed cursor=<n> events=<k>`, then one line per event. Exit 0 is changed, 2 is timed out (wait again with the printed cursor), 1 is an error.
- **Then** act on those lines, or call `get_digest { project, cursor }` for what changed, and wait again with the new cursor.
- **No shell?** `get_changes { cursor, wait_s: 45 }` holds the call for up to 45 seconds.

| Event                                                                | What it means for you                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `claim.rejected`                                                     | Two workers raced for one item. Re-assign the loser.                                       |
| `run.parked`, `run.park_expired`, `run.wait_flagged`, `run.activity` | A parked or silent worker needs a look. Read the parked-workers reference.                 |
| `run.resume_ready`                                                   | Its blockers cleared. **You** tell that dispatch to continue (§5).                         |
| `lease.ended`                                                        | With `end_reason: expired`, your worker's part lease ran out. It takes it again to go on.  |
| `question.asked`                                                     | Owner input is needed. **Don't answer for the owner**; that worker's dependent work waits. |
| `packet.submitted`                                                   | Handed to the owner. The worker should finish its run.                                     |
| `review.decided`                                                     | Changes requested? The item becomes `resumable`; dispatch it again.                        |
| `run.ended`                                                          | Check the item's status and the workspace state before reusing or pruning anything.        |

For a detailed look at one worker, use `get_item { id, view: "summary" }`. Don't loop over items reading them in full.

## 5. Parked workers

- **When a worker has to wait for you,** it parks with `waiting_on: { orchestrator: true }`. It keeps its claim, and its worktree counts as **in use**. Send it work when you're ready; its next write un-parks it.
- **`run.resume_ready`:** Docket **can't push into a session and hasn't told the worker.** Send its recorded dispatch the event's `instruction`: continue under the same `run_id`, `heartbeat` first, don't claim.
- **A paused project** (`paused:` in `get_digest`): don't dispatch or resume there. Only the owner lifts it.
- **Never answer for the owner,** and never push work on a canceled item: that's the owner's call.
- Fixing a run's status, time-limited parks, wait flags, splits and anything else: read the parked-workers reference.

## 6. Pruning and crash recovery

**Before pruning any worktree or killing any process:**

1. Call `recovery_report`.
2. **Prune only workspaces in `safe_to_prune`.** Never prune `in_use`, `parked` or `at_risk`, and treat `unknown` as not safe. **Idle is not finished.**
3. Stop every entry in `orphaned_resources`, using its locator.

**A Docket restart alone needs no re-dispatch.** Open runs keep their claim, and each worker's next call with its `run_id` continues.

**After a crash (yours or a worker's),** or with interrupted, stale or parked entries to re-dispatch: read the crash-recovery reference. Never rebuild a brief from memory, and never edit lines inside a stored brief.

## Owner-only (don't do these for the owner)

- Answering `ask_owner` questions, and making review decisions.
- Approving or declining proposed changes to agent files and Workflow notes, and the drift remedies (_Adopt_, _Restore_, _Keep local_).
- Moving items to Ready, unless the project's `AGENTS.md` says agents may.
- Reviewing an onboarding, and creating projects in Settings, changing their settings or deleting them.
- Confirming or withdrawing owner decisions.
- Releasing another worker's live claim. Only the owner can release a stale one, from the UI.

## Never

- Poll in a `sleep` loop, or fork a worker.
- Treat an idle worktree or terminal as finished. Check its workspace state.
- Rebuild a brief from memory when Docket has it.
- Leave a process, dev server or session running without a declared resource.
- Run two workers on one item. Use subagents under one lead instead (`docket-lead-subagents`).

## References

| File                                                           | Read when                                                                                                                                     | Don't read when                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`references/parked-workers.md`](references/parked-workers.md) | A worker is parked, silent or flagged, a park ran out, a run's status is wrong, or a blocker holds only part of a story.                      | Your workers are live and nothing in the digest is parked or flagged. |
| [`references/crash-recovery.md`](references/crash-recovery.md) | After a crash or restart, `recovery_report` lists interrupted, stale, parked or orphaned entries, or work is left in an ended run's worktree. | `recovery_report` lists nothing to act on.                            |
| [`references/agent-files.md`](references/agent-files.md)       | An `update:` line appears, a worker can't reach Docket or lacks `docket-worker`, or a run shows "edited locally".                             | The agent files are installed, current and unedited.                  |
| [`references/onboarding.md`](references/onboarding.md)         | The owner asks you to set up a project or onboard a repo into one.                                                                            | The project is already onboarded and you're dispatching work.         |
