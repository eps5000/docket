# Candidate product requirements

> **Docket (formerly Task Lite).** This draft is history: it keeps the name the product had when it was written.

Status: discovery draft, updated 2026-11-07. **Superseded as the requirements of record by [specs/001-task-lite-v1/spec.md](../specs/001-task-lite-v1/spec.md), and for building by [BUILD_SPEC.md](BUILD_SPEC.md), [MCP_SPEC.md](MCP_SPEC.md) and [UI_SPEC.md](UI_SPEC.md);** this file remains the record of owner decisions and the original requirement IDs those documents cite. The confirmed choices below are owner decisions; remaining requirements are proposals to test with real agents. Background: [Jira capability research](JIRA_RESEARCH.md).

## Confirmed owner decisions

1. Build and verify MVP V1 before selecting a pilot project. Then pilot one project before any broader Jira replacement. No pilot project is selected yet; active projects stay on Jira during their current work.
2. Codex and Orca workers must connect on day one. Claude must also be supported. Use the already installed agent clients; do not require this service to call model APIs or launch new model instances.
3. Subagent steps do not need separate work items. A ticket must show what the lead agent plans to do, what is underway, what is complete, and what subagents contributed. A short attributed subagent log entry is sufficient when detailed session telemetry is unavailable.
4. Review documents and Markdown artifacts live in local project-associated storage managed by the service. Git publication happens only when the actual project's workflow explicitly calls for it.
5. Approval gates vary by project and its agent workflow. Some projects require explicit owner approval at defined points; others allow an agent to finish and report completion without an owner gate.
6. Human and agents may enter or change planned dates. Effort values and velocity-based backlog forecasts are desirable planning additions; forecasts must be distinguished from entered dates.
7. The V1 browser UI is available on the host machine only. Other-device or public access is outside the V1 boundary; this public repository should keep local-only networking as its default.
8. The workflow includes a **Planning** status between Inbox and Ready. Planning is the owner's stage: planning artifacts (for example UI/UX design, PRD, TDD) are produced there, and the owner moves an item to Ready, or tells an agent to, when it is actually ready to build. (Added 2026-11-06.)
9. Ceremony should fit the risk. Which planning artifacts a ticket needs is settled during Planning and by each project's agent workflow; small changes may skip UX/TDD, and high-stakes production work may require all of them. (Added 2026-11-06; revised the same day.)
10. The browser UI starts at an all-projects view on each visit, so the owner is never unknowingly scoped to a single project. (Added 2026-11-06.)
11. Per-item planning exceptions and readiness rules are decided by each project's agent constitution and workflow. The tracker stores and shows the project's configuration and records deviations; it does not enforce them. (Added 2026-11-06.)
12. V1 item types are Epic (the only container), Story, Task, and Bug. An Epic still in Planning acts as the brief for work not yet broken down. Large initiatives that span several epics use a label with an optional brief rather than a level above Epic. Small steps are checklist items on the ticket; subtasks are not in V1. (Added 2026-11-06; revised the same day.)
13. Human review is verification after implementation, not part of Planning. Agents declare human review items on a ticket, usually during Planning. When the work is built and the agent's own checks pass, the agent supplies a handoff packet telling the owner how to verify. The owner approves (the ticket closes) or requests changes (each finding becomes a checklist item or a new bug ticket, and the agent prepares another round). A ticket cannot close while any human review item is undecided; with no human review items, the agent may close it once its checks pass. The owner may also **defer** an item: this clears the gate but records the item as deferred, not verified, optionally creating a follow-up test ticket. Packets record the commit they were built from and are marked out of date automatically when an agent later reports a different commit for the ticket. Approvals carry forward across rounds. Agents may create labels. Commits are reported for a specific ticket, so only commits for that ticket (or, for an epic-level packet, any ticket in the epic) mark a packet out of date. When an epic ships as one PR, human review may be declared once on the epic instead of on each child. Deferred, not-verified items stay visible to the owner and to agents (for cleanup) until resolved. (Added 2026-11-06.)

