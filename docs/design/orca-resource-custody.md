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

The audit source remains a bounded inventory: at most 128 eligible configured
targets, with `more=false`. The helper admits that inventory only when all
priority targets fit in its 42-target pass and the ended targets fit within
four rotations of the remaining slots. The measured 117-target roster has 11
parked and 106 ended runs, leaving 31 ended slots per pass. A larger or
unschedulable roster stops with `audit_overflow`; raw scan truncation also
sets `more=true` and stops the audit. The 42-target pass uses 14 bounded lanes:
three 17-second target waves plus cancellation grace fit inside the 80-second
collection limit. With 15 seconds for settings, 30 for one POST, and 60 between
passes, a complete bounded pass cycle is 185 seconds. Allowing 95 seconds of
within-pass observation spread gives a parked gap of at most 280 seconds and
an ended four-pass gap of at most 835 seconds. An observation aged 55 seconds
or more before POST is rejected. Accepted records are younger than 55 seconds,
so a bounded 30-second POST leaves them younger than 85 seconds at ingest,
inside the 90-second window. These bounds do not turn an unknown or failed read into a
successful observation.

The reconciler selects exactly one target by run ID, requires its dispatch ID
to agree with the operator's exact IDs, and then performs one indexed run
lookup. There is no historical list or unbounded pagination to
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
