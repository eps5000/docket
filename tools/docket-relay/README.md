# docket-relay

A small Node process on the host. When a ticket with a live lead changes from the owner side in Docket, it tells that ticket's Orca **coordinator** (owner decision 46, B55b, BUILD_SPEC §5.27). It never messages a worker's dispatch.

Docket runs in a container and can't call the host's `orca` CLI, so this bridges the two. It needs Node 22 and has no dependencies.

## What it does

1. Long-polls `GET /agent/changes/wait`, which costs no tokens.
2. Keeps the owner-side events that can change what the lead should do, and ignores agent events and housekeeping.
3. Reads the item with `GET /api/items/:id` to find its live lead. That read records no delivery, so the answer stays unread for the agent.
4. Sends the coordinator a pointer with `orca orchestration send`. It names the ticket, the kinds of change and, as information only, the implementer. It never carries their text:

   > GF-243 was updated from the owner side in Docket (acceptance, decision). The implementer, for information only: Docket run r_12, dispatch ctx_34. You're told as its coordinator, and this notice carries no owner authority. Decide whether and when to relay it, under your own gates. Don't call get_item GF-243 on the implementer's behalf, because that uses up its one-time delivery.

It never writes to Docket. It doesn't resume, park, claim, change a status or call MCP `get_item`.

**A limit to know.** An agent using the owner API is recorded as the owner, and Docket can't always tell them apart. That is why the message says "from the owner side". The relay does drop an event whose item activity shows another actor.

## Which events count

| Sent | Events |
| --- | --- |
| At once | `question.answered`, `run.resume_ready`. Anything waiting on that ticket goes in the same message. |
| After 60 s of quiet, at most 2 min after the first change | Owner edits to the title, description, outcome or acceptance; status changes, cancel, archive and unarchive; `decision.published`, `decision.confirmed`; owner notes; `review.decided`, `design_review.decided`, `resolution.decided`, `overlap.decided`, `undeclared.decided`; blocker links added or removed; an undo of any of these. |
| Never | Agent and system events (except `run.resume_ready`), housekeeping such as `problem.acknowledged` and `run.unpushed_handled`, priority-only edits, and any ticket with no live lead. |

## Who gets the message

Only a coordinator that Orca proves:

1. **The Run `worker-show` reports** for the lead's recorded `orchestrator.dispatch_id`.
2. **A stored `run_…` ID**, only when Orca doesn't know that dispatch or the run has none.
3. **Nobody:** it's recorded as undelivered (`no_target`) in `status`. Needs you is never touched.

Either Run must pass `orca orchestration run-show`: it exists, isn't a legacy Run and has been bound to a coordinator. If Orca reports a Run for the dispatch and that Run fails, the relay doesn't fall back to a stored ID. If Orca can't answer, the message waits and is retried.

**Never used, on any path:** a `dispatch:` address, because Orca can reopen a one-shot worker that finished between a check and the send, and a stored `orca_session_id:…`, because that session may be a one-shot implementer. The send call and `test-send` accept `run:` addresses only.

**Runs with no dispatch ID.** They reach a coordinator only if they stored a `run_…` ID that Orca confirms. A run that stored only a session ID, or nothing, gets no message: each change is recorded as undelivered, and its coordinator hears nothing from the relay. Claim the ticket with a dispatch ID or an Orca Run ID to be covered.

## After a stop

- **First run:** starts at the end of the feed, with no replay.
- **Stopped for under 24 hours:** catches up once, one message per ticket, within the rate limit, with no duplicates.
- **Killed mid-send:** the state records only which events were in flight, never a recipient or text. On restart the relay re-reads the lead, re-resolves the coordinator and rebuilds the fixed message. With the same facts it reuses the request ID, so Orca replays it. If the lead or coordinator changed, the old send is not made.
- **Stopped for 24 hours or more, or the position can't be trusted:** enters `hold_reconcile`.

| Hold reason | Meaning | Ways out |
| --- | --- | --- |
| `stale` | The last feed read was 24 hours or more ago, including a sleeping host or a long Docket outage | `--deliver` or `--skip-to-end` |
| `batch_past_window` | A message has been waiting 24 hours, usually because Orca was down | `--deliver` or `--skip-to-end` |
| `state_untrusted` | A state invariant failed (for example the anchor differs from the cursor), or the activity time can't be believed. `status --json` names it in `hold.detail` | `--deliver` only if every invariant holds and the feed matches, otherwise `--skip-to-end` |
| `state_unreadable` | `state.json` can't be parsed. It's kept as `state.json.corrupt-<ms>` | `--skip-to-end` |
| `cursor_ahead` | The cursor is past the end of the feed | `--skip-to-end` |
| `feed_reset` | The row at the cursor has changed, so the feed was replaced | `--skip-to-end` |

In a hold the relay **sends nothing and doesn't move its cursor**, and `start` exits with code 3. A send already in flight finishes or fails first and its result is saved before the hold is written. After that, nothing settles. Nothing leaves the hold automatically. `status` shows the reason, how many events wait on how many tickets, and their time range, with no content.

