# Parked, silent and flagged workers

**Read when:** A worker is parked, silent or flagged, a park ran out, a run's status is wrong, or a blocker holds only part of a story.
**Don't read when:** Your workers are live and nothing in the digest is parked or flagged.

## Fixing a run's status

Fix it yourself without its `run_id`: `update_run_status { id, coordinator: "<your name>", current_action?, park_reason?, waiting_on?, resume? }`. You must be the run's `orchestrator` or registered for the project. It's recorded as you, and grants no claim, close or review power.

## A worker that stops to wait and goes quiet

Don't keep it alive or watch its lease. Park it for a limited time: `update_run_status { id, coordinator, park_minutes: 120, park_reason, waiting_on }`.

- The limits are 240 minutes a park and 24 hours since its last own signal; a request over them is refused. Call again to renew, or pass `resume: true` to end it early.
- **When that time runs out** (`run.park_expired`), it's open again on a 15-minute lease: a live worker's next call continues, and a dead one loses its claim by `lease_expired`.
- Its own `park_run` replaces your limit, and you can't put a limit on a park it set itself.

## Flags and cards

- **"Activity since parked"** in `get_digest` or `get_context` (`run.activity`): commits, updates or a cleared blocker arrived. Check, then resume it or update it, which clears the flag. Renewing a park doesn't. "Commits while silent" means that session may have no Docket tools.
- **A wait card** is on `park_run`, digest parked rows and `get_context`: what it waits for, since when, who moves it next, and how the same run resumes. `get_context` on a blocker lists the parked runs it frees.
- **Coordinator waits need a named external wake.** Record `waiting_on.wake` with the actor, event and UTC deadline; set `source_item` when the event comes from a Docket item. Every listed item must clear for an item wait; a time is a separate condition. Docket cannot message the Orca session. A `wait_missing_wake` problem means the wake is missing, cyclic or overdue: check the chain and revise the wait. A recorded host HOLD or project freeze is still in force.
- **Orca custody is external evidence.** Query the exact dispatch and supervisor in Orca before `update_run_status { id, coordinator, dispatch_observation: { claimed_run, dispatch_id, state } }`. Report only `live`, `failed`, `exited`, `supervisor_unavailable`, `supervisor_disabled`, or `supervisor_missing_target`; never paste terminal output. A `live` report with a new dispatch ID records a verified handoff. Silence is unknown. A `dispatch_custody` problem calls for a custody check; this call never resumes, releases or replaces the run, starts a supervisor, or lifts a freeze. Check live writers and the project's host gates before any later action.
- **`wait_no_next_step`:** nobody is moving a blocker. Do its step: dispatch it, or shape or assign it.
- **`wait_owner_unasked`:** its text says an owner decision is pending and nobody asked. If it truly needs the owner, **ask it** with `ask_owner` on that item. The owner can't answer a question that doesn't exist. A bare wait on a person doesn't raise it.
- **Held by the owner's decision:** a park reason citing an active owner decision (`dec_…`) holds the run: no alerts, and it isn't `resume_ready`. Leave it until the owner lifts it. Citing an agent's decision silences nothing.

## Splits and outdated questions

- **"Added after work started"** on a card: check the blocker really holds the whole story. **If a blocker holds only some acceptance criteria, prefer a split:** `create_item` with `split_from { id, expected_version, move: [positions], relation, also?, coordinator: "<your name>" }`. The lead keeps its claim on the original, and the rest proceeds.
- **An outdated question** is blocking a new one: `withdraw_decision { question_id, reason, coordinator: "<your name>" }`, in plain words. It never answers for the owner.

## Asking the owner

Before you or a worker asks, check decisions, the ticket, plan and design docs, Workflow notes, the code and other agents' records.

- **Decide** what is technical, reversible, inside an approved design or follows a decision (`publish_decision` if others must follow).
- **Ask only** about product behavior, privacy or security, cost, irreversible or outward-facing actions, conflicting owner decisions, or a real change to an approved design.
- **Write for someone who hasn't seen the work:** everyday words, what a user would notice, real alternatives, and the recommended option's downside. IDs and paths go in `details`. Bad: "Per dec_12, keep the v2 DTO for RCP-16?" Good: "Should recipe cards show nutrition per serving or per 100 g?"

## Time limits that reach you, then the owner

- **Parked on items:** `get_digest` and `recovery_report` show `resume_ready` once those items clear. Resume it promptly: after 30 minutes the owner sees "ready to resume, unattended".
- **Parked for over 24 hours:** it comes to you first, in `get_digest` problems. Resume it, or have it `release_lead`. Left for a day, it reaches the owner.
- **A paused project:** once the owner lifts it, anything ready gets one `run.resume_ready`.
