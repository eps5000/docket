# Design: coordination tooling

**Status:** partly approved by the owner on 2026-11-23 (owner decision 48). **Approved to build:** Part 1, the bug fixes and the seven additions below. **Still proposed:** Parts 2 and 3, to compare with the separate Gameflow workflow audit, and all of Part 4. The relay is installed but switched off.

## Why

The pilot's bottleneck is coordination. Code kept landing while tickets stopped closing, and agents spent most of their time waiting.

| Pilot project, Nov 20 to 23 | Nov 20 | Nov 21 | Nov 22 | Nov 23 (part) |
| --- | --- | --- | --- | --- |
| Tickets finished | 8 | 5 | 2 | 2 |
| Times agents parked | 15 | 45 | 91 | 116 |
| PRs merged | 7 | 8 | 7 | 1 |

Snapshot on 2026-11-23:

- **Ready doesn't mean startable.** 74 tickets were Ready and 7 could start. One unowned Planning ticket would unlock 29 others.
- **Agents mostly wait.** Lead runs were parked for 477 of their 597 hours. 244 of 267 parks waited at least partly on a coordinator.
- **The owner and CI aren't the main delay.** The owner's median answer time is 14 minutes, and branch CI takes about 9.
- **Proof travels as prose.** 1,780 ticket notes hold 1.5 million characters. 86 of one orchestrator's 128 messages to the Docket coordinator involved read-only checks or receipts.
- **New tools aren't reaching agents.** `update_run_status`, `propose_resolution` and design reviews have no uses yet, and 1 of 59 runs recorded a producer. Some are only a day old, and the installed agent files are behind.
- **The heartbeat starts a new session every time.** A scheduled Orca automation ran every 4 hours with `reuseSession: false`. Its 58 runs used about 188 million tokens, 96% of them cached reads, at an API-equivalent estimate of $56. Its precheck also force-stops earlier idle heartbeat sessions.

These counts are one snapshot. Reasons for parking come from a rough text match.

## Principles

1. **Docket states facts and checks conditions.** Humans and coordinators keep product and authority decisions.
2. **No new gates.** A check replaces a manual readback. It doesn't add a step.
3. **Advisory by default.** Nothing here blocks a claim, queue or delivery unless a project chooses to require a gate.
4. **Costs no model turn when nothing changed.** Liveness and waiting are handled by a process, never by waking an agent to ask.
5. **One session per ticket.** Nothing may create a second live session for the same work.

## Part 1: True Ready and "start this next"

- **Split Ready** into **Startable** and **Waiting**, using the existing blocker logic. Work's board, filters and counts show both. The status itself doesn't change.
- **`get_next_work`** behavior, added to `get_digest` rather than as a new tool: a short ranked list of what to start, by priority, then how many tickets it transitively unlocks, then age. Each row says why.
- **Bottlenecks:** an unowned ticket in Inbox or Planning that blocks real work appears with its unlock count and the next step, "shape it or assign it".
- Overview's In flight card links to the same view.

## Part 2: Gate checks and a simple command line

Today, agents ask another agent to read Docket and paste back facts.

- **`check_gate`** evaluates a named list of conditions against live data and returns pass or hold, each condition's value, the time and the change cursor. Examples: no open runs, this exact parked set, no leases on a part, this ticket at this version, no active overlap, blocker cleared.
- **It records a receipt** that anyone can cite by ID, instead of pasting prose into notes. It grants nothing: authority stays with whoever decides.
- **`docket` command-line tool** on the host for sessions without Docket's MCP connection: `docket item GF-1`, `docket digest`, `docket gate <file>`. Read-only at first, over the local API, with no credentials in files.
- Reads never resume a parked run.

## Part 3: Coordinator queue

- **Waiting on you:** each coordinator sees the runs waiting on it, oldest first, with what it waits for and the next action. It comes through `get_digest` and a view on Agents.
- **Earlier escalation:** a run waiting only on a coordinator gets a flag after a project setting, default **2 hours**, instead of 24. It goes to the coordinator first and reaches the owner only under the existing routing.
- Waits on the coordinator must say **what** the coordinator owes: a decision, a review, a dispatch or a window. A bare "waiting on the coordinator" gets a prompt to say which.

## Part 4: Docket and running sessions

Owner decision 18 and FR-106 say Docket never launches agents. Stage 1 keeps that rule. Stages 2 and 3 need an explicit owner decision to change it.

### Stage 1: know which sessions are alive

The approved `docket-relay` grows into a small **host helper**. It reads Orca's terminal, worker and automation state and reports to Docket:

- each run's session address, and whether it's working, idle or gone;
- real session counts for Overview;
- token use where Orca reports it.

This replaces the planned session-address batch. Heartbeats come from the helper, cost no tokens and can't create a session. The Gameflow heartbeat automation can then run only when Docket says a coordinator has something to do, or be retired.

### Stage 2: wake the same session

When a blocker clears or the owner answers, the helper resumes **that exact session**. `codex queue`, `codex exec resume` and `claude -p --resume` exist, but none has been tested on a session Orca is running. **Run a spike on disposable sessions first**, and stop if two programs can drive one session. Until then, coordinators relay.

### Stage 3: launch workers

Docket's helper starts the top Startable ticket. This has the largest payoff and the largest risk, because Docket would own cost, credentials, worktrees and host memory. Decide only after Stages 1 and 2 have run. It would need one live session per ticket, a concurrency cap, a memory check, no automatic relaunch loop, a global kill switch and visibility in Orca.

## Bugs to fix now

1. An expired part lease stays open in the database and raises no event. It should end as `expired` and tell the holder's coordinator.
2. `wait_owner_unasked` says "owner decision" for a run that only waits on "a person". It should use the wording the record supports.

## Approved additions

1. **Flow trends on Overview:** finished, merged and parked per day.
2. **Split ticket:** move acceptance criteria, blockers and shared parts to a new ticket in one step.
3. **Critical path view:** the chain holding up a goal, and the one ticket to move next.
4. **Real cost per ticket and epic:** measured token use only, never an estimate shown as measured. First confirm what Orca reports for ordinary workers.
5. **Daily brief:** what finished, what's stuck, what needs the owner and what it cost.
6. **Worktree cleanup view:** which worktrees are safe to remove. Docket never deletes one itself.
7. **Withdraw question:** an agent can retract its own outdated question.

## Suggested order

1. The two bugs, and Part 1.
2. Stage 1 of Part 4, which also makes the relay's first release more useful.
3. Parts 2 and 3, adjusted by the workflow audit.
4. The Stage 2 spike, then a decision on Stages 2 and 3.

## Decisions for the owner

1. Approve Stage 1 of Part 4 as the relay's next step.
2. After seeing the workflow audit, decide which of Parts 2 and 3 to keep.
3. Whether to change owner decision 18 for Stage 2, after the spike.
