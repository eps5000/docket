# Feature Specification: Docket (formerly Task Lite) V1 (local agent coordination with owner supervision)

**Feature Branch**: `eps5000/speckit-v1`

**Created**: 2026-11-14

**Status**: Clarified, planned and tasked. Ready to build (see [tasks.md](tasks.md)).

**Input**: User description: "Flesh out the requirements and spec for Docket V1: a local agent coordination service that AI agents work through (find ready work, claim it, plan, record evidence, follow decisions, hand off for human review), with a supervision UI that shows the owner what agents did, what they're doing and what needs the owner. It should cut agents' token use, make dependency tracking automatic, and give the owner visibility." Sources: docs/REQUIREMENTS_DRAFT.md (owner decisions 1–20), docs/BUILD_SPEC.md, docs/MCP_SPEC.md, docs/UI_SPEC.md, design/prototype.html.

## Overview

One owner runs Docket on their own computer. AI agents (installed coding agents, and the same agents launched as workers by an orchestrator) connect to it to find work they may start, claim it, get the context they need, publish their plan, record what they did and verified, follow shared decisions, and hand finished work to the owner for verification. Docket enforces the rules (claims, dependencies, review gates), so agents don't have to remember them. The owner uses a browser UI to see what needs them, what agents are doing, where the work is, and what happened, and to decide, nudge and archive. Docket never starts agents itself.

## Clarifications

### Session 2026-11-14

- Q: How should the owner find out that something needs them when the Docket tab isn't in front of them? → A: Opt-in desktop (browser) notifications for new "for you" items only (handoff ready, question asked), plus the for-you count in the browser tab title. No email or phone; nothing leaves the machine.
- Q: Should the owner be able to edit an item's text in the UI (title, description, outcome, acceptance criteria), especially while shaping it in Planning? → A: Yes. Inline editing of those four fields on the Details view, with conflict detection and Undo. Planned dates, effort and blocker links stay agent-edited in V1.
- Q: Where should nightly backups be stored? → A: Inside the service's data volume by default. The owner can opt in to also writing each backup to a folder on the host machine, for an extra copy that survives losing the volume.
- Q: Should the browser UI require an owner key to unlock, so a local agent can't record a human approval through the UI's API? → A: Yes. The owner pastes the key once per browser, and the session lasts 30 days from last use. The owner can lock the browser or rotate the key (which ends every session) in Settings.
- Q: Should the owner be able to cancel an item themselves in the UI? → A: Yes, any open item, with an optional reason and Undo. Canceled items leave the owner's views like archived ones, and anything they block stays blocked until the link is removed.
- Owner requirement (2026-11-15, not a clarify question): after an Orca crash pruned worktrees holding in-flight work, Docket must record enough to restart interrupted work without guessing (where the work lives, the brief, what was started), must distinguish "parked, waiting on purpose" from "finished", and must surface leftover processes and sessions. Docket records; the coordinator acts (owner decision 26; User Story 11).
- Owner requirement (2026-11-17, not a clarify question): the owner wants in-app help, and wants to view, customize per project, install and verify the agent files Docket ships, because projects may combine Docket with other workflow tools (for example Spec Kit) (owner decision 29; User Stories 12 and 13).
- Owner requirement (2026-11-18, not a clarify question): agents often tailor instructions for a project, and people or agents will also edit installed files directly. Agents must be able to propose changes for the owner's approval, and Docket must detect and help remedy edits made outside it (owner decision 30; User Story 14).
- Owner requirement (2026-11-18, not a clarify question): onboarding a real project (Gameflow: GitHub code, Spec Kit planning, Jira tickets) must work from a fresh install, with no skills installed yet, and must not duplicate work already imported from Jira (owner decision 31; User Story 15).
- Owner requirement (2026-11-18, not a clarify question): no unlock step and no commands to connect agents; Docket is a local tool, so local processes are trusted by default, with an opt-in protected mode (owner decision 32).
- Owner requirement (2026-11-18, not a clarify question): Jira sub-tasks carry real descriptions, so checklist steps need details, a source, and a dialog to read them in (owner decision 33; User Story 16).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agents find, claim and complete work through Docket (Priority: P1)

An agent connects, asks for work it may start, claims one item, publishes a short plan, records progress, the checks it ran, and the commits it made, and closes the item. If it stops early, or goes silent, the item becomes available to another agent. Two agents never hold the same item.

**Why this priority**: This is the coordination core. Without it there is nothing to supervise, and nothing that saves tokens or tracks dependencies.

**Independent Test**: With seeded sample work and no UI, a scripted agent client can connect, list ready work, claim the top item, publish a three-step plan, mark steps done, record a passing check and a commit, and close the item. A second client trying to claim the same item is refused with the current holder's details.

**Acceptance Scenarios**:

1. **Given** a Ready, unblocked, unclaimed item, **When** an agent asks for work it may start, **Then** the item is listed, highest priority first, and items that would unblock the most other work come first among equals.
2. **Given** that item, **When** the agent claims it, **Then** the agent becomes its lead, the item moves to In progress, and the agent receives a run identifier and a lease expiry.
3. **Given** an item already led by another agent, **When** a second agent tries to claim it, **Then** the claim is refused with the current lead, their last signal and the lease expiry, and the rejected claim is visible to the owner.
4. **Given** a lead agent, **When** it publishes a plan and later sends only one changed step, **Then** the other steps are unchanged, and the revision is kept as history with its reason.
5. **Given** an item with no human review items and passing checks, **When** the agent closes it, **Then** it becomes Done, closed by the agent, and the agent's run ends as finished.
6. **Given** a lead agent that sends no signal for the stale period, **When** the owner looks at the item, **Then** its run shows as stale (not finished). When the lease expires, the claim is released and the item returns to Ready with its plan intact.
7. **Given** the service restarts while runs are open, **When** it comes back, **Then** every open run shows as interrupted and none as finished.
8. **Given** an agent retries a write after a timeout with the same retry key, **When** the server receives it, **Then** the original result is returned and nothing is duplicated.

---

### User Story 2 - The owner sees what agents did, are doing, and what needs them (Priority: P1)

The owner opens Docket and immediately sees what needs them: handoffs to verify, questions to answer, and problems (stale or failed runs, dependency cycles, date conflicts). They can see what agents are doing right now, see all work on a board, list, map or timeline, and open any item to see its details, plan and checks, dependencies, and full activity history, each with who said what and how it's known.

**Why this priority**: Visibility is one of the three reasons Docket exists, and it's how the owner trusts the agents' work.

**Independent Test**: With seeded sample work, the owner can answer "what needs me?", "what are agents doing?", "where is epic RCP-1?" and "what happened on RCP-14?" from the UI alone. Each answer matches the seeded state, and every agent-reported fact is labelled as such.

**Acceptance Scenarios**:

1. **Given** two handoffs ready and one open question, **When** the owner opens the home view, **Then** it shows "3 for you" with those three entries first, plus problems, deferred checks and the owner's planning queue, on one screen at a typical laptop size.
2. **Given** agent runs in different states, **When** the owner looks, **Then** each run shows as live, reported, stale, needs input, failed, finished or interrupted, in words and not only colour, with how the state is known.
3. **Given** any item, **When** the owner opens it, **Then** they see four views (Details, Checklist, Dependencies or Map, Activity), with counts and attention markers on the view tabs, and the item opens on the view they last used for it.
4. **Given** a checklist that mixes owner-added steps, agent steps, subagent contributions, and checks from CI or from the agent, **When** the owner reads it, **Then** each entry shows its source distinctly, and nothing but an owner decision looks like human approval.
5. **Given** work across two projects, **When** the owner starts a new visit, **Then** the scope is All projects. Switching to one project scopes every page except Settings.
6. **Given** agents change data while the owner has a page open, **When** the change happens, **Then** the page updates without a reload and without moving the owner's keyboard focus.
7. **Given** the owner has turned on desktop notifications and the UI is open in a background tab, **When** a handoff becomes ready or an agent asks a question, **Then** one notification appears naming the item and what's needed. Clicking it opens that item's packet or question, and the tab title shows the for-you count, for example "(3) Docket". Nothing else triggers a notification.