14. The V1 stack is TypeScript end to end: Node 22, the official MCP TypeScript SDK, Hono, SQLite via better-sqlite3 + Drizzle, and React + Vite for the UI. (Added 2026-11-07.)
15. O11's project-level approval policies are superseded by decision 13. Gates are per-ticket human review items, declared according to each project's agent workflow; the tracker enforces only that a ticket can't close while a review item is undecided. H06 reads "a ticket with human review items" where it says "a project with a required owner gate". (Added 2026-11-07.)
16. One agent bearer token serves all clients. The calling client is identified from the MCP handshake (`clientInfo`), plus an optional agent label such as `orca-w3`. A separate owner key, held only by the browser, protects owner actions. (Added 2026-11-07.)
17. V1 also includes four P1 items: the Timeline layout, Label pages, burn-down and forecast (H14, A18), and the Jira import dry run and import (O05). (Added 2026-11-07.)
18. Task Lite is the coordinator, not the dispatcher. It is the authoritative record of what work exists, what is eligible to start, who holds it, and the rules (blocking, leases, review gates), and it enforces them. Orca, or the owner, decides when to start agents (decision 2 reaffirmed after the 2026-11-14 "development control plane" review). Revisit after the pilot. (Added 2026-11-14.)
19. V1 adds four coordination features from that review: a context bundle for agents (`get_context`), decision records that every agent reads (owner records are authoritative), lean agent responses (summary views, field selection, compact text, token budgets), and stricter dependency rules (a blocker can be required to be merged or verified, not just done). (Added 2026-11-14.)
20. TERSL / Tourbillon is a reference to learn from, not a dependency. No TERSL format or TERSL/DB in V1; the learnings applied, and an optional post-V1 experiment, are in [ROADMAP.md](ROADMAP.md). (Added 2026-11-14.)
21. Opt-in desktop notifications in the browser for new "for you" events only (handoff ready, question asked), plus the for-you count in the tab title. Nothing leaves the machine. (Added 2026-11-14, spec clarification.)
22. The owner can edit an item's title, description, outcome and acceptance criteria inline in the UI. Planned dates, effort and blocker links stay agent-edited in V1. (Added 2026-11-14, spec clarification.)
23. The owner can cancel any open item from the UI, with an optional reason and Undo. (Added 2026-11-14, spec clarification.)
24. Nightly backups stay in the service's data volume by default; the owner can opt in to an extra copy in a folder on the host machine. (Added 2026-11-14, spec clarification.)
25. The browser UI requires the owner key to unlock, once per browser, with a 30-day session from last use; the owner can lock a browser or rotate the key. (Confirmed 2026-11-14, spec clarification.)
26. Recovery support: runs record where their work lives, the orchestrator's IDs, their brief and the resources they start; runs can park while waiting on purpose; a restart list lets a coordinator re-dispatch interrupted work without guessing; the owner sees orphaned resources and unpushed work at risk. Task Lite records; the coordinator acts. Prompted by an Orca crash that pruned worktrees holding in-flight work. (Added 2026-11-15.)
27. Agent skills ship with Task Lite as plain files in `skills/`, so the owner can hand them to Orca or any agent and edit them to fit their own tooling: two core (`tasklite-worker`, `tasklite-coordinator`) and three optional (`tasklite-planner`, `tasklite-review-packet`, `tasklite-lead-subagents`). Not served over MCP in V1. (Added 2026-11-15.)
29. Help and agent setup inside Task Lite (2026-11-17). A **Help** area of short how-to articles for the owner, with contextual links from each screen. An **Agent setup** area where the owner views, edits and installs the agent files Task Lite ships (the skills and the AGENTS.md block), in three layers: bundled, service-wide edits, and per-project overrides, because projects may run their own workflow tools (for example Spec Kit) and need tailored skills. Each project also gets **Workflow** notes delivered to agents in `get_context`. Install by a copy-paste command, or by an opt-in push into a host folder the owner mounts. Every install is logged with the exact file versions, and Task Lite can show when installed copies were edited locally, so the owner can tell whether bad instructions caused a problem. Serving the files over MCP stays on the roadmap. (Decision 28 is the per-client result mode in BUILD_SPEC.)
30. Agents may change agent files only by proposing, and the owner approves (2026-11-18). Agents read the current agent files and Workflow notes through MCP and propose a change with a reason. The owner approves, edits then approves, or declines, and history records who proposed and who approved. Because people and agents will still edit installed files directly (in VS Code, Orca or a terminal), Task Lite also **detects drift**: it checks installed copies in the push folder on a schedule, and agents report the hashes of the instruction files they actually have when they claim work. A drifted file shows up for the owner with a diff and three remedies: adopt it as the project's copy, restore Task Lite's version, or keep the local version on purpose. Each run records which instruction versions it worked from.
31. Onboarding a project, with nothing installed first (2026-11-18). The owner can create a project in Settings (*New project*). Any connected agent can onboard a repo through MCP: `onboard_project` creates the project, or adopts an existing one (for example, right after a Jira import), and returns the onboarding guide in its result, so no skills need installing first. The same guide is offered as the first MCP prompt for clients that support prompts. The agent surveys the repo's planning sources (Spec Kit specs, plans and tasks, issues, TODOs, docs), reconciles them with items already in the project (matching Jira keys and titles, enriching rather than duplicating), creates everything in Planning, proposes Workflow notes, and calls `finish_onboarding` with a summary. The owner reviews from one Needs you card, which also offers installing the agent files. Agents can create and fill projects but can't change a project's settings or delete it. Prompted by the Gameflow pilot (GitHub code, Spec Kit planning, Jira tickets).
32. Local trust by default (2026-11-18). Docket runs on the owner's machine, so the owner unlock and the agent token were extra steps without much real protection: an agent with a shell can read the owner key anyway. By default there's no unlock and no agent token; the Host and Origin guards stay, so websites and other machines still can't reach it, and every owner action records whether a browser or a script made it. An opt-in **protected mode** restores the owner session and the token. Connecting agents needs no commands: the agent-files install also writes each client's project connection file (`.mcp.json` for Claude Code, `.codex/config.toml` for Codex), which contain no secret, and the client asks once to approve or trust it. Supersedes the parts of decisions 16 and T2 that required a token and an owner key by default.
33. Checklist steps carry details (2026-11-18). A work step keeps its ID, title, status and history, and gains optional **details** (Markdown) and a **source** (for example a Jira key). The owner reads and edits a step in a **step dialog** (not an inline accordion), which shows the title, status, source, details, history and subagent notes, with previous and next. Agents read details on demand, so ordinary reads stay small. The Jira import turns each sub-task into a step on its parent with its full description in details and a header line for assignee, dates and points, and collates all the sub-tasks' comments into one note on the parent. Prompted by the Gameflow pilot, where sub-tasks carry real descriptions.

