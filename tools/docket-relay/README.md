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

## Docket producer continuation (DKT-38)

The optional continuation lane is separate from the owner-change pointer above. It is off until an operator places a reviewed `continuation-config.json` in the relay state folder. Only exact `DKT-*` Epic producers are eligible. A mapping names the Docket lead run and its original Dispatch, the Orca parent Run, the existing producer worktree identity, and `codex` as the agent. Example shape (replace every identifier with a freshly verified value):

```json
{"version":1,"mappings":[{"epic":"DKT-3","docket_run_id":"run_...","dispatch_id":"ctx_...","orca_run_id":"run_...","workspace_id":"<repo-id>::C:/exact/producer/worktree","agent":"codex"}]}
```

Each minute the relay reads the current Docket roster, project pause, exact Epic and lead, original Orca Dispatch, and exhaustive same-Run Orca workers. It acts only after a named coordinator wake is due with no additional item or time conditions, the exact lead claim remains parked, the project is not paused, no owner decision or unanswered question holds it, the original Dispatch is completed with capability revoked, and the Docket and Orca worktree/Run identities match. A current worker in that worktree suppresses a new start and triggers an escalation if the wake remains unacknowledged for five minutes. Settled workers with unverifiable liveness need exact Orca proof of revoked capability and absent process and terminal resources before a new start. Unknown or inconsistent custody fails closed. Gameflow is never eligible.

Before starting, it durably saves the wake intent. It asks Orca for **one** fresh follow-up in the same existing worktree and same Orca Run with a stable `--retry-request` ID. It retries an unconfirmed start at most three times (first attempt, then after 1 and 2 minutes); a crash reuses the same ID. The follow-up prompt explicitly requires fresh claim/admission review and carries no owner or host authority. A verified fresh Dispatch is the delivery receipt. A later Docket run transition or revised park is the continuation acknowledgement. If that acknowledgement is absent for five minutes, or three starts fail, the lane sends an idempotent `escalation` to the exact parent Orca Run and records it in `status`; it never starts another worker for the same wake. Three bounded escalation sends are attempted, with failure still visible in state. No claim or resource is released, no automation is changed, and no helper or Gameflow process is touched.

`status --json` shows each mapped run's state, attempt count, fresh Dispatch receipt and escalation reason. Stop the relay and preserve its state before changing the reviewed mapping or installing new bytes. A new Docket producer run needs a newly reviewed exact mapping; a stale mapping is a hold, not a wildcard.

**A limit to know.** An agent using the owner API is recorded as the owner, and Docket can't always tell them apart. That is why the message says "from the owner side". The relay does drop an event whose item activity shows another actor.

## Which events count

| Sent | Events |
| --- | --- |
| At once | `question.answered`, `run.resume_ready`. Anything waiting on that ticket goes in the same message. |
| After 60 s of quiet, at most 2 min after the first change | Owner edits to the title, description, outcome or acceptance; status changes, cancel, archive and unarchive; `decision.published`, `decision.confirmed`; owner notes; `review.decided`, `design_review.decided`, `resolution.decided`, `overlap.decided`, `undeclared.decided`; blocker links added or removed; an undo of any of these. |
| Never | Agent and system events (except `run.resume_ready`), housekeeping such as `problem.acknowledged` and `run.unpushed_handled`, priority-only edits, and any ticket with no live lead. |

## Who gets the message

**Only the Run that `worker-show` reports for the lead's recorded `orchestrator.dispatch_id`.** Anything else is recorded as undelivered (`no_target`) in `status`, and Needs you is never touched. If Orca can't answer, the message waits and is retried.

The relay never sends to a `dispatch:` address, because Orca can reopen a one-shot worker that finished between a check and the send. It never uses a stored Run ID or session address. The send call and `test-send` accept `run:` addresses only.

**Runs with no dispatch ID get no message.** Each change on them is recorded as undelivered. A later batch for session addresses will restore that coverage.

## Accepted limits

- **`test-send` goes to whatever Run the operator names.** It's a manual operator command, and nothing checks that the Run is the right one.
- **Delivery is at-least-once, coalesced where possible.** A rare crash or reconcile can repeat a pointer. A pointer only says "go look" and carries no authority.
- **Forged state files are outside the threat model.** The state folder is private to this user.

## After a stop