---

### User Story 3 - The owner verifies finished work before it closes (Priority: P1)

When an agent finishes work that the owner must check by hand, it hands off a packet: what to verify, exact steps, what the agent already checked, known gaps, and attachments. The owner marks each item Looks good, Needs changes (with a note), or Defer, and the outcome follows: close, send back, or close with the item recorded as not verified. A ticket can't close while any human review item is undecided.

**Why this priority**: Owner verification is the one gate Docket always enforces, and it's the main reason the owner opens the UI.

**Independent Test**: With seeded packets, the owner can approve one packet (the ticket closes and unblocks its dependents), send one back with one finding as a checklist step and one as a new bug, and defer an item with a follow-up test ticket. The resulting states, links and labels match the rules.

**Acceptance Scenarios**:

1. **Given** an item with declared human review items, **When** the agent tries to close it without a handoff, **Then** it is refused, with the number of undecided items.
2. **Given** a submitted packet, **When** the owner opens it, **Then** they see the latest round, the commit it was built from, each item with three choices, and a submit button that names the outcome ("Approve and close ticket", "Send back to codex", "Close ticket (1 deferred)"). The button stays disabled until every item is decided.
3. **Given** Needs changes, **When** the owner submits without a note, **Then** it is refused. With a note, the finding becomes either a checklist step on the ticket or a new Bug in Ready linked to it. The ticket returns to In progress, and its review items come up again for the next round.
4. **Given** Defer with a follow-up, **When** submitted, **Then** the ticket closes as "review deferred, not verified", a test ticket in Inbox carries the same check, and the item appears on the owner's deferred list and in agents' cleanup list until resolved.
5. **Given** an open packet, **When** an agent reports a newer commit for that ticket (or for any ticket in an epic, if the packet is epic-level), **Then** the packet shows as out of date to the owner. The owner can ask for a fresh packet, which returns the ticket to In progress for the agent.
6. **Given** approvals in round 1, **When** round 2 arrives, **Then** approved items stay approved.
7. **Given** any owner decision, **When** made, **Then** it can be undone for a short period, and it is recorded with the owner as the actor.

---

### User Story 4 - Dependencies decide what's ready, automatically (Priority: P2)

Agents and the owner link items so that one blocks another. Docket computes what is blocked and what is ready, across projects, and agents only ever see startable work. A project (or a single link) can require a blocker to be merged, or verified by the owner, rather than just done. Cycles are refused when created, and flagged when they arrive in imported data. The owner sees progress and the blocking chain on a map.

**Why this priority**: Automatic dependency tracking is one of the three reasons for Docket. It builds on the core loop (US1).

**Independent Test**: Link A → B → C. B and C are not startable until their blockers clear. Closing A makes B startable with no other action. Setting the project's rule to "PR merged" makes a done-but-unmerged blocker block again, and reporting the merge clears it. Linking C → A is refused with the cycle path.

**Acceptance Scenarios**:

1. **Given** B blocked by A, **When** A is not cleared, **Then** B never appears in "ready to start", and shows "Blocked by A" with A's status.
2. **Given** a project rule of "PR merged", **When** a blocker is done but no merged PR is reported, **Then** its dependents stay blocked with "needs merge". When the agent reports the merge, they become startable, and the UI labels the merge as agent-reported.
3. **Given** a link requiring owner verification, **When** the blocker closes with a deferred check, **Then** the dependent stays blocked, and the owner sees it as a problem with a way to open it.
4. **Given** an attempt to create a link that would form a cycle, **When** it is made, **Then** it is refused, showing the cycle path.
5. **Given** an epic, **When** the owner opens its map, **Then** items are arranged in waves (what nothing blocks, then what can start after), with blockers from outside the epic shown separately, done work marked, and links traced on hover.
6. **Given** a blocker that is canceled, **When** its dependents are evaluated, **Then** they stay blocked and the owner sees "Blocked by canceled X" with a way to remove the link. Nothing unblocks silently.

---

### User Story 5 - Agents get the right context in one call, and follow shared decisions (Priority: P2)

When an agent starts an item, it gets everything it needs in one bounded response: the outcome and acceptance criteria, the decisions it must follow, the epic and label briefs, its blockers, planning documents, and the last review's notes. Agents record decisions that other agents must follow. The owner can record, confirm or withdraw decisions, and the owner's decisions are authoritative.

**Why this priority**: This is the biggest single saving in agent tokens and repeated work. It depends on items, epics and labels existing (US1 and US7).

**Independent Test**: For a seeded item, one context request returns all six parts, within the budget, with any truncation marked. An agent-published decision appears in the context of every item in its scope. The owner confirms it, and it becomes authoritative. An agent's attempt to change an owner decision is refused.

**Acceptance Scenarios**:

