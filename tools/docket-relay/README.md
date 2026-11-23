# docket-relay

A small Node process on the host. When a ticket with a live lead changes from the owner side in Docket, it tells that lead's Orca session to go and look (owner decision 46, BUILD_SPEC §5.27).

Docket runs in a container and can't call the host's `orca` CLI, so this bridges the two. It needs Node 22 and has no dependencies.

## What it does

1. Long-polls `GET /agent/changes/wait`, which costs no tokens.
2. Keeps the owner-side events that can change what the lead should do, and ignores agent events and housekeeping.
3. Reads the item with `GET /api/items/:id` to find its live lead. That read records no delivery, so the answer stays unread for the agent.
4. Sends a pointer with `orca orchestration send`. It names the ticket and the kinds of change, never their text:

   > GF-243 was updated from the owner side in Docket (acceptance, decision). Call get_context GF-243 and get_item GF-243.

It never writes to Docket. It doesn't resume, park, claim, change a status or call MCP `get_item`.

**A limit to know.** An agent using the owner API is recorded as the owner, and Docket can't always tell them apart. That is why the message says "from the owner side". The relay does drop an event whose item activity shows another actor.

## Which events count

| Sent | Events |
| --- | --- |
| At once | `question.answered`, `run.resume_ready`. Anything waiting on that ticket goes in the same message. |
| After 60 s of quiet, at most 2 min after the first change | Owner edits to the title, description, outcome or acceptance; status changes, cancel, archive and unarchive; `decision.published`, `decision.confirmed`; owner notes; `review.decided`, `design_review.decided`, `resolution.decided`, `overlap.decided`, `undeclared.decided`; blocker links added or removed; an undo of any of these. |
| Never | Agent and system events (except `run.resume_ready`), housekeeping such as `problem.acknowledged` and `run.unpushed_handled`, priority-only edits, and any ticket with no live lead. |

## Who gets the message

1. **The implementer:** `orchestrator.dispatch_id`, only while Orca reports that dispatch as live. A finished dispatch is never mailed, because Orca would reopen it as a follow-up task.
2. **Its coordinator**, named with the implementer, if the implementer can't be reached: the dispatch's Orca Run, or a stored `run_…` ID. A stored `orca_session_id:…` may be a coordinator or the implementer, so it gets the coordinator wording.
3. **Nobody:** it's recorded as undelivered in `status`. Needs you is never touched.

If Orca is down, a message is held and retried for up to 24 hours.

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

Then check it, and prove the Orca path once with a mailbox you own:

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
node docket-relay.mjs status [--json]    Last event, last delivery, failures, undelivered
node docket-relay.mjs test-send <addr>   Send one fixed test message
```

| Setting | Default |
| --- | --- |
| `DOCKET_RELAY_URL` | `http://127.0.0.1:7420` |
| `DOCKET_RELAY_HOME` | `%LOCALAPPDATA%\docket-relay` |
| `DOCKET_RELAY_ORCA` | `orca.exe` on `PATH`, then Orca's install folder. Never `orca.cmd`, which refuses to send. |

`state.json` holds the cursor, what's waiting and what was delivered. It's written atomically. `relay.log` is capped at 256 KB with one rotation. Neither holds ticket text, answers or notes.

- **First run** starts at the end of the feed, so old history is never replayed.
- **After downtime** it delivers what it missed from the last 24 hours, once.
- **Docket needs local trust.** In protected mode the relay has no owner session, so it records the ticket as undelivered with `needs_local_trust`.
