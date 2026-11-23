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

Only a coordinator, the first of:

1. **The dispatch's Orca Run** (`run:<id>`), read from `orchestrator.dispatch_id` with `worker-show`.
2. **A stored `run_…` ID.**
3. **A stored `orca_session_id:…`.**
4. **Nobody:** it's recorded as undelivered in `status`. Needs you is never touched.

**A `dispatch:` address is never used**, on any path. Orca can reopen a one-shot worker that finished between a check and the send, and a pointer can't carry source authority. The send call and `test-send` both refuse one. If Orca can't answer `worker-show`, the message waits and is retried.

## After a stop

- **First run:** starts at the end of the feed, with no replay.
- **Stopped for under 24 hours:** catches up once, one message per ticket, within the rate limit, with no duplicates. A hard kill mid-send repeats that message under the same request ID, so Orca replays it.
- **Stopped for 24 hours or more, or the position can't be trusted:** enters `hold_reconcile`.

| Hold reason | Meaning | Ways out |
| --- | --- | --- |
| `stale` | The last feed read was 24 hours or more ago, including a sleeping host or a long Docket outage | `--deliver` or `--skip-to-end` |
| `batch_past_window` | A message has been waiting 24 hours, usually because Orca was down | `--deliver` or `--skip-to-end` |
| `state_untrusted` | The stored activity time or feed position can't be believed | `--deliver` if the feed still matches, or `--skip-to-end` |
| `state_unreadable` | `state.json` can't be parsed. It's kept as `state.json.corrupt-<ms>` | `--skip-to-end` |
| `cursor_ahead` | The cursor is past the end of the feed | `--skip-to-end` |
| `feed_reset` | The row at the cursor has changed, so the feed was replaced | `--skip-to-end` |

In a hold the relay **sends nothing and doesn't move its cursor**, and `start` exits with code 3. Nothing leaves the hold automatically. `status` shows the reason, how many events wait on how many tickets, and their time range, with no content.

Stop the relay, then run exactly one of these:

```powershell
Stop-ScheduledTask -TaskName 'Docket Relay'
$relay = "$env:LOCALAPPDATA\docket-relay\app\docket-relay.mjs"
node $relay status

# Queue the backlog, one message per ticket. The next start sends it within the rate limit.
node $relay reconcile --deliver

# Or skip it. The reason, cursors, counts, time range, ticket ids and kinds are recorded.
node $relay reconcile --skip-to-end --reason "Owner reviewed the backlog"

Start-ScheduledTask -TaskName 'Docket Relay'
```

Keep the reason to one line of at most 200 characters, with no ticket text. If Docket can't be read, `reconcile` changes nothing.

## Install on Windows

Run this in PowerShell from an up-to-date checkout of `main`. It copies the tool out of the repo, so worktree cleanup can't remove it, and registers a per-user task at logon.

```powershell
$app = "$env:LOCALAPPDATA\docket-relay\app"
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item -Recurse -Force .\tools\docket-relay\* $app

$user = "$env:USERDOMAIN\$env:USERNAME"
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
  -Argument "--headless `"$node`" `"$app\docket-relay.mjs`" start" -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Docket Relay' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings
Start-ScheduledTask -TaskName 'Docket Relay'
```

Then check it, and prove the Orca path once with a coordinator mailbox you own:

```powershell
node "$env:LOCALAPPDATA\docket-relay\app\docket-relay.mjs" status
node "$env:LOCALAPPDATA\docket-relay\app\docket-relay.mjs" test-send run:<your-run-id>
```

To update, stop the task, repeat the `Copy-Item` line and start it again. To remove it:

```powershell
Stop-ScheduledTask -TaskName 'Docket Relay'
Unregister-ScheduledTask -TaskName 'Docket Relay' -Confirm:$false
```

## Running and checking it

```text
node docket-relay.mjs start              Run in the foreground; one instance per state folder
node docket-relay.mjs status [--json]    Last event, last delivery, failures, undelivered, any hold
node docket-relay.mjs reconcile --deliver
node docket-relay.mjs reconcile --skip-to-end --reason <text>
node docket-relay.mjs test-send <addr>   Send one fixed test message: run:<id> or orca_session_id:<id>
```

| Setting | Default |
| --- | --- |
| `DOCKET_RELAY_URL` | `http://127.0.0.1:7420` |
| `DOCKET_RELAY_HOME` | `%LOCALAPPDATA%\docket-relay` |
| `DOCKET_RELAY_ORCA` | `orca.exe` on `PATH`, then Orca's install folder. Never `orca.cmd`, which refuses to send. |

`state.json` holds the cursor, what's waiting, what was delivered and any hold. It's written atomically. `relay.log` is capped at 256 KB with one rotation. Neither holds ticket text, answers or notes; the only free text is an operator's skip reason.

- **Docket needs local trust.** In protected mode the relay has no owner session, so it records the ticket as undelivered with `needs_local_trust`.
