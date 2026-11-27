# Exact historical run custody for Orca resource reconciliation

`/api/agents` is a UI view: it returns all open runs and only a recent ended
slice. A missing ended run in that view is not evidence that its dispatch or
resources are gone. The Orca resource reconciler must join each configured
audit target to an authoritative Docket run before it reads Orca state.

`GET /api/runs/:id/custody` is an owner-authenticated, read-only, indexed
single-run lookup. It returns only `run_id`, `item_id`, `dispatch_id`, displayed
`run_state`, `lease`, and `at`. The displayed state and lease use the same
projection as `/api/agents`; `at` is the last signal for an open run and the
update time for an ended run. A missing run or a run in a deleted project is
404. A missing or malformed stored Orca association returns a null
`dispatch_id`, which holds reconciliation. The route does not return workspace
paths, summaries, errors, wait reasons, private artifacts, or audit payloads,
and it does not deliver a wake or change a claim.

The audit source remains the bounded inventory: at most 80 configured targets,
with `more=false`. The reconciler selects exactly one target by run ID, requires
its dispatch ID to agree with the operator's exact IDs, and then performs one
indexed run lookup. There is no historical list or unbounded pagination to
walk; a source overflow, duplicate run ID, unavailable route, or any identity,
state, lease, item, timestamp, or path drift yields a hold before an Orca
action. It repeats the exact Docket and Orca reads immediately before any
action and before worktree completion. This source change gives no cleanup
authority on its own.

An old Docket image without the route returns a hold. Runtime cleanup needs a
separate installed-image gate, exact target and dispatch receipt, no-send
window, retention proof, and reviewed Orca ownership. Unknown descendants,
live terminals, private artifacts, unique commits, and protected resources
remain visible holds; no PID kill or automatic artifact deletion is added.
