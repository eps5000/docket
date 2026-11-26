# Settled Orca resource reconciliation

`docket-orca-reconcile.mjs` handles one recorded Docket run and one exact Orca Dispatch on the **local** host. It is an explicit coordinator tool, never a Docket scheduler or dispatch executor. It joins one `orca-audit` target (run ID, dispatch ID and worktree path) to one exact `/api/agents` run row for the current finished/failed state and end time; it never changes a Docket claim. A missing, duplicate, open, or changed run is a hold. The Agents view retains a bounded set of ended runs, so an older run that is no longer listed remains a hold rather than being inferred from the audit target. The tool emits only bounded categories and counts, without command lines, file names, paths, process IDs or private content.

From a checkout containing this tool and after Docket has the matching server version:

```powershell
node tools/docket-orca-reconcile.mjs --run-id run_... --dispatch-id ctx_...
node tools/docket-orca-reconcile.mjs --run-id run_... --dispatch-id ctx_... --execute
```

The first command inspects only. `--execute` is a separate, explicit action. For ignored private files that are to remain in the worktree, add `--preserve-private` after verifying their retention is intended. Neither form deletes those files.

Before `--execute`, the coordinator must hold sends and reactivation of **that exact Orca Dispatch** until the receipt is read back. Docket and Orca do not offer an atomic compare-and-stop across their stores; a worker resumed between the final read and `worker-stop` could otherwise be fenced. If this no-send window cannot be guaranteed, leave the resource as a hold.

Before any action, the tool requires a finished/failed Docket run with a released or child-run lease, an Orca worker with matching dispatch and workspace custody, a settled worker outcome, a two-minute retention window, an exact coordinator-owned resource and no protected retention reason. It rejects dirty/unknown git state, unique commits, or a missing/linked worktree. It rereads Docket and Orca immediately before action. If Orca reports an owned live helper, `worker-stop --dispatch` fences that Dispatch and stops only its supervised agent terminal and helpers; otherwise `worker-release --dispatch` is used. A `stop_unknown`, retained helper, or unverified release is a hold.

After the action, it reads the worker again, closes only terminals whose exit has been observed and whose handle, incarnation, PTY and worktree still match, checks for working Orca agents and host process _candidates_, and rereads git. It marks the same worktree `completed` only when these checks are quiet and reads that status back. A command-line path match can only produce an unattributed-process hold; it never authorizes a PID kill. Live or unknown terminals, unknown processes, protected holds and dirty work remain visible for the coordinator. The tool does not start a replacement, alter a Docket claim, or clean private artifacts.

The result is `ready`, `completed`, or `hold` with a short reason. The process-candidate scan is bounded and cannot prove that every detached process was found; the coordinator must inspect any remaining process before declaring resource acceptance. Orca's `worker-stop` receipt is the authority for supervised helper shutdown.