## Product intent

A locally run Docker service coordinates AI agents' work: it gives them a stable MCP endpoint and is the enforced source of truth for work, dependencies, claims, decisions and review gates (owner decisions 18–19). A human supervises through a UI that shows the portfolio, dependencies, timing, agent activity, documents, and decisions that need review. Task state, agent execution state, review state, and delivery evidence must remain distinguishable.

## Core objects to validate

| Object | Purpose | Key relationships |
| --- | --- | --- |
| Project | Bounds a product or work area | Contains outcomes, work items, project-local artifacts, and an optional approval policy linked to its agent workflow documents. |
| Work item | Epic, Story, Task, or Bug | Optional epic; labels; explicit typed links; priority, status, dates, acceptance; lead claim by an agent rather than an assignee. |
| Dependency | Directed `blocks` edge between work items | Independent of hierarchy, ordering, and `relates`. |
| Checklist | Three short lists on one work item: Work (the agent's plan), Agent checks (its own verification), Human review (what the owner must verify) | Items are one or two sentences with state and history; they are not work items. A Work item that outgrows the checklist becomes its own Story or Task. |
| Agent run | One actual execution/session, including an optional delegated subagent record | References work item, plan step when relevant, and optional parent run; actor, timestamps, state, output. |
| Artifact | Locally stored document/file or a linked URL, commit, PR, test, build, deployment, screenshot, etc. | Project owner, version/source, and work item/run references. Local bytes stay in persistent storage. |
| Human review and handoff packet | An agent-written packet per review round, and an attributed owner decision per human review item | Approved or changes requested, with notes; findings become checklist items or bug tickets; decisions bind to that packet version. |
| Event | Immutable activity/provenance record | Actor, timestamp, object, action, prior/new values or evidence reference. |

## Agent-facing candidate requirements

Priority labels: **P0** is necessary for a useful first release; **P1** adds planning and oversight depth; **P2** is optional.

| ID | Priority | Requirement and observable result |
| --- | --- | --- |
| A01 | P0 | A documented, stable MCP endpoint can be reached by installed Codex, Claude, and Codex/Claude launched as Orca workers, including two simultaneous clients, without a per-agent Jira login or interactive UI. Client setup survives container restart. |
| A02 | P0 | Agents can list/search projects and work items with bounded, paginated results and request one full item with parent, blockers, status, acceptance, and artifact links. |
| A03 | P0 | Agents can create/update work items with stable IDs, type, title, description, priority, owner, acceptance criteria, parent, and planned dates. The server validates references and required fields. |
| A04 | P0 | Agents can add/remove typed links, including directional `blocks`; cycle creation is rejected and the response explains the cycle. |
| A05 | P0 | Agents can query “ready to start,” “blocked and why,” “assigned to me,” and “waiting for review.” Ready work excludes unresolved blockers and any prerequisite owner decision that is still pending. |
| A06 | P0 | A lead agent can register a run on a work item, report progress, and end with a result. A subagent contribution can be an attributed log entry; when the client exposes reliable run identity, it may also be linked as a child run. Missing heartbeat data is shown as unknown rather than silently completed. |
| A07 | P0 | Concurrent updates use versions or equivalent conflict detection; retried create/event calls use idempotency keys. A conflict returns the current record and actionable error. |
| A08 | P0 | Agents can add comments/progress notes and link artifacts with type, source, version/hash where available, and evidence state. |
| A09 | P0 | Agents can request human review and read the decision when the project's workflow calls for it. An agent may report completion without an owner gate in a project configured for that path; only an attributed owner decision records human approval. |
| A10 | P0 | MCP failures return structured, concise errors for validation, conflict, permission, unavailable dependency, and internal failure; health diagnostics never require computer use. |
| A11 | P1 | Agents can ask for a dependency subgraph, critical blockers, and the downstream impact of a proposed delay. Results state whether dates are explicit or estimated. |
| A12 | P1 | Bulk read and bounded bulk mutation let a coordinator work on several items efficiently; writes remain individually attributable and reversible where possible. |
| A13 | P1 | Agents can subscribe/poll for changes since a cursor so they do not repeatedly reread the whole board. |
| A14 | P2 | The service can link source control and CI evidence automatically, provided a trustworthy integration is configured. |
| A15 | P0 | An agent can atomically claim or release lead coordination of a work item. A second lead claim reports the current claimant and lease state; delegated work under the lead is allowed. |
| A16 | P0 | The lead agent can publish and revise a ticket plan: planned steps, current step, completed steps, blocked/skipped steps, and brief progress notes. Revisions retain history so the owner can see scope changes. |
| A17 | P0 | An agent can record a subagent's name or handle, assigned step, outcome, and evidence as a short ticket log entry without creating another work item. The entry states whether the outcome was directly observed or relayed by the lead. |
| A18 | P1 | Agents can set an effort value for a work item using the project's chosen unit (for example points), and the service retains estimate changes for burn-down and forecast calculations. |

## Human-facing candidate requirements

| ID | Priority | Requirement and observable result |
| --- | --- | --- |
| H01 | P0 | A local browser UI shows all projects and a focused work list/board with status, priority, owner, blockers, and last activity; search/filter reaches a work item quickly. |
| H02 | P0 | An attention view shows items awaiting decision, blocked work, stale agent runs, failed runs, missing evidence, and due/forecast risks, with links to the exact item. |
| H03 | P0 | A work item page shows outcome, acceptance, decisions, directed blockers, agent runs, current evidence, and full activity history. Each statement identifies its source and time. |
| H04 | P0 | When review is requested, the owner can open the submitted local document/artifact version, comment, approve, request changes, defer, or waive with rationale. A later revision makes the earlier approval visibly version-specific. |
| H05 | P0 | The UI shows the lead run and reported subagent work on the ticket, including current task, last update, state, and output link when available. It distinguishes live client telemetry from agent-reported progress and marks stale/unknown state explicitly. |
| H06 | P0 | Human approval, agent-reported completion, automated check, CI result, merge, deployment, and production observation display as distinct evidence. A project with no owner gate may reach Done from agent completion; a project with a required owner gate cannot. A screenshot or CI result never impersonates human approval. |
| H07 | P0 | A dependency graph highlights the blocking chain, cycles (including imported bad data), and what becomes ready when a blocker clears. |
| H08 | P0 | A timeline shows human- or agent-entered planned dates and actual dates alongside blockers. It labels who set each date and when. Computed forecasts appear separately when available. |
| H09 | P1 | A portfolio view summarizes progress, throughput, aging, review queue, and changed scope over a selected period. It can answer “what are agents doing now?” and “what needs me next?” |
| H10 | P0 | Project-associated Markdown and other review documents are stored locally, previewed, versioned, and downloaded through the UI. External links can be recorded as references, but the service does not push documents to Git unless the project's explicit workflow does so. |
| H11 | P1 | The owner can edit priority, dates, blockers, acceptance, and review decisions in the UI; such changes appear in history and agent queries immediately. |
| H12 | P2 | Optional sprints, release grouping, and customizable dashboards support broader planning only if useful after the initial workflow is proven. |
| H13 | P0 | The ticket page puts the agent's plan, in-progress steps, completed steps, and subagent contributions in one progress view, with timestamps and links to supporting evidence. The owner can see what remains without reading a raw transcript. |
| H14 | P1 | A burn-down view shows remaining effort over time for a project or selected agent. A backlog forecast uses observed completed effort over a stated window and displays its assumptions, sample size, and uncertainty; it does not overwrite planned dates. |

## Local operation and data requirements

| ID | Priority | Requirement and observable result |
| --- | --- | --- |
| O01 | P0 | `docker compose up` starts the service with persistent local storage mounted inside the container; container replacement retains work, run history, and documents. Health and readiness endpoints identify database/storage failure. |
| O02 | P0 | The V1 browser UI and host MCP endpoint bind to loopback by default. Authorized host-based Orca workers can connect; any other container-client network path must be configured explicitly. MCP requests authenticate and browser origins are restricted. No secret is written into task content or logs. |
| O03 | P0 | The server records every mutation with actor, time, old/new version, and correlation/idempotency ID; it supports a recoverable backup and restore that includes project documents. |
| O04 | P0 | The same work state is exposed through MCP and the human UI. No hidden second task store is introduced for agents. |
| O05 | P1 | A dry-run Jira import reports mapped, skipped, and lossy fields (including links, comments, attachments, users, history); the owner reviews the report before import. Original Jira keys remain searchable references. |
| O06 | P1 | A complete machine-readable export makes departure from this service possible without screen scraping. |
| O07 | P0 | Before a live pilot, setup includes a compatibility matrix and an end-to-end smoke test for installed Codex, installed Claude, and each intended Orca worker surface. Verify against disposable V1 sample work that a delegated agent can read and update the same ticket. |
| O08 | P0 | The service is a task/data server; it does not require OpenAI or Anthropic model API credentials. If an agent surface cannot attach directly to HTTP MCP, a local client-side bridge may be used and tested for that surface. |
| O09 | P0 | MVP V1 can be exercised with a disposable sample project and representative tickets, agent plans, blockers, and review artifacts. No Jira import or live-project cutover is required to build or verify V1. |
| O10 | P0 | Deleting a project through the service removes its work records and project-associated local documents together after an explicit owner action. Backups have a separately documented retention and purge policy; deleting a container alone does not imply deleting its data. |
| O11 | ~~P0~~ superseded (decision 15) | Each project can select an approval policy consistent with its agent workflow documents: no owner gate or one or more named owner gates. The service applies the selected policy to Done transitions while preserving the distinction between agent assertions and owner decisions. |

## Initial workflow hypothesis

`Inbox → Planning → Ready → In progress → Review → Done`, with `Blocked` as a derived condition and `Canceled` as an explicit terminal outcome. Agents may produce planning artifacts for an item in Planning, but "ready to start" queries (A05) return only Ready items. The proposed design lets each project define which planning artifacts must be approved before Ready; see [UI design](UI_DESIGN.md). Review is used when the project's workflow requires or requests it; a no-approval project can move from In progress to Done after agent-reported completion. An item in Review can return to In progress after changes are requested. Run state (`working`, `needs input`, `finished`, `failed`, `stale`) is separate from work item status. The Planning status and the project-dependent approval choice are confirmed; the other statuses are still a proposal.

## MVP V1 boundary proposed for discussion

Build P0 work records, ticket plans, directional blockers, agent progress and subagent logs, project-configured approval, local review documents, an attention-focused host-only UI with a dependency graph and entered-date timeline, persistent Docker storage, and verified Codex/Claude/Orca MCP connectivity. Exercise V1 with disposable sample work and real local clients. Effort-based burn-down and velocity forecasts are P1; bulk automation, Scrum metrics, and full Jira scheme/plugin parity can wait until their need is demonstrated.

## Storage proposal to validate in design

For one local application host, use one service container with a SQLite database for structured work records and a project-scoped document directory, both inside a Docker named volume. The database and files are accessed only through the application. This avoids a MongoDB or separate database container for V1 while allowing project-level document deletion, backup, and restore. This is an implementation recommendation, not an owner-selected database contract. Docker volumes persist independently of container replacement. [Docker storage](https://docs.docker.com/engine/storage), [SQLite fit](https://www.sqlite.org/whentouse.html)

## Pilot after V1

Select a real project when V1 is usable and the owner has a suitable work stream. Decide then whether to start empty or import Jira records, and review any migration report before changing the project's source of truth. Active Jira work is not a prerequisite or a cutover target for V1.

## Deferred choices

Pilot project choice and Jira import strategy are deferred until V1 is ready for real work. Design should still settle the storage layout, supported document preview formats, the exact project gate configuration shape, and the minimum history needed before a velocity forecast is shown. These are implementation choices guided by the owner decisions above, not blockers to selecting a pilot now.

## Validation scenarios for the next pass

- Two agents try to claim/update one Story simultaneously; only one takes ownership, and the other receives current state and a clear conflict.
- A parent agent delegates two child runs. One succeeds, one stops heartbeating. The reviewer sees both outcomes and the parent remains unresolved.
- A lead agent posts a three-step ticket plan, starts the second step, reports a subagent's completed contribution in a short log, then changes the final step. The owner sees planned, current, completed, and changed work without extra tickets.
- Story B is blocked by Story A in another project. A moves to Done; B becomes ready and the graph/timeline update without treating mere parentage as a blocker.
- An agent uploads a document for review, then revises it after requested changes. Approval of the old version does not approve the new one.
- A PR merges and CI passes, but the required owner walkthrough is still pending. The work item remains in Review and the dashboard shows the pending gate.
- In a project configured without owner approval, an agent completes the declared acceptance and reports Done. The UI shows agent completion accurately without inventing an owner approval.
- An agent updates a planned date and estimates a ticket at five points. The timeline labels the entered date; the burn-down uses the effort value only after enough completed work exists to show a meaningful rate.
- A project with local Markdown reviews is deleted through the UI. Its work records and files are removed together, while retained backups follow the documented backup policy.
- Docker restarts during an active run; task data persists and the run is shown as interrupted/stale rather than falsely finished.