- **First run:** starts at the end of the feed, with no replay.
- **Stopped for under 24 hours:** catches up once, one message per ticket, within the rate limit.
- **Killed mid-send:** the state records only which events were in flight. On restart the relay re-reads the lead, re-resolves the coordinator and rebuilds the message. The Orca request ID comes from the batch and recipient alone. Orca replays an identical repeat and refuses changed text with `request_mismatch`, which the relay counts as already sent. If the coordinator changed, the new one is told.
- **Stopped for 24 hours or more, or the position can't be trusted:** enters `hold_reconcile`.

| Hold reason | Meaning | Ways out |
| --- | --- | --- |
| `stale` | The last feed read was 24 hours or more ago, including a sleeping host or a long Docket outage | `--deliver` or `--skip-to-end` |
| `batch_past_window` | A message has been waiting 24 hours, usually because Orca was down | `--deliver` or `--skip-to-end` |
| `state_untrusted` | A state invariant failed (for example the anchor differs from the cursor, or a seen key is ahead of it), or the activity time can't be believed. `status --json` names it in `hold.detail` | `--deliver` only if every invariant holds and the feed matches, otherwise `--skip-to-end` |
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

- **Stop** asks the relay over its pipe to stop new work, finish or abort its current send, save and exit, then waits for it. If it doesn't exit in time, Stop reports failure and changes nothing else. **Nothing ever kills a process.**
- **The relay is identified only by the PID it records at start** in `instance.json`, together with that process's start time and its exact executable and script path. Any other process, including one with a reused PID or one that can't be read, is neither touched nor counted. So `Verify` doesn't see a relay started by hand with a relative path, though `Stop` still reaches it over the pipe.
- A child `orca.exe` isn't tracked. Once the recorded PID is gone, Stop waits out the 20-second Orca call timeout.
- **Every action ends with a proof** of the task's state and that the recorded relay is gone. **A failed proof exits 1.**
- **Remove** unregisters the task, then deletes only the known file names in the app and state folders, then those folders if they're empty. It never deletes recursively. If any entry is a link or isn't a known relay file, it deletes no file, lists the entry and exits 1.

### Required checks after install

Only the real host can prove these, and the tests don't claim them:

1. **Run ownership.** `test-send run:<id>` reaches that Run's current coordinator. Orca has no closed-Run state, so a Run reported for a dispatch may have no running coordinator.
2. **Real Orca dedupe.** A repeated `--retry-request` UUID doesn't deliver a second message on the installed Orca version, and changed text under it returns `request_mismatch`.
3. **Task Scheduler and exit codes.** `Get-ScheduledTaskInfo` shows `LastTaskResult` 3 for a relay in a hold, and its restart attempts stay harmless.
4. **Graceful stop on the real task.** `-Action Stop` passes its proof, and the task leaves `Running` by itself.
5. **An orphaned `orca.exe`.** The relay enforces the 20-second limit on its own child, so after a hard kill of the relay, confirm the child also ends within that wait.
6. **The hidden launcher** leaves no visible window, and the task's session can reach Orca.

## Running and checking it

```text
node docket-relay.mjs start              Run in the foreground; one instance per state folder
node docket-relay.mjs stop               Finish or abort the current send, save and exit
node docket-relay.mjs status [--json]    Last event, last delivery, failures, undelivered, any hold
node docket-relay.mjs reconcile --deliver
node docket-relay.mjs reconcile --skip-to-end --reason <text>
node docket-relay.mjs test-send run:<id>   Send one fixed test message to the Run you name
```

| Setting | Default |
| --- | --- |
| `DOCKET_RELAY_URL` | `http://127.0.0.1:7420` |
| `DOCKET_RELAY_HOME` | `%LOCALAPPDATA%\docket-relay` |
| `DOCKET_RELAY_ORCA` | `orca.exe` on `PATH`, then Orca's install folder. Never `orca.cmd`, which refuses to send. |

`state.json` holds the cursor, what's waiting, what was delivered and any hold. It's written atomically. `relay.log` is capped at 256 KB with one rotation. `reconcile-audit.jsonl` is append-only. `instance.json` identifies the running relay and holds its stop token. None of them holds ticket text, answers or notes; the only free text is an operator's skip reason.

- **Docket needs local trust.** In protected mode the relay has no owner session, so it records the ticket as undelivered with `needs_local_trust`.
