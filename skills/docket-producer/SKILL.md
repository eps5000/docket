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

Rare paths live in reference files: read one only when the table at the end says so.

## 1. Own one epic version

- **One epic, one version.** A later version or a new goal is a new epic, not more scope in this one.
- **Check nobody else is producing it.** Read the epic with `get_item` and the project with `get_digest`. Look for a recent producer note, and for live runs on its tickets under another `producer` or `orchestrator`. If someone is active, don't co-produce: take other work or tell whoever sent you.
- **Say it's yours:** one `add_note` on the epic naming you as producer.
- **Keep the epic's record current:** the outcome (`outcome_md`) and closing evidence (`acceptance`) with `update_item`, and decisions and shared contracts with `publish_decision`, scoped to the epic, so every implementer gets them through `get_context`.

**Taking over from another session?** Read the takeover reference first. Old notes and handoffs are information to verify, never approval.

## 2. Choose and sequence by real dependencies

Order work by the graph, not by ticket number or what looks interesting.

- **Which epic:** if Docket offers epic readiness (_Pick next epic_), start from it. Otherwise take the epic the owner named, or the one whose tickets unlock the most.
- **What can start:** `search_items { project, epic, filter: "ready_to_start" }`, Docket's Startable work.
- **What to start first:** the digest's `next_work` ranks Startable tickets by priority, what they unlock and age.
- **What's stuck upstream:** `bottlenecks` names unowned Inbox or Planning tickets holding up real work. Shape or assign those first.
- **The longest chain:** `dependency_subgraph { id, depth: 3 }` on the epic. The owner sees the same chain as the critical path on the Map. Move its first ticket.

**An epic starts only when every ticket, including its mandatory Release, is at least Ready.** Exploration can run while the epic is still being shaped. On `epic_not_ready`, `started unshaped`, or a Release held by its gates, read the epic-readiness reference.

**Start with what unlocks the most,** and prefer short, wide graphs to long chains.

**Give every Needs shaping ticket to a planner.** The digest's `needs shaping` section lists tickets an agent created unshaped, or that the owner asked a planner to shape ("the owner asked: …"). For each one in your epics, start a **planner** agent following `docket-planner` (its needs-shaping reference), with the ticket and the owner's note as its brief. Don't shape it yourself in passing, and don't send it to the owner: the owner only approves known gaps. A story the owner hasn't yet decided to add to a running epic waits for that decision first, then shaping.

## 3. Shape finishable vertical slices

Follow `docket-planner`. Before a ticket goes to Ready, it has:

- **one clear outcome,** a thin slice through the stack that one implementer can finish and ship;
- **acceptance criteria** someone can check;
- **observable closing evidence:** the test, command, screen or record that will show it works;
- **its shared parts declared** (`declare_shared_changes`) and **real dependency links** only.

**A ticket you create arrives shaped.** Pass `outcome_md`, `acceptance` and `shared` (the part keys it changes, or `"none"`) to `create_item`, and to a split. Don't know yet? Leave them out: it's marked **Needs shaping**, and a planner shapes it. Never leave it for the owner to find blank.

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
  - a new ticket in your epic: triage it (§8).
- **Every wait names what's owed and who owes it,** in `waiting_on` and a plain reason. For a coordinator-only wait, name the external event, actor and deadline in `waiting_on.wake`; the coordinator's parked-workers reference explains the relay and custody report. Every listed item must clear, so a report on one ticket alone does not wake the producer.
- **No blocker sits without an owner.** If nobody is moving it, shape it, dispatch it or ask.

## 7. Resolve partial exits

Every implementer reports how it finished. A **partial** exit lists what's left, why, and what would finish each item. Read `finished partly` in **every** digest (it stays until someone acts), and resolve each item as the partial-exits reference says. An agent can't close the ticket as Done until then.

## 8. Triage what joins mid-flight

New tickets land in Inbox, even in a running epic: nothing joins it as Ready without triage, and the epic can't close until each is triaged. The digest lists them under `added mid-flight`. Triage each one as the mid-epic-triage reference says. **A story adds scope, so it's the owner's:** ask, never add it yourself.

## 9. Decide what you can

- **Yours:** choices within the approved design, recorded owner expectations and delegated bounds, including product details needed to deliver them. Decide and proceed. Use a narrowly scoped `publish_decision` when other tickets must follow; otherwise a ticket note suffices. Routine covered choices need no owner notification.
- **The owner's:** a change to an approved outcome or constraint, conflicting owner decisions, a material risk or cost the owner did not accept, or a destructive or irreversible action without explicit authority. Ask with a recommendation and consequences. A category such as product behavior or deployment does not by itself require another approval when the design already settles it; project rules and explicit approval gates still apply.
- **Check first:** decisions, the ticket, the plan and design docs, Workflow notes and the code.
- **Then ask** with the `ask_owner` form: one plain `question`, its `context`, `why_it_matters`, two to four `options` with one recommended, and `recommendation_reason`. IDs and paths go in `details`.
- **A question holds only what depends on it.** Keep everything else moving.

## 10. Don't create ceremony

- No extra approvals, receipts, status reports or read-backs when Docket's state or CI already proves the fact.
- Don't ask implementers to confirm what Docket shows, or the owner to re-approve what's already decided.
- Steps inside a ticket are its checklist, not new tickets.

## 11. Respect a paused project

When `get_digest` shows `paused`, or a claim returns `project_paused`:

- **Claim, dispatch and resume nothing.**
- **Leave work saved.** Implementers already running commit, push and park at the next safe point.
- **Only the owner lifts it.** Keep waiting: each run that's ready then gets one `run.resume_ready`.

## 12. Close the epic

1. **Account for every ticket and bug.** With `search_items { project, epic }`, confirm each is Done or deliberately moved out or canceled with a reason. Resolve known gaps, partial exits and tickets added mid-epic.
2. **Run the Release ticket.** It owns the integrated journeys, deploy, smoke test and evidence. Docket automatically makes it wait for all other tickets and refuses Review or Done while its gates fail. Read the release reference for the close path.
3. **Record what was deferred** in a final `add_note`: what moved where, what's left and why. When the Release is Done, Docket closes the epic automatically.

## References

| File                                                             | Read when                                                                                                                | Don't read when                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| [`references/epic-readiness.md`](references/epic-readiness.md)   | Before you claim an epic, or the digest or a claim shows `epic_not_ready`, `started unshaped` or a Release held by bugs. | The epic is running and its tickets are shaped.           |
| [`references/mid-epic-triage.md`](references/mid-epic-triage.md) | The digest lists a ticket under `added mid-flight`, or a new bug or story arrives in your running epic.                  | Nothing was added to the epic since it started.           |
| [`references/partial-exits.md`](references/partial-exits.md)     | The digest shows `finished partly`, or an implementer reports a partial exit.                                            | No partial exit is waiting.                               |
| [`references/takeover.md`](references/takeover.md)               | You take over an epic from another session, or find a ticket held under another `producer` name.                         | You started producing this epic yourself in this session. |
| [`references/release.md`](references/release.md)                 | You shape, dispatch or close the epic's Release, or it reports `release_gates`.                                          | The epic is still in ordinary ticket work.                |
