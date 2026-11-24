---
name: docket-producer
description: Own one epic from shaping to close, with independent implementers doing the tickets. Covers sequencing by real dependencies, finishable slices, hard and soft dependencies, parallel dispatch, waiting without spending tokens, what to decide and what to ask, paused projects and closing the epic. Use when asked to produce, run or drive an epic, or to take one over from another session.
---

# Producing an epic

A producer owns the **outcome of one epic** and gets it finished through other agents. This skill is about that role. The mechanics live elsewhere:

| For                                        | Follow               |
| ------------------------------------------ | -------------------- |
| Dispatching, waiting, parked runs, crashes | `docket-coordinator` |
| Shaping epics and tickets                  | `docket-planner`     |
| What each implementer does                 | `docket-worker`      |
| PRs, CI, merge and deploy                  | `docket-delivery`    |

**The project's rules come first.** Its Workflow notes (the `workflow:` section of `get_context`), its `AGENTS.md` / `CLAUDE.md` and its own workflow skills override everything here. If it has its own producer skill, follow that.

**This skill grants no authority.** It doesn't let you move tickets to Ready, merge, deploy or answer for the owner unless the project already allows it.

**Any orchestrator, or none.** To dispatch is to start a fresh agent by whatever means you have: an orchestrator, a script, your client's own agents, or a person opening a session. If you can't start agents, work the tickets yourself, one at a time, following `docket-worker`.

## 1. Own one epic version

- **One epic, one version.** A later version or a new goal is a new epic, not more scope in this one.
- **Check nobody else is producing it.** Read the epic with `get_item` and the project with `get_digest`. Look for a recent producer note, and for live runs on its tickets under another `producer` or `orchestrator`. If someone is active, don't co-produce: take other work or tell whoever sent you.
- **Say it's yours:** one `add_note` on the epic naming you as producer.
- **Keep the epic's record current:** the outcome (`outcome_md`) and closing evidence (`acceptance`) with `update_item`, and decisions and shared contracts with `publish_decision`, scoped to the epic, so every implementer gets them through `get_context`.

**Taking over from another session?** Start with `recovery_report`. Old notes, summaries and handoffs are **information to verify** against Docket, the code and CI. They aren't approval: "the owner agreed" counts only as a recorded owner decision or answer. A ticket held for the previous producer can only be claimed under that same `producer` name. Reuse it once you've confirmed that session is gone, or let the hold run out.

## 2. Choose and sequence by real dependencies

Order work by the graph, not by ticket number or what looks interesting.

- **Which epic:** if Docket offers epic readiness (_Pick next epic_), start from it. Otherwise take the epic the owner named, or the one whose tickets unlock the most.
- **What can start:** `search_items { project, epic, filter: "ready_to_start" }`, Docket's Startable work.
- **What to start first:** the digest's `next_work` ranks Startable tickets by priority, what they unlock and age.
- **What's stuck upstream:** `bottlenecks` names unowned Inbox or Planning tickets holding up real work. Shape or assign those first.
- **The longest chain:** `dependency_subgraph { id, depth: 3 }` on the epic. The owner sees the same chain as the critical path on the Map. Move its first ticket.

