# Settled Orca resource reconciliation

`docket-orca-reconcile.mjs` handles one recorded Docket run and one exact Orca Dispatch on the **local** host. It is an explicit coordinator tool, never a Docket scheduler or dispatch executor. It reads Docket's `orca-audit` source settings for the run's current finished/failed state, dispatch ID, worktree path and end time; it never changes a Docket claim. The tool emits only bounded categories and counts, without command lines, file names, paths, process IDs or private content.

From a checkout containing this tool and after Docket has the matching server version:

```powershell
node tools/docket-orca-reconcile.mjs --run-id run_... --dispatch-id ctx_...
node tools/docket-orca-reconcile.mjs --run-id run_... --dispatch-id ctx_... --execute
```

The first command inspects only. `--execute` is a separate, explicit action. For ignored private files that are to remain in the worktree, add `--preserve-private` after verifying their retention is intended. Neither form deletes those files.

Before any action, the tool requires a finished/failed Docket run, an Orca worker with matching dispatch and workspace custody, a settled worker outcome, a two-minute retention window, an exact coordinator-owned resource and no user-requested hold. It rejects dirty/unknown git state, unique commits, or a missing/linked worktree. It rereads Docket and Orca immediately before action. If Orca reports an owned live helper, `worker-stop --dispatch` fences that Dispatch and stops only its supervised agent terminal and helpers; otherwise `worker-release --dispatch` is used. A `stop_unknown` or unverified release is a hold.

After the action, it reads the worker again, closes only terminals whose exit has been observed and whose handle, incarnation, PTY and worktree still match, checks for working Orca agents and host process _candidates_, and rereads git. It marks the same worktree `completed` only when these checks are quiet and reads that status back. A command-line path match can only produce an unattributed-process hold; it never authorizes a PID kill. Live or unknown terminals, unknown processes, protected holds and dirty work remain visible for the coordinator. The tool does not start a replacement, alter a Docket claim, or clean private artifacts.

The result is `ready`, `completed`, or `hold` with a short reason. The process-candidate scan is bounded and cannot prove that every detached process was found; the coordinator must inspect any remaining process before declaring resource acceptance. Orca's `worker-stop` receipt is the authority for supervised helper shutdown.