Stop the relay, then run exactly one of these:

```powershell
$app = "$env:LOCALAPPDATA\docket-relay\app"
powershell -NoProfile -ExecutionPolicy Bypass -File "$app\manage.ps1" -Action Stop
node "$app\docket-relay.mjs" status

# Queue the backlog, one message per ticket. The next start sends it within the rate limit.
node "$app\docket-relay.mjs" reconcile --deliver

# Or skip it, recording every skipped ticket and its kinds.
node "$app\docket-relay.mjs" reconcile --skip-to-end --reason "Owner reviewed the backlog"

Start-ScheduledTask -TaskName 'Docket Relay'
```

Keep the reason to one line of at most 200 characters, with no ticket text. If Docket can't be read, `reconcile` changes nothing.

`--skip-to-end` first appends one line to `reconcile-audit.jsonl` with the reason, cursors, counts, time range and **every** skipped ticket with its kinds, with no content and no cap. If that write fails, the skip doesn't happen.

## Install on Windows

Run this in PowerShell from an up-to-date checkout of `main`. It copies the tool to `%LOCALAPPDATA%\docket-relay\app`, so worktree cleanup can't remove it, and registers a per-user task at logon. It doesn't start the task.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\docket-relay\manage.ps1 -Action Install
Start-ScheduledTask -TaskName 'Docket Relay'
```

The task runs `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File launch.ps1`, which starts Node and returns its exit code, so `LastTaskResult` shows it (3 means a hold). It runs in the interactive user session so Orca stays reachable, with no elevation.

Then check it, and prove the Orca path once with a Run you coordinate:

```powershell
$app = "$env:LOCALAPPDATA\docket-relay\app"
node "$app\docket-relay.mjs" status
node "$app\docket-relay.mjs" test-send run:<your-run-id>
```

To update, run `-Action Stop` from the installed copy, then `-Action Install` from the checkout, and start the task.

### Stop, disable, verify and remove

```powershell
$manage = "$env:LOCALAPPDATA\docket-relay\app\manage.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $manage -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File $manage -Action Disable
powershell -NoProfile -ExecutionPolicy Bypass -File $manage -Action Verify -Expect Stopped   # or Disabled, Removed
powershell -NoProfile -ExecutionPolicy Bypass -File $manage -Action Remove
```

- **Stop** asks the relay over its pipe to stop new work, finish or abort its current send, save and exit, then stops the task.
- **Every action ends with a proof** of the task's state and that no relay node, launcher or child `orca.exe` remains. Processes are matched by the exact installed path in their command line, by being a child of one of those, or as an `orca.exe` send `--from docket-relay`. A `node` or `orca.exe` whose command line can't be read also fails the proof. **A failed proof exits 1.**
- **`-Force`** ends only the processes the proof matched, if a graceful stop fails.
- **Remove** deletes only the task and `%LOCALAPPDATA%\docket-relay`, including its state and audit, after the proof passes. It won't follow a link at that path, and it lists anything it couldn't delete and exits 1.

### Required checks after install

Only the real host can prove these, and the tests don't claim them:

1. **Run ownership.** `test-send run:<id>` reaches that Run's current coordinator. Orca has no closed-Run state, so `run-show` can't prove the coordinator is still running.
2. **Real Orca dedupe.** A repeated `--retry-request` UUID doesn't deliver a second message on the installed Orca version.
3. **Task Scheduler and exit codes.** `Get-ScheduledTaskInfo` shows `LastTaskResult` 3 for a relay in a hold, and its restart attempts stay harmless.
4. **Killing children.** With the task running, `Stop-ScheduledTask` alone may leave Node alive. Run `-Action Stop` and confirm its proof passes.
5. **The hidden launcher** leaves no visible window, and the task's session can reach Orca.

## Running and checking it

```text
node docket-relay.mjs start              Run in the foreground; one instance per state folder
node docket-relay.mjs stop               Finish or abort the current send, save and exit
node docket-relay.mjs status [--json]    Last event, last delivery, failures, undelivered, any hold
node docket-relay.mjs reconcile --deliver
node docket-relay.mjs reconcile --skip-to-end --reason <text>
node docket-relay.mjs test-send run:<id>   Send one fixed test message to a Run Orca confirms
```

| Setting | Default |
| --- | --- |
| `DOCKET_RELAY_URL` | `http://127.0.0.1:7420` |
| `DOCKET_RELAY_HOME` | `%LOCALAPPDATA%\docket-relay` |
| `DOCKET_RELAY_ORCA` | `orca.exe` on `PATH`, then Orca's install folder. Never `orca.cmd`, which refuses to send. |

`state.json` holds the cursor, what's waiting, what was delivered and any hold. It's written atomically. `relay.log` is capped at 256 KB with one rotation. `reconcile-audit.jsonl` is append-only. None of them holds ticket text, answers or notes; the only free text is an operator's skip reason.

- **Docket needs local trust.** In protected mode the relay has no owner session, so it records the ticket as undelivered with `needs_local_trust`.