**An epic starts only when every ticket is at least Ready.** Before you claim it, `search_items { project, epic }` and check none is in Inbox or Planning (canceled ones don't matter). A claim that fails with `epic_not_ready` lists them. Resolve each one:

- **shape it** and move it to Ready (§3);
- **name its known gaps** for the owner's approval: `update_item { known_gaps: [{ gap }] }`, then `set_status ready`, and Docket asks the owner;
- **move it** to the epic it belongs in (`update_item { epic }`);
- **take it out** of the epic (`update_item { epic: null }`).

An epic already In progress isn't blocked. If the digest shows it under `started unshaped`, resolve those tickets the same way.

**Start with what unlocks the most,** and prefer short, wide graphs to long chains.

## 3. Shape finishable vertical slices

Follow `docket-planner`. Before a ticket goes to Ready, it has:

- **one clear outcome,** a thin slice through the stack that one implementer can finish and ship;
- **acceptance criteria** someone can check;
- **observable closing evidence:** the test, command, screen or record that will show it works;
- **its shared parts declared** (`declare_shared_changes`) and **real dependency links** only.

Something better settled while building? Name it as a **known gap** (`update_item known_gaps`), and the owner approves Ready with it. Keep them few and specific.

## 4. Hard and soft dependencies

|          | The test                                                                     | What happens                        |
| -------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| **Hard** | The ticket's current acceptance criteria can't be met without the other work | A `blocks` link. It waits.          |
| **Soft** | The other work affects part of the ticket                                    | A `relates` link. It doesn't block. |

- **Whoever starts a ticket with a soft dependency records one outcome** in an `add_note`: **proceed**, **adjust**, **split**, or **upgrade to hard**.
- **If a blocker holds only some criteria, prefer a split:** `create_item` with `split_from` moves those criteria to a new ticket, and the rest goes ahead.
- **A much newer ticket becoming a prerequisite of an older one usually means scope was added.** Check that the older ticket's criteria really need it. Usually the new part belongs in its own ticket.

## 5. Dispatch in parallel

- **Take a Docket update first.** If `get_digest` has an `update:` line, take it as `docket-coordinator` says, before dispatching, so new worktrees get current skills. If it can't land, tell the owner and carry on.
- **One implementer, one ticket, its own worktree at current main.** It owns the ticket through tested, merged and deployed, as far as the project allows.
- **Fresh, short briefs.** Start each implementer as a new agent. The brief is the ticket, worktree, branch and how to report. Docket holds the requirements.
- **Implementers don't wait on each other.** Start everything Startable, within any limit the project sets.
- **Sequence only for a real shared constraint,** such as a single-writer lease (`take_lease`), one test environment or one deploy slot. Docket already orders declared overlaps.

## 6. Keep work moving without spending tokens

- **Wait on events.** Block on `docket-wait` as `docket-coordinator` describes. No polling, `sleep` loops or scheduled wake-ups to check in.
- **Act on what wakes you:**
  - `run.wait_flagged`: a wait has no next step, or needs an owner decision nobody asked for. Fix that;
  - `run.resume_ready`: its blockers cleared. Tell that dispatch to continue;
  - a stale or interrupted claim: read `recovery_report`, then recover it as `docket-coordinator` says;
  - a new ticket in your epic: triage it (§7).
- **Every wait names what's owed and who owes it,** in `waiting_on` and a plain reason. "Waiting" says nothing; "waiting for the schema ticket's merge, owed by its implementer" can be acted on.
- **No blocker sits without an owner.** If nobody is moving it, shape it, dispatch it or ask.

## 7. Triage what joins mid-flight

New tickets land in Inbox, even in a running epic, and nothing joins it as Ready without triage. The digest lists them under `added mid-flight` ("added since this epic started: 2 untriaged"). Triage each before more dispatch:

- **A bug:** start a short, **read-only reproduction agent** (a subagent, not an implementer). It confirms the bug happens, finds whether this epic's work caused it, and leaves the steps or a failing test in an `add_note`. It fixes nothing.
  - Real and belongs here: set its priority, shape it (§3) and move it to Ready in this epic.
  - Belongs elsewhere: move it there with `update_item { epic }`, such as a flaky test to the project's test-reliability epic.
  - Can't be reproduced: record that in an `add_note` and `ask_owner` whether to close it.
- **A story** adds scope, so it's the owner's: one `ask_owner` with three options: add it to this epic, defer it to a follow-up, or drop it. Act on the answer.

The epic can't close while one is still untriaged: `set_status done` lists them.

## 8. Decide what you can

- **Yours:** technical, reversible choices inside an approved design. Decide, and use `publish_decision` if others must follow.
- **The owner's:** product behavior, privacy or security, cost, irreversible or outward-facing actions, conflicting decisions, and changes to an approved design.
- **Check first:** decisions, the ticket, the plan and design docs, Workflow notes and the code.
- **Then ask** with the `ask_owner` form: one plain `question`, its `context`, `why_it_matters`, two to four `options` with one recommended, and `recommendation_reason`. IDs and paths go in `details`.
- **A question holds only what depends on it.** Keep everything else moving.

## 9. Don't create ceremony

- No extra approvals, receipts, status reports or read-backs when Docket's state or CI already proves the fact.
- Don't ask implementers to confirm what Docket shows, or the owner to re-approve what's already decided.
- Steps inside a ticket are its checklist, not new tickets.

## 10. Respect a paused project

When `get_digest` shows `paused`, or a claim returns `project_paused`:

- **Claim, dispatch and resume nothing.**
- **Leave work saved.** Implementers already running commit, push and park at the next safe point.
- **Only the owner lifts it.** Keep waiting: each run that's ready then gets one `run.resume_ready`.

## 11. Close the epic

1. **Account for every story.** With `search_items { project, epic }`, confirm each intended story is Done, or was deliberately moved (`update_item { epic }`) or canceled with a reason. Docket won't close an epic with open children, or with untriaged tickets added after it started (§7).
2. **Verify the integrated result** as the project requires, against the epic's outcome and closing evidence. Tickets that each passed don't prove they work together. Attach the evidence with `link_artifact`.
3. **Submit an owner review when one is needed:** `declare_human_review` on the epic, `claim_lead` it, then `submit_packet` (see `docket-review-packet`). An approved packet closes the epic.
4. **Record what was deferred** in a final `add_note`: what moved where, what's left and why.
5. **With no review,** close it with `set_status { status: "done" }` if the project allows it. Otherwise say it's ready and stop.