1. **Given** an item in an epic with labels, decisions and planning documents, **When** an agent requests its context at the default size, **Then** it receives, in priority order: essentials, active decisions (owner's first), epic and label briefs, blockers with what each is waiting for, planning documents, and the last review. The response fits the default budget, with cuts marked.
2. **Given** an agent publishes a decision scoped to an epic, **When** another agent requests context for any ticket in that epic, **Then** the decision is included.
3. **Given** an owner decision, **When** an agent tries to supersede or withdraw it, **Then** it is refused, with a pointer to ask the owner.
4. **Given** an agent decision, **When** the owner confirms it, **Then** it becomes an owner decision. When the owner withdraws a decision, it drops out of agents' context but remains in history.
5. **Given** agent decisions, **When** they're published, **Then** they never appear in Needs you. The owner sees them in a Decisions section where they apply.

---

### User Story 6 - The owner steers without a review round (Priority: P2)

The owner answers agents' questions, leaves notes for the agent working on an item, releases a stale claim, returns failed work to Ready, and adds checklist steps, checks or review items of their own. Agents receive answers and notes exactly once, on their next read.

**Why this priority**: Steering keeps work moving between reviews. It depends on US1 and US2.

**Independent Test**: The owner answers a seeded question, and the item shows "waiting for codex to read it" until the agent reads it once. The owner leaves a note, and the agent sees it once. The owner releases a stale claim through a confirmation whose focus starts on Cancel, the run becomes interrupted, and the item returns to Ready.

**Acceptance Scenarios**:

1. **Given** an agent asks the owner a question, **When** asked, **Then** the run shows as needs input, the question appears in Needs you, and the owner can answer inline.
2. **Given** an answer or a note, **When** the agent next reads the item, **Then** it receives the answer or note exactly once, and the owner sees that it was read.
3. **Given** a stale lead, **When** the owner releases the claim, **Then** a confirmation explains the effect (run interrupted, not finished; work kept; item back to Ready). After confirming, any later call from the old run is refused with the current state.
4. **Given** an owner-added step, check or review item, **When** an agent revises the plan or checks, **Then** the owner's entries are kept, and agents cannot edit or remove the owner's review items.
5. **Given** a failed run, **When** the owner chooses Return to Ready, **Then** the item is unclaimed and startable again.

---

### User Story 7 - The owner plans and keeps the workspace tidy (Priority: P2)

The owner captures ideas quickly, shapes work in Planning (their stage, where agents may draft planning documents), moves items to Ready one at a time or in bulk by label, groups large initiatives with labels that have a brief, and archives done work so it stops cluttering their views.

**Why this priority**: Planning feeds the agents' queue, and archiving keeps supervision lean. Both depend on US2.

**Independent Test**: Quick capture creates an Inbox item and opens it. Moving to Planning, then to Ready, makes it startable. A label page moves every Planning item with that label to Ready. Archiving a done item removes it from the board, list, timeline and epic list, but it stays searchable and can be unarchived.

**Acceptance Scenarios**:

1. **Given** the owner presses New, **When** they enter a title and create, **Then** the item lands in Inbox and opens. Creating from an epic fills in the epic and keeps the owner on the epic.
2. **Given** an item in Planning, **When** the owner moves it to Ready, **Then** agents can start it (if unblocked). Agents may also move items to Ready when the project's own workflow allows it.
3. **Given** a label with Planning items, **When** the owner chooses "Move N to Ready" on its page, **Then** all of them move, and the action can be undone.
4. **Given** done items, **When** the owner archives one or all, **Then** they disappear from the owner's views but remain in search, in agents' queries and on progress maps. They can be restored, and the action can be undone.
5. **Given** a planning document added by an agent, **When** the owner opens it, **Then** it renders in a viewer with its version, author and a download option, and earlier versions are kept.
6. **Given** an item in Planning, **When** the owner edits its title, outcome or acceptance criteria inline, **Then** the change is saved with Undo available, recorded as the owner's, and returned to agents in the item's context. If an agent changed the same field first, the owner's edit is refused, and the latest text is shown for the owner to reapply.
7. **Given** an Inbox item the owner no longer wants, **When** they choose Cancel item and confirm, **Then** it becomes Canceled with their optional reason, leaves their views, can be undone for a short time, and still turns up in search.

---

### User Story 8 - The owner sees dates, effort and a forecast (Priority: P3)

The owner sees planned dates (labelled with who set them), actual time worked, blockers that finish after a dependent's planned start, remaining effort over time, and, once there is enough history, a forecast range that never overwrites planned dates.

**Why this priority**: Planning depth that is useful once real work flows. Not needed to coordinate.

**Independent Test**: With seeded dates and effort, the timeline shows planned and actual bars, blocker ends, and a date-risk flag. The burn-down shows remaining effort with scope changes marked. The forecast says "not enough history yet" until the threshold is met, and then shows a P50 to P85 range with its assumptions.

**Acceptance Scenarios**:

1. **Given** an item whose blocker is planned to finish after the item's planned start, **When** shown, **Then** it is flagged as a date risk, on the timeline and in Problems.
2. **Given** fewer than 8 estimated items completed in the last 4 weeks, **When** the owner views the forecast, **Then** it says "No forecast yet: needs 8 completed items with effort (have N)".
3. **Given** enough history, **When** the owner views the forecast, **Then** it shows P50 and P85 dates, the rate, the sample size, and how many items are unestimated, and planned dates are unchanged.

---

### User Story 9 - The owner imports a Jira project after reviewing a dry run (Priority: P3)

Before a pilot, the owner can point Docket at a Jira Cloud project, see a dry-run report of what would import, what would be skipped and what would lose detail, and then import. The Jira credential is used only for that import.

**Why this priority**: It's needed for the pilot, not for coordination. It depends on US1 to US4.

**Independent Test**: Against a small test Jira project, the dry run reports counts by type, lossy fields and cycles, and writes nothing. Import then creates items with their Jira keys searchable, and stores the report with the project.

**Acceptance Scenarios**:

1. **Given** valid Jira details, **When** the owner runs the dry run, **Then** a report lists issues, would-import, skipped and lossy counts per field, the lossy items with reasons, detected cycles, and the fields used for points and dates. No records are written.
2. **Given** the owner confirms, **When** the import runs, **Then** all items are created together, attachments are downloaded with per-file failures reported, and imported items show "Imported from Jira".
3. **Given** the import has finished or been cancelled, **When** anything is inspected, **Then** the Jira credential appears nowhere: not in records, logs or the report.

---

### User Story 10 - The owner runs Docket safely on their machine (Priority: P2)

The owner starts Docket with one command, connects their agents by following short instructions, unlocks the UI in their browser with an owner key that agents never get, and trusts that data survives restarts and container replacement, that backups restore, and that deleting a project removes its records and documents together.

**Why this priority**: It is a prerequisite for any real use, but it is operational rather than a user journey through the product, so it is P2 behind the P1 slices, which can be demonstrated on a developer machine.

**Independent Test**: On a clean machine: start the service, connect two different agent clients, unlock the browser, create work, replace the container (the work is still there), restore last night's backup into a scratch instance (identical), and delete a project (its records and documents are gone, other projects untouched).

**Acceptance Scenarios**:

1. **Given** a clean machine with the container runtime, **When** the owner follows the README, **Then** the service is running and an agent is connected within 10 minutes.
2. **Given** a browser without an owner session, **When** it opens the UI, **Then** it must unlock with the owner key. Without that session, agents' credentials cannot perform owner actions.
3. **Given** a request from another machine, or a request whose Host or Origin isn't allowed, **When** it arrives, **Then** it is refused.
4. **Given** text that looks like a secret, **When** anyone tries to save it, **Then** it is refused and not stored or logged.
5. **Given** the owner has enabled the extra host-folder backup location, **When** the nightly backup runs, **Then** the same backup appears in both places. Settings shows the last successful time for each, and the host copy can be restored after the service's data volume is removed.
6. **Given** the owner deletes a project after typing its key, **When** confirmed, **Then** its items and documents are removed together, and backups age out on their stated retention.

### User Story 11 - Interrupted work restarts cleanly, and nothing is left running (Priority: P1)

The coordinator (an Orca orchestrator, a script or the owner) dispatches workers. A worker crashes, or the orchestrator does, or worktrees get pruned. Docket still knows, for every piece of in-flight work: the instructions it was given, the worktree and branch, the last pushed commit, whether anything was unpushed, how far through its checklist it got, and what it left running. Workers that are idle on purpose are recorded as parked, so they're never mistaken for finished. After a crash the coordinator gets one restart list, re-dispatches from it, and cleans up leftovers. The owner sees anything at risk.

**Why this priority**: losing in-flight work and rebuilding mandates by guesswork has already happened in practice. Coordination is only trustworthy if it survives crashes.

**Independent Test**:
1. Dispatch three workers through the MCP client, each with a workspace and a brief: one active, one parked waiting on an item, and one that declared a dev server and left a commit unpushed.
2. Simulate a crash: restart the service and stop sending signals.
3. `recovery_report` lists each worker correctly: the active one interrupted with its brief and workspace; the parked one parked, and `resume_ready` once its item is done; the third at risk, with its orphaned dev server and unpushed commit.
4. Re-dispatching from the report resumes the work from the checklist.
5. The owner sees the at-risk work and the orphaned resource under Problems.

**Acceptance Scenarios**:

1. **Given** a worker claimed an item with a workspace and a brief, **When** the service restarts, **Then** `recovery_report` lists it as interrupted (service_restart) with the exact brief, worktree path, branch, last pushed commit and checklist progress, and a new worker can claim and resume it.
2. **Given** a worker is waiting for the coordinator, **When** it parks with `waiting_on: orchestrator` and stays idle for hours, **Then** it keeps its claim, never shows as stale or finished, and its workspace is reported as in use.
3. **Given** a worker parked waiting on RCP-12, **When** RCP-12 is done, **Then** the parked run is flagged ready to resume. If nobody resumes it within 30 minutes, the owner sees "Ready to resume, unattended".
4. **Given** a worker declared a dev server and its run ended without releasing it, **When** 15 minutes pass, **Then** the owner sees "Orphaned resources" with how to find it, and can mark it released once it's stopped.
5. **Given** a run ended by lease expiry with uncommitted changes or unpushed commits, **When** the owner looks, **Then** they see "Unpushed work may be lost" with the worktree path, until a later run pushes or they mark it handled.
6. **Given** a coordinator about to prune worktrees, **When** it checks `recovery_report` or Agents → Workspaces, **Then** only workspaces whose runs all ended, fully pushed, clean and with resources released are marked safe to prune.

### User Story 12 - Help is one click away (Priority: P2)

The owner can open short how-to articles from the sidebar, from the search palette, or from a "?" next to the screen or state they're looking at: connecting an agent, reviewing a packet, what parked, stale and at risk mean, recovering after a crash, pruning safely, blocker rules, Jira import, backups and restore, and agent setup.

**Why this priority**: the product now has coordination concepts (claims, leases, parking, workspaces) that a new owner can't guess. Help makes them learnable without leaving the app.

**Independent Test**: from a fresh install, open Help, search for "parked", open the article, and follow a "?" from the Agents page to the same article.

**Acceptance Scenarios**:

1. **Given** the owner is on Agents → Workspaces, **When** they click the "?" by the heading, **Then** the "Workspace states and safe pruning" article opens.
2. **Given** the search palette is open, **When** the owner types "restore", **Then** the backup and restore article appears under Help.

---

### User Story 13 - See, tailor and install the agent files (Priority: P2)

The owner can see exactly which instructions agents get: the bundled skills and AGENTS.md block, the owner's service-wide edits, and each project's overrides and Workflow notes, with history and diffs. They install them into a repo or user-wide with one command, or with one click when they've mounted a folder, and later see whether the installed copy was edited locally.

**Why this priority**: different projects run different workflows (some also use Spec Kit), and when an agent misbehaves the owner needs to see which instructions it had.

**Independent Test**:
1. Edit `docket-worker` for one project.
2. Install it into that project's repo with the copy-paste command.
3. Edit the installed file by hand.
4. Run the check.

The diff shows the local edit, and the install log shows the exact versions sent.

**Acceptance Scenarios**:

1. **Given** a bundled skill, **When** the owner edits it service-wide, **Then** a new version is saved with a diff against the bundled one, and *Revert to bundled* restores it.
2. **Given** a project override of a skill, **When** the owner opens that project's agent files, **Then** the effective set shows the override and which layer each file comes from.
3. **Given** the owner set Workflow notes on a project, **When** an agent calls `get_context` for an item in it, **Then** the bundle includes those notes.
4. **Given** a mounted push folder, **When** the owner clicks *Install* for a project, **Then** the files are written to the repo, the AGENTS.md block is replaced only between its markers, and the install is logged with every file's version.
5. **Given** an installed copy was edited locally, **When** the owner runs the check (in the UI with a mount, or by command without one), **Then** each changed file is listed with a diff against what was sent.
6. **Given** a Docket upgrade changes a bundled skill the owner has edited, **When** the owner opens Agent setup, **Then** it says "Bundled version updated" and offers a diff, and the owner's version is not overwritten.

### User Story 14 - Agents propose instruction changes, and drift is caught (Priority: P2)

An agent working on a project can read that project's agent files and Workflow notes, and propose a change with a reason. The owner sees the proposal with a diff and approves, edits then approves, or declines. When anyone edits installed instruction files directly instead (a person in VS Code, or an agent told to), Docket notices: from the push folder's scheduled check, or from the hashes agents report when they claim work. The owner sees what changed and can adopt it, restore Docket's version, or keep it on purpose. Every run records which instruction versions it worked from.

**Why this priority**: agents commonly do the tailoring, and an unreviewed or accidental edit to instructions silently changes how every later agent behaves. The owner needs both a safe path and a safety net.

**Independent Test**:
1. An agent proposes a change to `docket-worker` for one project; the owner approves it, and it becomes the project's copy, with "proposed by … · approved by owner" in its history.
2. A person then edits the installed `SKILL.md` by hand.
3. The next agent claim on that project reports the changed hash; the owner sees "edited outside Docket", with the diff, and adopts it.

**Acceptance Scenarios**:

1. **Given** an agent with a run on a project, **When** it calls `propose_agent_file_change` with new content and a reason, **Then** nothing changes until the owner acts, and the proposal appears on the project's Agent files page and as one line in Needs you.
2. **Given** a pending proposal, **When** the owner approves it, **Then** it's saved as the project's copy (or the default, if proposed for the default), with the proposer and approver in its history, and the next install or `get_context` uses it.
3. **Given** a push-folder install, **When** an installed file is edited by hand, **Then** within the scheduled check interval the owner sees "Agent files changed outside Docket", with a diff and *Adopt*, *Restore* and *Keep local*.
4. **Given** an install without a push folder, **When** an agent claims an item and reports instruction hashes that differ from what was sent, **Then** the owner sees the same problem, and the run shows "instructions edited locally".
5. **Given** the owner chose *Keep local*, **When** the same content is reported again, **Then** no new alert is raised; **When** it changes again, **Then** a new alert is raised.
6. **Given** an agent is asked by a user to edit its installed skill files, **When** it follows the shipped skills, **Then** it proposes the change through Docket instead, and tells the user so.

### User Story 15 - Onboard a project with an agent (Priority: P1)

The owner creates a project (or imports it from Jira), then asks any connected agent to onboard the repo. The agent calls `onboard_project` and follows the guide it returns: it surveys the repo's planning sources, matches them to items already in the project, creates the rest in Planning with acceptance criteria, dependencies, labels, decisions and planning documents, proposes the project's Workflow notes, and finishes with a summary. The owner reviews everything from one card and installs the agent files from there.

**Why this priority**: it's the first thing a real pilot does, and without it Docket starts empty.

**Independent Test**:
1. On a fresh install, import a fixture Jira project.
2. Point an agent at a fixture repo with Spec Kit specs and tasks, some matching the Jira items.
3. Call `onboard_project`, then follow the guide.

The result: the Jira-matched tasks enrich the existing items instead of duplicating them; the rest are new items in Planning; specs are attached as planning documents; Workflow notes are proposed; and the review card lists every change.

**Acceptance Scenarios**:

1. **Given** no skills are installed, **When** an agent calls `onboard_project` for a new key, **Then** the project is created (marked "created by <agent>"), and the result contains the full onboarding guide.
2. **Given** a project that already has imported Jira items, **When** an agent onboards it, **Then** `onboard_project` adopts the existing project, and the guide tells the agent to match by Jira key and title before creating anything.
3. **Given** onboarding is in progress, **When** the agent creates items, **Then** every new item is in Inbox or Planning; nothing is Ready.
4. **Given** the agent calls `finish_onboarding` with a summary, **When** the owner opens Needs you, **Then** one card shows the counts (created, enriched, documents, decisions), the open questions, the proposed Workflow notes, and *Install agent files*.
5. **Given** a client that supports MCP prompts, **When** the owner runs the onboarding prompt, **Then** the agent receives the same guide.
6. **Given** an agent, **When** it tries to change a project's settings or delete it, **Then** it can't; those remain owner actions.

### User Story 16 - Checklist steps with details (Priority: P2)

A ticket's checklist steps can carry details: a description in Markdown, and where the step came from. The owner opens a step in a dialog to read or edit everything about it. Agents add details when they plan, and read a step's details when they work on it. Jira sub-tasks import as steps with their full descriptions, and their comments are collected on the parent.

**Why this priority**: real work (Gameflow's Jira sub-tasks) carries descriptions that a one-line step drops.

**Independent Test**: import a fixture Jira project whose sub-tasks have long descriptions and comments. Each parent's steps carry the descriptions in details, with a source of the Jira key; one note on the parent collects the comments; the step dialog shows it all; and an agent's `get_step` returns the details while `get_item` shows only a marker.

**Acceptance Scenarios**:

1. **Given** a step with details, **When** the owner clicks its title or details icon, **Then** a dialog shows its title, status, source, rendered details, history and subagent notes, with *Previous* and *Next*, and Esc closes it.
2. **Given** the dialog, **When** the owner edits the details and saves, **Then** a new version is recorded (with a conflict check against the version they opened), and agents see the change.
3. **Given** an agent planning, **When** it calls `set_plan` with steps that include details, **Then** they're stored, and `get_item` standard shows each step with a "· details" marker instead of the text.
4. **Given** an agent working a step, **When** it calls `get_step` or `get_context`, **Then** it receives that step's details within the budget.
5. **Given** a Jira import, **When** a sub-task has a description and comments, **Then** its step has the description in details, a header line ("Jira GF-123 · assignee Sam · due Dec 4 · 3 pts"), source GF-123, and its comments appear in one "Comments from Jira sub-tasks" note on the parent, grouped by sub-task with author and date.

### Edge Cases

- **A lead's lease expires mid-work, and the agent calls again with its old run:** it is refused with the current state. The item has already returned to Ready, with its plan and logs kept.
- **Two owner tabs, or the owner and an agent, change the same item at once:** the later write is refused as a conflict. The UI shows the latest state and says who changed it.
- **A packet is open and the owner adds a new review item:** the new item waits for the next round, and the ticket stays open until it is decided.
- **A blocker is in another project, or is archived:** blocking still applies. Archived doesn't mean cleared, and cleared depends on the link's rule.
- **An epic-level review exists:** child tickets without their own review items say "reviewed with its epic". The epic can't close until its children are done or canceled.
- **Imported data contains cycles, or links to items outside the import:** cycles are imported as they are and flagged under Problems. External links are listed in the dry-run report as skipped.
- **A verified-rule blocker has no human review items:** creating such a link is refused, with advice to declare review or use "done".
- **A very long title, or a large document:** titles are truncated with the full text on hover. Documents above the size limit are refused with the limit stated. Unknown file types are download-only.
- **The connection to the service drops in the UI:** a banner says it's reconnecting. After a minute it says changes won't be saved, and actions are disabled.
- **An agent sends text over a field's limit:** refused, with the limit.
- **The extra backup folder is missing, full or not writable:** the default backup still succeeds, and the owner sees a problem ("Extra backup copy failed: <reason>") until a later copy succeeds.
- **Notifications are off or blocked by the browser:** nothing is lost. The tab title count and Needs you still show everything. A burst of handoffs produces one notification per item, not repeats.
- **Context exceeds the budget:** lower-priority sections are cut, with an inline marker. The essentials and decisions are never cut first.
- **The owner archives an item that isn't done:** refused. Cancel exists for that.
- **The owner cancels an item an agent is working on:** the agent's run is interrupted and its claim released, and the agent's next call is refused with the item's canceled state. Items it blocked show "Blocked by canceled X" until the link is removed.
- **A run belonging to a client that never answers liveness checks:** it shows as reported rather than live, never as live by assumption.
- **A deleted project's IDs:** agents get "not found".
- **A worktree was pruned while its run was open:** Docket can't see that. The run goes stale, then interrupted, and the restart list points to the last pushed commit, so the coordinator recreates the worktree from it. Anything unpushed is flagged as possibly lost.
- **A worker parks and never resumes:** it keeps its claim. After 24 hours the owner sees it under Problems and can release the claim.
- **A worker reports nothing about its workspace:** the workspace state is "unknown" and is never treated as safe to prune.
- **The push folder isn't mounted or isn't writable:** *Install* falls back to showing the command, and says why.
- **A repo's AGENTS.md has no Docket markers:** install appends the block between new markers and changes nothing else.
- **An installed file was deleted locally:** the check reports it missing; reinstalling restores it.
- **An agent proposes a change to a file the owner edited since the agent read it:** the proposal shows a three-way comparison; approving it doesn't silently drop the owner's edit.
- **An agent reports hashes for files Docket never installed:** they're listed as unknown, and never treated as a problem on their own.
- **A secret appears in proposed content:** the write check rejects it, as for any text.
- **Onboarding is run twice on the same project:** the second run reconciles against what the first created (matching titles and source paths) instead of duplicating it.
- **An agent tries to onboard with a deleted project's key whose cleanup hasn't finished:** it's refused, as for imports.

## Requirements *(mandatory)*

### Functional Requirements

**Work items and workflow**

- **FR-001**: The system MUST support projects, each with a short key, and items of four types: Epic (the only container), Story, Task and Bug. Item IDs are the project key plus a number, unique and never reused.
- **FR-002**: Items MUST have a title, description, outcome, acceptance criteria, priority (1–3), optional epic, labels, optional planned dates (recording who set them and when), and optional effort.
- **FR-003**: The system MUST enforce the workflow Inbox → Planning → Ready → In progress → Review → Done, plus Canceled, allowing only the transitions defined in the build spec. Disallowed transitions are refused with the allowed alternatives.
- **FR-004**: An item MUST NOT reach Done while any of its human review items is undecided. No other condition gates Done.
- **FR-005**: An epic MUST NOT reach Done until all its children are Done or Canceled.
- **FR-006**: Every change MUST be recorded as an immutable event with the actor (owner, a named agent with its client and label, or the system), the time, and what changed.
- **FR-007**: Concurrent conflicting changes MUST be detected. The losing write is refused with the current record. Retried writes with the same retry key MUST NOT be applied twice.

**Agent access and coordination**

- **FR-010**: Installed agent clients MUST be able to connect over the Model Context Protocol on the local machine, with a shared agent credential. The connecting client is identified from its handshake, plus an optional worker label.
- **FR-011**: Agents MUST be able to list work they may start: Ready, not blocked and unclaimed, sorted by priority, then by how much other work each item unblocks.
- **FR-012**: Agents MUST be able to list resumable work: In progress with no lead (sent back by review, or after a failed run).
- **FR-013**: Claiming the lead on an item MUST be atomic. Exactly one agent can hold it, and a refused claim returns the holder, the last signal and the lease expiry, and is visible to the owner.
- **FR-014**: A lead claim MUST carry a lease that is renewed by any call from that run. When the lease expires, the claim is released, the run is interrupted, and the item returns to Ready with its work kept.
- **FR-015**: Run state MUST be derived only from evidence:
  - live: recent activity from the run's own connection;
  - reported: activity, but not from its own connection;
  - stale: no signal for the stale period;
  - plus needs input, failed, finished and interrupted.

  A run MUST never be shown as finished unless the agent finished it.
- **FR-016**: On service start, every open run MUST become interrupted.
- **FR-017**: Agents MUST be able to publish and revise a plan as one-line steps. A revision changes only what is sent, keeps history, and requires a reason. Owner-added steps are always kept.
- **FR-018**: Agents MUST be able to record checks they ran (state, evidence and provenance), subagent contributions (observed or relayed), progress notes, commits, and links to external evidence. None of these is human approval.
- **FR-019**: Agents MUST be able to declare, edit and remove their own human review items while those items are not in an open packet. They MUST NOT change items the owner added.
- **FR-020**: Agents MUST be able to submit a handoff packet: items to verify, verification steps, what was already checked and how, known gaps, attachments, the commit it was built from, and an estimate. Submission is refused if the item is blocked, a packet is already open, there's nothing to verify, or an agent check is failing without a known gap explaining it.
- **FR-021**: Agents MUST be able to read the owner's review decisions round by round, owner notes and answers. Notes and answers are delivered exactly once.
- **FR-022**: Agents MUST be able to ask the owner one open question per item at a time. Asking marks their run as needing input.
- **FR-023**: Agents MUST be able to poll for changes since a cursor, filtered by project, item and event type, in order and without gaps.
- **FR-024**: Agents MUST be able to read the dependency neighbourhood of an item, to a chosen depth, with planned dates labelled as entered or absent, and the downstream items a given delay would put at risk.
- **FR-025**: Every agent-facing result MUST be bounded (paged lists, a summary view, field selection), and MUST come with a complete compact text rendering. Writes MUST change only what is sent.
- **FR-026**: Every agent-facing error MUST carry a code (validation, conflict, not found, forbidden, unavailable, internal) and a one-sentence next step.
- **FR-027**: Agents MUST NOT be able to record review decisions, answer questions as the owner, write owner notes, archive, delete projects, or release another agent's claim.

**Dependencies**

- **FR-030**: Items MUST be linkable as "blocks" (which affects eligibility) or "relates" (informational only), across projects. Parent epics and "relates" links never block.
- **FR-031**: Each project MUST have a rule for when a blocker counts as cleared: done (the default), PR merged (done, plus a merge reported by the agent), or verified (done, with every human review item approved and none deferred). Individual links MAY override it.
- **FR-032**: Creating a link that would form a cycle MUST be refused, with the cycle path. Cycles already present (for example from an import) MUST be detected and shown as problems.
- **FR-033**: A canceled blocker MUST stay uncleared until someone removes the link, and MUST be shown as a problem.
- **FR-034**: A "verified" link to a blocker with no human review items MUST be refused. A verified blocker that closes with a deferred check MUST stay uncleared and be shown as a problem.
- **FR-035**: Changing a project's rule or a link's rule MUST re-evaluate eligibility immediately, and be recorded.

**Context and decisions**

- **FR-040**: Agents MUST be able to request one bounded context bundle for an item, in this priority order: essentials (with a count of unread notes, without delivering them); active decisions in scope, owner's first; epic and label briefs; blockers with what each is waiting for, and dependents; planning documents; the last review. There are three size budgets, and truncation is always marked.
- **FR-041**: Decisions MUST have a scope (project, epic, label or item), a title, the decision, an optional rationale, an authority (owner or agent), and a status (active, superseded or withdrawn). An item's context includes every active decision from its project, epic, labels and itself.
- **FR-042**: Owner decisions MUST be authoritative. Agents can publish agent decisions, supersede or withdraw agent decisions, but not change owner decisions.
- **FR-043**: The owner MUST be able to record decisions, confirm agent decisions (making them owner decisions) and withdraw any decision. Withdrawn and superseded decisions stay readable in history.

**Human review**

- **FR-050**: The owner MUST be able to decide each item in an open packet as approve, needs changes (note required; becomes a checklist step or a new Bug in Ready linked to the ticket), or defer (optional note; optional follow-up test ticket in Inbox carrying the same check).
- **FR-051**: The outcome MUST follow from the decisions:
  - any "needs changes": the ticket returns to In progress, and its review items come up again;
  - otherwise: the ticket closes with the owner recorded as closer.

  Approvals carry forward to later rounds.
- **FR-052**: A packet MUST be marked out of date when a newer commit is reported for its ticket, or for any child of an epic with an epic-level packet. The owner MUST be able to ask for a fresh packet, which returns the ticket to In progress, withdraws the packet, and notifies the agent.
- **FR-053**: Deferred checks MUST remain listed for the owner and for agents (for cleanup) until their follow-up is done and approved, or they are re-declared and approved.
- **FR-054**: Earlier packet rounds MUST remain readable, with their decisions shown by outcome (approved, needed changes, deferred), each in a distinct style.

**Owner UI**

- **FR-060**: The UI MUST provide: Needs you (home), Work (board, list, map, timeline, with an Epics row), item pages (four views), the handoff packet screen, label pages, Agents, and Settings (projects, connections, service health).
- **FR-061**: Only items that need the owner (handoffs ready and open questions) MAY drive the red attention count. Problems MUST list stale and failed runs, cycles, date risks, canceled blockers, and verified blockers with deferred checks, each with one action that opens the right place.
- **FR-062**: Every owner change MUST be undoable for a short period, or confirmed when destructive, with focus on Cancel.
- **FR-063**: The UI MUST update live as agents change data, keep the owner's focus, and warn clearly when the service is unreachable.
- **FR-064**: The owner MUST be able to quick-capture items, move items between Inbox, Planning and Ready, change priority, add checklist steps, checks and review items, answer questions, leave notes, release stale claims, return failed work to Ready, archive and unarchive done items, record and confirm decisions, set each project's blocker rule, edit an item's title, description, outcome and acceptance criteria inline, and cancel any open item.
- **FR-064a**: Owner edits to an item's text MUST use the same conflict detection as agent writes: an edit based on a stale version is refused with the latest text shown. Edits MUST be undoable, recorded with the owner as the actor, and visible to agents on their next read.
- **FR-064b**: The owner MUST be able to cancel any open item with an optional reason. Cancel MUST be undoable, and it is recorded as the owner's.
  - **An item with an active lead:** its run ends as interrupted, and the agent's next call gets the current state.
  - **An item with an open packet:** the packet is withdrawn.
  - **An epic with open children:** canceling is refused, naming those children.
  - Canceled items leave the owner's default views, but stay searchable.
  - Undo restores the item's previous status. It doesn't restore an interrupted run.
- **FR-065**: Each item MUST open on the view the owner last used for it. Opened items MUST appear as tabs (at most 8) that remember their view. Scope MUST reset to All projects on each new visit.
- **FR-066**: Every state, provenance and attention signal MUST carry text, not just colour. The UI MUST meet WCAG 2.1 AA in light and dark themes, at window widths down to 1024 px.
- **FR-067**: Search MUST find items (including archived and imported ones, by Jira key), labels and views.
- **FR-068**: The owner MUST be able to opt in to desktop notifications from the browser. Only new "for you" events notify: a handoff becoming ready, or a question being asked. There is at most one notification per event, and clicking it opens the item. The browser tab title MUST show the current for-you count. Nothing is sent off the machine. If the owner declines or revokes permission, the UI keeps working without notifications.

**Documents**

- **FR-070**: Agents and the owner MUST be able to store documents on items or projects. A document stored again under the same name becomes a new immutable version, and earlier versions are kept.
- **FR-071**: The UI MUST preview Markdown (sanitised), plain text and structured text, images, video and PDF. It MUST offer download for every document, including unknown types.

**Dates, effort, forecast**

- **FR-080**: The timeline MUST show planned dates labelled with who set them, actual worked time, blocker end dates, date risks, and undated items.
- **FR-081**: A burn-down MUST show remaining effort per day for the chosen scope, with scope additions marked and unestimated items counted separately.
- **FR-082**: A forecast MUST appear only once at least 8 estimated items have completed in the last 4 weeks, in at least 2 different weeks. It MUST show P50 and P85 dates with its assumptions, and MUST never change planned dates.

**Jira import**

- **FR-090**: The owner MUST be able to run a dry run against a Jira Cloud project that writes nothing and reports mapped, skipped and lossy data per field, lossy items with reasons, cycles, and the fields used.
- **FR-091**: After review, the import MUST create all records together, preserve Jira keys as searchable references, mark items as imported, and store the report with the project.
- **FR-092**: The Jira credential MUST be held only for the import session and MUST never be stored, logged or included in the report.

**Operation and safety**

- **FR-100**: The service MUST start with one command, and MUST be reachable only from the local machine by default. Requests with a disallowed Host or Origin MUST be refused.
- **FR-101** *(amended by owner decision 32)*: **In protected mode**, owner actions MUST require an owner session established with an owner key that agents never receive. The session lasts 30 days from last use in that browser. The owner MUST be able to lock a browser (ending its session) and rotate the key (ending every session). An agent's credential MUST NOT be accepted for any owner action.
- **FR-102**: Data and documents MUST survive container replacement. Health and readiness checks MUST identify storage problems.
- **FR-103**: Nightly backups MUST include records and documents, MUST be kept for a stated period, and MUST be restorable with a documented command. By default, backups are stored with the service's data.
- **FR-103a**: The owner MUST be able to opt in to an extra backup location: a folder on the host machine. When it's enabled, each nightly backup is also written there, with the same retention. Settings MUST show each backup location with its last successful backup time. A failed copy to the extra location MUST appear as a problem, and MUST NOT affect the default backup.
- **FR-104**: Deleting a project MUST require typing its key, and MUST remove its records and documents together.
- **FR-105**: Text that looks like a secret MUST be refused on write and never stored or logged. Credentials MUST never appear in logs.
- **FR-106**: The service MUST NOT launch agents or call model APIs.
- **FR-107**: Settings MUST show the agent connection instructions for each supported client, and a compatibility matrix of verified clients.
- **FR-108** *(default, not asked)*: The service MUST keep a diagnostic log of each agent call (tool, client and label, run, duration and outcome code), without call contents, so the owner can see why an agent struggled.
- **FR-110** (owner decision 26): Runs MUST be able to record where their work lives (host, repo, worktree path, branch, base ref and SHA, head and pushed commits, and whether there are uncommitted changes) and the orchestrator's identifiers. These are set on claim or start and updated as work proceeds.
- **FR-111**: Runs MUST be able to record the brief they were given, stored immutably with the item and returned unchanged for a restart.
- **FR-112**: Runs MUST be able to park with a reason and what they're waiting on (items, the orchestrator, a person, a time). A parked run never goes stale or loses its claim, and resumes on its next call. It's flagged ready to resume when its waits clear. The owner sees parked runs past 24 hours, and runs ready to resume but unattended for 30 minutes.
- **FR-113**: Runs MUST be able to declare and release long-lived resources (processes, dev servers, sessions, containers, temp directories, ports) with enough detail to find them. Resources still unreleased 15 minutes after their run ends MUST show to the owner as orphaned, with an action to mark them released.
- **FR-114**: Every ended run MUST record why it ended (finished, failed, released, lease expired, released by the owner, service restart, canceled). Runs that ended unexpectedly with unpushed or uncommitted work MUST show to the owner as "unpushed work may be lost" until a later push or the owner marks it handled.
- **FR-115**: The system MUST provide a restart list for coordinators: interrupted, stale and parked runs, each with its brief, workspace, last pushed commit, checklist progress and open question; every workspace with its state (in use, parked, at risk, safe to prune, unknown); and orphaned resources.
- **FR-116**: The owner UI MUST show where each run's work lives (branch, worktree, push state, resources, brief), offer a copyable resume note, and list every workspace with its state on the Agents page.
- **FR-117**: The system MUST NOT inspect, stop or delete anything on the host, except reading and writing agent files in a folder the owner explicitly mounts for that purpose (FR-125). Recovery actions are the coordinator's or the owner's, guided by what the system records.
- **FR-120** (owner decision 29): The owner UI MUST provide Help articles, reachable from the sidebar, the search palette and contextual "?" links.
- **FR-121**: The system MUST keep the agent files it ships (each skill and the AGENTS.md block) in three layers: bundled (read-only, updated by upgrades), service-wide edits, and per-project overrides. Each edit is a new version with an author, note, history and diff, and can be reverted to the layer below.
- **FR-122**: For each project, the system MUST show the effective agent files (which version of each file applies and from which layer), and MUST flag files whose bundled version changed after the owner edited them, without overwriting the owner's version.
- **FR-123**: Each project MUST be able to hold Workflow notes (Markdown, ≤ 10,000 characters), versioned like the agent files, and `get_context` MUST include them for that project's items.
- **FR-124**: The system MUST offer installing a project's or the service-wide effective agent files, for Claude Code or Codex, into a repo or user-wide, by a copy-paste command that downloads them from Docket with a short-lived single-use link.
- **FR-125**: The system MUST offer an opt-in push install into a host folder the owner mounts for that purpose. It writes only skill folders and the marked Docket section of AGENTS.md/CLAUDE.md, and never deletes, except folders Docket itself installed and recorded, when unmodified (B28: the `tasklite-*` skill folders an install from before the rename recorded in its manifest, removed only while each still matches the recorded hash; an edited one is kept and reported).
- **FR-126**: Every install MUST be logged with its time, client, target, method and the exact version of every file, and installed files MUST carry a manifest of those versions.
- **FR-127**: The system MUST show whether installed copies differ from what was sent: in the UI for pushed installs, and through a copy-paste check command for others.
- **FR-128** (owner decision 30): Agents MUST be able to read, through MCP, the agent files and Workflow notes in effect for a project, and to propose a change to any of them with a reason. A proposal changes nothing until the owner approves it.
- **FR-129**: The owner MUST be able to approve, edit then approve, or decline each proposal, seeing a diff against the current version (and a three-way view if the file changed since the agent read it). History MUST record the proposer and the approver.
- **FR-130**: Agents MUST NOT be able to change agent files or Workflow notes directly. Proposals are the only agent path.
- **FR-131**: The system MUST detect installed instruction files that differ from what was sent: by checking push-folder installs on a schedule, and from instruction hashes agents report when they claim an item.
- **FR-132**: For each detected difference, the owner MUST see what changed (a diff, when the content is available) and be offered *Adopt* (save it as the project's copy), *Restore* (reinstall Docket's version) or *Keep local* (accept it; no further alerts until it changes again).
- **FR-133**: Each run MUST record the instruction versions it reported working from, and the owner MUST see them on the run, flagged when they differ from what was sent.
- **FR-134**: The shipped skills and AGENTS.md block MUST tell agents to propose instruction changes through Docket rather than editing installed files, and to report their instruction hashes when they claim work.
- **FR-135** (owner decision 31): The owner MUST be able to create a project in Settings (key, name, colour, blocker rule).
- **FR-136**: Agents MUST be able to start onboarding through MCP: create a new project, or adopt an existing one, and receive the onboarding guide in the tool result, so no installed files are needed.
- **FR-137**: The onboarding guide MUST be bundled, editable by the owner like the other agent files (as the default or per project), and also offered as an MCP prompt.
- **FR-138**: The guide MUST direct agents to reconcile with items already in the project (Jira keys, titles, source paths) before creating new ones, to create everything in Inbox or Planning, to attach planning sources as documents, to propose Workflow notes, and to finish with a summary.
- **FR-139**: Finishing onboarding MUST give the owner one review card: what was created and enriched, the documents and decisions added, open questions, the proposed Workflow notes, and *Install agent files*.
- **FR-140**: Agents MUST NOT change a project's settings or delete a project. Projects an agent created are marked as such until the owner reviews them.
- **FR-141** (owner decision 32): By default (local trust), the UI MUST open without an unlock step, and agents MUST connect from the local machine without a token. The Host and Origin guards (FR-100) MUST still apply in every mode.
- **FR-142**: Every owner action MUST record how it was made (the browser UI, or another client such as a script, identified by its user agent), and Activity MUST show it.
- **FR-143**: A **protected mode** setting MUST restore the owner session (FR-101) and the agent bearer token. Turning it on or off MUST be an explicit configuration change, never done from the UI by an agent.
- **FR-144**: The agent-files install MUST also write each client's project connection file into the repo (`.mcp.json` for Claude Code, `.codex/config.toml` for Codex), containing no secret. In protected mode it references the token through an environment variable. *Check* and drift MUST cover these files.
- **FR-145** (owner decision 33): Work steps MUST support optional details (Markdown, ≤ 10,000 characters) and an optional source (≤ 100 characters, for example a Jira key), versioned with the plan like the rest of the step.
- **FR-146**: The owner UI MUST show a step dialog (title, status, source, rendered details, history, subagent notes, previous and next, editable details with a conflict check). Rows show a details indicator; there's no inline expansion.
- **FR-147**: Agents MUST be able to write details and source in `set_plan`, update details in `update_step`, and read one step in full with `get_step`. Ordinary item reads MUST show only a details marker; `get_context` MUST include the current step's details within its budget.
- **FR-148**: The Jira import MUST put each sub-task's description into its step's details (with a header line for assignee, dates and story points), set the source to its Jira key, and collect all sub-task comments into one note on the parent, grouped by sub-task.

### Key Entities

- **Project**: a bounded area of work, with a key, a name, a blocker rule, and its labels, decisions and documents.
- **Item**: an Epic, Story, Task or Bug, with its status, priority, outcome, acceptance criteria, dates, effort and archive state; it belongs to a project and optionally to an epic.
- **Link**: a "blocks" link (optionally with its own blocker rule) or a "relates" link between two items.
- **Label**: a named group within a project, with an optional brief, for initiatives that span epics.
- **Checklist**: on each item, three lists: Work steps (the agent's plan, versioned), Agent checks (self-verification with evidence), and Human review items (what the owner verifies).
- **Run**: one agent execution on an item (lead or child), with its client, label, signals, lease and outcome.
- **Subagent log**: a short, attributed record of a subagent's contribution under a work step.
- **Handoff packet and review decision**: one packet per review round, and the owner's decision per item in it.
- **Question and owner note**: messages between agent and owner, each delivered once.
- **Decision record**: a scoped, authoritative (owner) or advisory (agent) decision with its rationale and status.
- **Document**: a named file on an item or project, with immutable versions.
- **Commit and artifact**: reported delivery evidence (commits, PRs, CI runs, deployments, URLs).
- **Event**: the immutable record of every change.
- **Workspace**: where a run's work lives (host, repo, worktree path, branch, base, head and pushed commits, uncommitted flag), with a derived state: in use, parked, at risk, safe to prune or unknown.
- **Brief**: the exact instructions a run was given, stored immutably with the item.
- **Resource**: a long-lived thing a run started (a process, dev server, session, container, temp directory or port), with how to find it, and when it was released and by whom.
- **AgentFile / AgentFileVersion**: a skill or the AGENTS.md block, in a layer (bundled, service, or project), with immutable versions, content hash, author and note.
- **ProjectWorkflow**: a project's Workflow notes, versioned, delivered in `get_context`.
- **Install**: one install of an effective file set: when, client, target (repo or user-wide, path), method (command or push), and the version of every file sent.
- **AgentFileProposal**: an agent's proposed new content for a file or Workflow notes, with its reason, the version it was based on, its state (pending, approved, declined) and who decided.
- **InstructionReport / Drift**: the instruction hashes reported for an installed location (by a scheduled push-folder check or an agent's claim), the differences from what was sent, and the owner's remedy (adopted, restored, kept local).
- **Onboarding**: a project's onboarding session: who started it, when, its state (in progress, ready for review, reviewed), the agent's summary, and the changes it made.
- **WorkStep details**: optional Markdown details and a source on a checklist step; read in the step dialog, or by agents with `get_step`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From connecting, an agent finds, claims and has full working context for the best available item in at most 4 calls, receiving no more than about 3,500 tokens of results in total on the sample data.
- **SC-002**: Re-reading an item's status costs an agent no more than about 300 tokens, and a 25-item search no more than about 1,000, measured on the compact text block, which is all a text-only client's model reads, so for those clients it is met by design (MCP_SPEC §3 Results). Regressions beyond 20% fail the build.
- **SC-003**: Across 100 simultaneous attempts by two agents to claim the same item, exactly one succeeds every time, and no update is lost.
- **SC-004**: When an item's last blocker clears, it appears in agents' ready list on the very next request, with no human or agent action.
- **SC-005**: The owner can tell what needs them, and act on the first item, within 10 seconds of opening the UI, without scrolling, on a 1440×900 screen at sample-data volume.
- **SC-006**: The owner can verify a two-item handoff and record a decision in no more than 4 clicks beyond the verification work itself.
- **SC-007**: 100% of runs open at a restart show as interrupted afterwards, and 0% as finished.
- **SC-008**: Replacing the container loses 0 items, events or documents, and a restored backup matches the original exactly.
- **SC-009**: A new owner goes from a clean machine to a connected agent in 10 minutes or less by following the README.
- **SC-010**: Every owner-facing screen passes automated accessibility checks with no serious or critical issues, in both themes.
- **SC-011**: A Jira dry run of 500 issues completes in under 2 minutes and accounts for 100% of issues as imported, skipped or lossy.
- **SC-012**: In the pilot, agents follow the workflow (claim before work, plan in the checklist, hand off through packets) without reminders in at least 90% of items, and the owner checks Docket instead of Jira for status.
- **SC-013** *(default, not asked)*: At the stated scale, owner views appear in under 1 second, and 95% of agent requests complete in under half a second on the owner's machine.
- **SC-014**: After a simulated crash with at least three in-flight runs (active, parked, at risk), a coordinator can re-dispatch every interrupted run from the restart list alone (no conversation history, no probing), with 100% of briefs recovered unchanged. 100% of declared resources left running are reported as orphaned within 15 minutes.
- **SC-015**: A new owner finds and opens the right Help article from the screen they're on in one click, for every state named in the UI (parked, stale, at risk, safe to prune, and so on).
- **SC-016**: For any installed copy, the owner can tell within one minute which file versions were sent and whether each was edited locally.
- **SC-017**: An instruction file edited outside Docket is surfaced to the owner within 15 minutes for push installs, or by the next agent claim on that project otherwise, in 100% of cases in the drift test suite.
- **SC-018**: Onboarding the fixture repo after a fixture Jira import creates no duplicate items: 100% of Spec Kit tasks that match an imported Jira item enrich it, and the owner can review the whole onboarding from one card.
- **SC-019**: From a fresh install to a connected agent in a repo takes no typed commands beyond starting Docket: open the UI, create or import a project, click *Install*, and approve the client's one-time prompt.
- **SC-020**: After a Jira import, 100% of sub-task descriptions and comments in the fixture are readable in Docket (in step details and the parent's note), and `get_item` standard for an item with 10 detailed steps stays within its token budget.

## Assumptions

- One owner, one machine. V1 has no multi-user accounts, and no access from other devices.
- Agents are installed clients (Codex, Claude Code) and the same clients launched as workers by an orchestrator (Orca). Each connects directly; a client-side bridge is needed only if a specific client can't.
- The orchestrator, or the owner, starts agents. Docket only coordinates them (owner decision 18).
- The agents' own workflow files (`AGENTS.md`, `CLAUDE.md`) carry project-specific rules: when to declare human review, whether agents may move work to Ready, which planning documents are expected. Docket stores and shows these choices but doesn't enforce them (owner decision 11).
- "PR merged" is reported by agents in V1. Observing merges and CI directly is out of scope (ROADMAP.md).
- V1 is built and verified with disposable sample data. A pilot project is chosen afterwards, following ROADMAP.md §1.
- Effort is measured in points, and dates in the owner's local time zone.
- **Scale (default, not asked):** up to 20 projects, 5,000 items, 100,000 events and 10 GB of documents on one machine, with up to 10 agents connected at once. Beyond that is out of scope for V1.
- Event and document retention is unlimited, until the owner archives (which hides) or deletes (which removes) a project.
- Out of scope for V1:
  - editing planned dates, effort and blocker links in the UI (agents edit them; the owner edits the text fields, see Clarifications);
  - a restore UI;
  - bulk agent tools;
  - sprints;
  - GitHub or CI integrations;
  - a dispatcher;
  - versioned contracts;
  - a knowledge layer beyond decision records.
