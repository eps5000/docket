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

You dispatch workers, create and prune worktrees, and clean up. Workers follow `docket-worker`; tell them to use it.

**Agent files.** The owner installs the skills and the project's `AGENTS.md` / `CLAUDE.md` section from Agent files (_Install into <project>'s repo_, by a copy-paste command or into a mounted folder), and the install log shows which versions each repo got. If a worker doesn't have `docket-worker`, or can't reach Docket, ask the owner to install the agent files there: the install also writes the repo's connection file, so a worker started in that repo connects once the client's one-time approval is given. Paste the skill into the brief only as a last resort. Each project's **Workflow notes** reach every worker through `get_context`, so don't repeat them, or the `AGENTS.md` rules, in briefs. To change these instructions, use `get_agent_files` then `propose_agent_file_change`, and tell the user you've proposed it for the owner's approval. Don't edit installed files directly, and don't tell workers to.

**Instructions changed outside Docket.** Workers pass the `docket-check` output as `instructions` on `claim_lead` (the worker skill says how), and Docket also checks folders it installed into. When an installed skill or the Docket section was edited, deleted or added by hand, the owner sees "… edited outside Docket" under Problems, and the run shows "edited locally". The remedies are the owner's, in Agent files: _Adopt_ (save the local text as the project's copy, or the default), _Restore Docket's version_ (reinstall), or _Keep local_ (accept it; a further change alerts again). Mention it to the owner when a worker hits it; don't restore or overwrite the files yourself.

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
3. Call `get_digest { project }`: ready work, runs, blockers, what waits on the owner, problems, leases and conflicts in one short read. Save its `cursor`: that's your watch position (§4).

## 2. Choosing work

- **Find candidates:** the digest's `ready` section lists the top items. For more, `search_items { project, filter: "ready_to_start" }`. Results are sorted by priority, then by how many items each would unblock, so take them in order.
- **Ready means unblocked and unclaimed.** Two Ready items never block each other in Docket. They can still collide in code, though: same files, same migration. Use your judgement, and keep items from the same epic in one worker when they touch the same area.
- **Mind the owner's review queue.** If `search_items { filter: "waiting_for_review" }` is long, prefer work that doesn't add another packet, such as items with no human review. The owner's attention is the scarcest resource.
- **Resumable work comes first:** `filter: "resumable"` is work the owner sent back.
- **Don't dispatch** items in Inbox or Planning, or items claimed by someone else. You'd only get `validation` or `conflict`.

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
   Don't copy the description or acceptance criteria into the brief. They live in Docket, and copies go stale.
3. **The worker claims** with `workspace`, `orchestrator` and `brief`. If a worker can't reach Docket, claim on its behalf with the same fields, and give it the `run_id`.

## 4. Waiting: docket-wait, not polling

Block in one shell call. It spends no model tokens until a matching event arrives, and it rides out a Docket restart:

```bash
bash .claude/docket-wait.sh --cursor <cursor> --project RCP --timeout 540 \
  --types run.parked,question.asked,packet.submitted,review.decided,run.ended
```

- **Where it is:** next to `docket-check` (`.codex/` for Codex, `~/.claude/` for a user-wide install). On Windows without bash: `powershell -NoProfile -ExecutionPolicy Bypass -File .claude/docket-wait.ps1`, with the same flags.
- **Set your shell tool's timeout above `--timeout`,** or run it as a background command that wakes you when it exits.
- **It prints** `changed cursor=<n> events=<k>`, then one line per event. Exit 0 is changed, 2 is timed out (wait again with the printed cursor), 1 is an error.
- **Then** act on those lines, or call `get_digest { project, cursor }` for what changed, and wait again with the new cursor.
- **No shell?** `get_changes { cursor, wait_s: 45 }` holds the call for up to 45 seconds. Clients cut tool calls off at 60 seconds, so it can't go longer.

Watch for:

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
- **Parked on items:** `get_digest` and `recovery_report` show `resume_ready` once those items clear. Resume it promptly: after 30 minutes the owner sees "ready to resume, unattended".
- **Parked for over 24 hours:** it comes to you first, in `get_digest` problems. Resume it, or have it `release_lead`. Left for a day, it reaches the owner.
- **Work left in an ended run's worktree** comes to you the same way. Commit and push it, or say it can go. Never push work on a canceled item: that's the owner's call.

## 6. Pruning and crash recovery

**Before pruning any worktree or killing any process:**

1. Call `recovery_report`.
2. **Prune only workspaces in `safe_to_prune`.** Never prune `in_use`, `parked` or `at_risk`, and treat `unknown` as not safe. **Idle is not finished.**
3. Stop every entry in `orphaned_resources`, using its locator. The resumed run, or the owner, marks it released. (A resource only counts as orphaned 15 minutes after its run ended. Right after a crash, look at the interrupted runs' own unreleased `run.resources` too.)

**A Docket restart alone needs no re-dispatch.** Open runs keep their claim, and each worker's next call with its `run_id` continues. Leave a `stale` run whose `lease_expires_at` is still ahead: if it never returns, the lease ends it and it shows as interrupted.

**After a crash (yours or a worker's):** call `recovery_report { include_briefs: true }`. Then, for each interrupted entry, and each stale entry whose lease has run out:

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

## 7. Onboarding a project

When the owner asks you to set up a project, or to onboard a repo into one (decision 31):

1. **If the project has Jira tickets,** ask the owner to run the Jira import first (Settings → Projects). Onboarding then enriches those tickets instead of duplicating them.
2. **Call `onboard_project { key, name }`.** It creates the project (`name` is needed then) or adopts the existing one, and returns a `session_id`, what the project already holds, and the guide. Follow the guide step by step; it needs no installed files.
3. **Do it in one session, as one client.** Another agent's `onboard_project` on the same project is refused while yours is in progress. Your own reconnect gets the same session back. Subagents may read the repo, but you make the Docket calls.
4. **Nothing goes to Ready.** Everything stays in Inbox or Planning; `set_status` "ready" is refused until you finish. Don't dispatch workers on it: the owner reviews first.
5. **Finish with `finish_onboarding { session_id, summary, questions }`,** then stop. The owner reviews it all from one card, approves the Workflow notes and installs the agent files. Running it again later is safe: the guide matches what's already there.

## Owner-only (don't do these for the owner)

- Answering `ask_owner` questions, and making review decisions.
- Approving or declining proposed changes to agent files and Workflow notes, and the drift remedies (_Adopt_, _Restore_, _Keep local_).
- Moving items to Ready, unless the project's `AGENTS.md` says agents may.
- Reviewing an onboarding, and creating projects in Settings, changing their settings or deleting them.
- Confirming or withdrawing owner decisions.
- Releasing another worker's live claim. Only the owner can release a stale one, from the UI.

## Never

- Wait in a `sleep` loop, or fork a worker from your own conversation.
- Treat an idle worktree or terminal as finished. Check its workspace state.
- Rebuild a brief from memory or chat history when Docket has it.
- Leave a process, dev server or session running without a declared resource.
- Run two workers on one item. Use subagents under one lead instead (`docket-lead-subagents`).
