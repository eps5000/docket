# Waiting and parking

**Read when:** You park, wait on another item, a person or the coordinator, were parked by your coordinator, or hit `project_paused`.
**Don't read when:** You can keep working, including while CI or tests run.

## When to park

**Park only when the work itself stops:** waiting on another item, the coordinator or a person. Running CI or tests, or reviewing their results, is still work in progress: stay live and log a short note ("PR checks running") instead of parking.

| Waiting for                       | Call                                                      |
| --------------------------------- | --------------------------------------------------------- |
| Another item to land              | `park_run { reason, waiting_on: { items: [...] } }`       |
| The coordinator to send more work | `park_run { reason, waiting_on: { orchestrator: true } }` |
| A person's answer                 | `ask_owner` first; the run shows needs input              |

**Say what you wait on and who owes it:** "waiting for the schema ticket's merge, owed by its implementer", not "waiting". Ending your session too? Add `exit` (see the exit-reports reference).

## While parked

- A parked run keeps its claim and workspace, and its worktree is protected from pruning. Docket flags it `resume_ready` when what it waits on clears.
- **Read the wait card.** `park_run` returns what you're waiting for, who has the next step, and how you resume. Docket can't message your session: your coordinator relays it when the blocker clears.
- `heartbeat` or any other write with your `run_id` un-parks you; reads don't.

## Parked by your coordinator

"Parked by X until T" works the same way. When that time ends you have a short lease, so make a write to carry on. To wait longer on your own terms, call `park_run`, which replaces their time limit.

## Waiting without spending tokens

After `park_run`, end your turn if something will wake you. If you must stay running, block on the installed script next to `docket-check`:

```bash
bash .claude/docket-wait.sh --item <id> --cursor <cursor> --timeout 540
```

`docket-wait.ps1` on Windows without bash. Keep your shell tool's timeout above `--timeout`. Exit 0 means something changed, 2 means it timed out. **Never wait in a `sleep` loop.**

## A paused project

`project_paused` means the owner paused this project. Don't retry: take other work, or stop and say so. If you're already running, save your work and `park_run` at the next safe point. While it's paused, a parked run's writes are recorded and it stays parked. Only the owner lifts it.
