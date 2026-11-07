# UI/UX design — MVP V1 human interface

Status: design proposal, revision 7, 2026-11-06. Inputs: [requirements draft](REQUIREMENTS_DRAFT.md), [Jira research](JIRA_RESEARCH.md).

Clickable prototype: [`design/prototype.html`](../design/prototype.html). It is one file with no build step and no network requests, and all data in it is disposable sample work (O09). Open it directly in a browser.

## What the UI is for

The product is agent-first: agents do the planning, building and bookkeeping over MCP. The browser UI exists so the owner can answer four questions quickly:

1. **What have the agents done?**
2. **What are they doing right now, and can I believe it?**
3. **What's next?**
4. **Is anything waiting on me, or coming my way?**

Anything that doesn't serve one of those questions stays out of the UI. Revision 4 broke that rule (custom item types, a Structure view, Feature and Design types), and revision 5 removes it all.

## Model

```
Epic ──► Story / Task / Bug ──► checklist
                                 ├─ Work          the agent's plan (subagent notes attach here)
                                 ├─ Agent checks  what the agent verifies itself, with evidence
                                 └─ Human review  what you must verify before Done (empty = nothing for you)
Labels cut across epics (large initiatives).   Blocks links are the only thing that makes work wait.
```

| Concept | Rule |
| --- | --- |
| **Types** | Epic, Story, Task, Bug. Epic is the only container. |
| **Epic** | Groups the work for one feature. While in Planning, the epic *is* the brief: it holds the PRD, UX and other docs for work not yet broken down. |
| **Large initiatives** | A **label** with an optional brief (agents can create labels too), e.g. `#ui-refresh` across several epics. The label page shows progress grouped by epic and can move everything with that label from Planning to Ready in one step. Agents query `label:ui-refresh` the same way. |
| **Checklist instead of subtasks** | If a step fits in a sentence or two, it's a checklist item. If it needs its own lead, blockers or review, it becomes its own Story or Task under the same epic. |
| **No assignee field** | Agents *claim* tickets (the lead claim, with a lease). You don't get assigned tickets; you get **human review items** and **questions**. |
| **Planning is yours** | Planning docs attach to the ticket or epic. You move an item to Ready when you're satisfied, or tell an agent to. The tracker doesn't enforce a definition of ready; the repo's agent workflow does. |
| **Human review** | Verification *after* implementation, described below. |

### Human review and handoff packets

1. **Declare.** The agent adds human review items to the ticket, usually during Planning, so you can see them coming. Each is a sentence: *"On your phone, drag recipes between days. Does it feel right?"* If a ticket has none, the agent may close it once its own checks pass.
2. **Hand off.** When the work is built and the agent's checks pass, the ticket moves to **Review** with a **handoff packet**: one versioned document per ticket per round. It has a fixed shape:
   - what you're verifying
   - how to verify it (steps, URL or build, roughly how long)
   - what the agent already checked, with provenance badges
   - known gaps
   - attachments (recordings, screenshots, docs)
3. **Decide.** You mark each item with one of three choices:
   - **Looks good:** verified, and recorded as your approval on that packet version. It also records the commit it was given on.
   - **Needs changes:** a note is required. The finding becomes either a checklist item on the ticket or a new Bug (linked back to the ticket).
   - **Defer:** clears the gate so work can continue, but the item is recorded as **deferred, not verified**, never as approved. An optional note says what's still needed. You choose the follow-up:
     - *Create a test ticket in Inbox:* the new ticket carries the same human review item, so the verification stays visible.
     - *No ticket:* the agent follows the project's workflow.

   **The outcome follows from your choices:**
   - **Every item approved or deferred:** the ticket closes. The button says *Close ticket (1 deferred)* when anything was deferred, and the closed ticket shows "review deferred, not verified".
   - **Any item needs changes:** the ticket returns to In progress and you get a round 2 packet. Approved items stay approved, and deferred items stay deferred.
4. **Out-of-date packets are detected without a Git integration.** Each packet records the commit it was **built from**. Agents already report progress over MCP, and each commit is reported **for a specific ticket**. If a later commit is reported for the same ticket (or, for an epic-level packet, for any ticket in that epic), the tracker marks the packet out of date by itself: Needs you flags it, and the packet shows a warning with *Ask for a fresh packet*. The agent doesn't have to remember to mark it. A Git or CI integration (A14) could supply the same signal later, but it isn't required.
5. **Review where the gate matters: on the ticket or on the epic.** If an epic ships as one PR, the agent leaves human review empty on its children and declares it once on the epic. The epic gets the packet when its work is ready to merge (see DOC-10). Agents shouldn't add human review to child tickets unless that gate really matters on its own.
6. **Deferred, not verified stays visible.** Needs you lists every deferred item with its follow-up: a test ticket and its status, or "no follow-up ticket" with a *Create test ticket* button. Agents query the same list (`review:deferred`) during cleanup, then finish the check or propose another plan. Work has a matching *Deferred review* filter.
7. **Earlier approvals carry forward.** They stay approved across rounds. If the code changes after an approval, the item shows a quiet "code changed since" note but isn't forced back into review. This can be tightened later if it becomes a problem.
8. **One rule the tracker always enforces:** a ticket can't close while any of its human review items is undecided. Everything else (whether a ticket needs human review, what goes in the packet, whether to skip a planning doc) belongs to the agent constitution and workflow in each project's repo.

## Design principles

| # | Principle | How it shows up |
| --- | --- | --- |
| 1 | **"For you" first.** | Needs you leads with packets to verify and questions to answer. Its badge counts only those. |
| 2 | **Never blur provenance.** | Badges distinguish *your decision*, *agent-reported*, *observed child run*, *relayed by lead*, *CI* and *git*. CI and merges never count as approval. |
| 3 | **Unknown is not done.** | Run state is shown as icon plus label (live, reported, stale, needs input, failed, finished, interrupted). Stale never becomes a check mark. |
| 4 | **Blocked is derived.** | Only unresolved `blocks` links make work wait. Epics and labels never do. |
| 5 | **Decisions bind to versions.** | Your decision applies to one packet round. A new round never inherits an earlier approval. |
| 6 | **Entered ≠ forecast.** | Dates show who set them. A forecast is drawn only when there is enough history. |
| 7 | **Colour means state, never priority.** | Priority is shown with neutral signal bars. |
| 8 | **Scope is always visible.** | One project switcher at the top of the sidebar scopes every work page. Every visit starts at *All projects*. |
| 9 | **Reversible or confirmed.** | Owner actions show an Undo toast. Destructive actions explain their scope and require confirmation. |

## Information architecture

```
Sidebar                                   Ticket page
┌ Project ▾ [All | Recipe App | Docs]     ├─ Header: ID · type · epic · labels · status · priority · Move to Planning/Ready
│  ── scoped to the chosen project ──     ├─ Banner when you must act: packet ready / agent question
├─ Needs you     badge = for you now      ├─ Outcome + acceptance
├─ Work          Board | List             ├─ Tabs: Checklist (Work · Agent checks · Human review) · Documents · Activity
├─ Human review  badge = packets ready    └─ Rail: Lead & runs · Dependencies · Dates & effort
├─ Dependencies
├─ Timeline                               Epic page: brief, documents, items by status with progress
├─ Agents                                 Label page: brief, progress by epic, "Move N to Ready"
│  ── service-wide ──
├─ Projects
└─ Connections
Header: breadcrumb · search/jump (Ctrl K or /; items, labels, pages) · theme
```

## Screens

### Needs you (home)
- **Ready for you:** handoff packets to verify (round number, how many items, about how long) and agent questions, answered inline.
- **Problems:** stale or failed runs, dependency cycles, and date conflicts. Sorted by how much work each holds up.
- **Coming up for you:** declared human reviews (including epic-level ones) on work not yet in Review, with where each ticket is now ("in progress · 1/4 work items done", "ready · blocked by DOC-4").
- **Deferred, not verified:** every deferred check, with its test ticket or a *Create test ticket* button.
- **Your Planning queue:** everything in Planning, with *Move to Ready* on each.
- **Agents right now**, and **Since you looked**.

### Work
- **Board columns:** Inbox · Planning (yours) · Ready (Startable / Waiting on blockers) · In progress · Review (your human review) · Done.
- **Cards:** type, epic, labels, run state, plus chips for *Packet ready*, *Human review later*, *Question for you*, *Blocked*, and *Date risk*.
- **Filters:** epic, label, and saved filters (In planning, Ready to start, Blocked, For you, Human review later, Live run). Each shows the matching agent query.

### Ticket
- **Checklist tab:**
  - **Work:** items with state, who and when. Subagent contributions are nested under the item they belong to. Revised items show the old text. Items added from your review say so. A history view shows every revision.
  - **Agent checks:** each check with its state (passed, failed, not run) and evidence.
  - **Human review:** each item with its state (Coming up, Ready for you, Approved). If you sent an item back, it shows your note and where it went. If there are no items, the tab says the agent can close the ticket on its own.
- **Documents tab:** planning docs (PRD, UX, TDD) and handoff packets.
- **Rail:**
  - **Lead & runs:** the lease, any rejected claims, stale-claim release, and *Return to Ready* after a failed run.
  - **Dependencies.**
  - **Dates** with who set them.

### Human review
- **Queue:** Ready for you, Decided, and Coming up.
- **Packet:**
  - A round selector. Earlier rounds are read-only and show your past decisions.
  - The commit the packet was built from, and an out-of-date warning if the code has moved on.
  - Each item with *Looks good*, *Needs changes* or *Defer*. Changes need a note and a choice: *checklist item* or *new bug ticket*. Defer takes an optional note and a follow-up choice.
- **The submit button names the outcome:** *Approve and close ticket*, *Close ticket (1 deferred)*, or *Send back to codex*. A footnote says exactly what will happen.

### Labels and epics
- **Label page:** brief, progress grouped by epic, *Move N to Ready* for everything with that label still in Planning, and a link to the filtered board.
- **Epic page:** brief, documents, and items grouped by status with progress. A Planning epic is described as "still a brief".

### Dependencies, Timeline, Agents, Connections, Projects
Unchanged from revision 3 apart from simplifications:
- **Dependencies:** graph with blocking chain, what finishing an item would free, cycle fix, delay what-if, and items from other projects shown dashed.
- **Timeline:** entered dates vs actual run time vs forecast.
- **Agents:** run table with "how we know".
- **Connections:** client compatibility matrix, setup snippets, service health.
- **Projects:** switch scope, labels, progress, and typed-confirmation delete. The per-project policy, ready-gate and item-type settings are gone.

## Visual language

### Work status
| Status | Colour |
| --- | --- |
| Inbox | gray |
| Planning | teal |
| Ready | blue |
| In progress | violet |
| Review | amber |
| Done | green |
| **Blocked** (derived) | red chip shown *next to* the status |

### Run state (icon shape + text label)
| Label | Icon |
| --- | --- |
| live | solid green, pulsing |
| reported | violet ring |
| stale | dashed ring |
| needs input | amber with "?" |
| failed | red with "×" |
| finished | gray with "✓" |
| interrupted | ring with "–" |

The pulse is disabled under `prefers-reduced-motion`.

### Provenance badges
| Badge | Style |
| --- | --- |
| Your decision | **solid green fill, person icon**. The only badge that means human approval. |
| Observed child run | solid violet outline |
| Agent-reported | dashed violet outline |
| Relayed by lead | dotted gray outline |
| CI | blue tint |
| Git | neutral; never approval |

### Human review states
| State | Chip |
| --- | --- |
| Coming up | gray |
| Ready for you | amber |
| Approved | green |
| Deferred · not verified | blue |

### Tokens
All text is at least 4.5:1 and control borders at least 3:1, in light and dark mode.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--ink-3` | #5f6878 (5.6:1) | #99a2b4 | Secondary text |
| `--ctl` | #8a929f (3.1:1) | #6f788a | Control borders |
| `--ok` | #237032 | #5bd06f | Done, your approval |
| `--warn` | #9a4705 | #f0a020 | For you, review |
| `--bad` | #c22b2b | #ff7b7b | Blocked, failed, conflict |
| `--info` | #1864ab | #5cb3f8 | Ready |
| `--violet` | #6741d9 | #a990ff | Agent work |
| `--teal` | #0b7285 | #3bc9db | Planning |
| `--on-fill` | #fff | #0f1115 | Text on solid fills |

Base type is 13px; secondary text is at least 11.5px. Small controls are at least 28px tall.

## Accessibility
- **Semantic controls:** cards and IDs are links; actions are buttons. Graph nodes are focusable buttons.
- **Keyboard patterns:**
  - Tabs follow the ARIA tabs pattern.
  - Verdicts and decisions are radio groups.
  - Dialogs trap focus, close on Esc, and focus *Cancel* first when the action is destructive.
- **Focus is kept across re-renders.** Toasts announce politely.
- **Run states, review states and provenance always carry text**, never colour alone.

## Validation scenarios in the prototype
| Scenario | Where |
| --- | --- |
| Packet ready; approve and close; dependent work unblocks | Needs you → RCP-12 → mark both items *Looks good* → *Approve and close*. RCP-22 becomes startable. |
| Defer a check | RCP-12 packet → *Looks good* + *Defer* (test ticket) → *Close ticket (1 deferred)*. A "Verify: …" ticket appears in Inbox, carrying the review item. |
| Deferred list and cleanup | Needs you → *Deferred, not verified* (RCP-11 has test ticket RCP-29; DOC-2 has none → *Create test ticket*) |
| Epic-level review (one PR) | DOC-10 API reference: human review on the epic, none on its child DOC-4 |
| Out-of-date packet | Needs you → RCP-19 (claude reported a newer commit after writing the packet) → *Ask for a fresh packet* |
| Send back with findings | RCP-12 packet → *Needs changes* + note → *New bug ticket*. RCP-28 is created and RCP-12 returns to In progress. Undo is available. |
| Earlier round, read-only | RCP-12 packet → Round 1 (sent back, with your notes and the bug it created, RCP-17) |
| Reviews coming up | Needs you → *Coming up for you* (RCP-14, RCP-16, RCP-22, RCP-23, RCP-25, DOC-9) |
| No human review | RCP-15 → Checklist → "No human review declared" |
| Planning is yours | Needs you → *Your Planning queue* → *Move to Ready* |
| Large initiative across epics | Click `#ui-refresh` on RCP-23 → progress by epic → *Move 2 to Ready* |
| Epic as a brief | RCP-2 Pantry (in Planning, with brief and PRD) |
| Agent question | Needs you → DOC-4 → Answer inline |
| Stale run and competing claim | RCP-15 → *Release lead claim…* → run becomes *interrupted* (Undo available) |
| Cycle in imported data | Dependencies → DOC-7 → remove a link |
| Project scope | Sidebar *Project* menu; counts per project; items from other projects flagged |

**Testing:**
- `design/prototype.html?selftest` renders every page in every scope, plus every item, tab, label, packet round, dialog and filter. It reports `SELFTEST OK` in headless Edge.
- A 51-step scripted click-through of the scenarios above also passed.

## Revision history
- **Revision 7:** commits are reported per ticket; epic-level human review for single-PR epics; a *Deferred, not verified* list on Needs you and a matching Work filter, shared with agents for cleanup.
- **Revision 6:** *Defer* verdict with follow-up choice; packets record their commit and are flagged out of date automatically; approvals record their commit and carry forward; agents may create labels.
- **Revision 5:** simplified to Epic → item → checklist. Removed Feature, Design, custom types, the Structure view, per-project ready gates and planning-doc rules. Added labels with briefs for initiatives, the three-part checklist, human review items, handoff packets with rounds, and findings turned into checklist items or bugs. Needs you is rebuilt around Ready for you, Coming up and Problems.
- **Revision 4:** item types and structure (since removed).
- **Revision 3:** project scope switcher and the Planning status.
- **Revision 2:** accessibility and contrast fixes, provenance badges, Connections, search, and Undo.
- **Revision 1:** first draft.

## Open questions
None outstanding for the UI. The remaining behaviour (how reliably agents report commits, when to use epic-level review, how deferred checks get cleaned up) belongs to each repo's agent workflow; the tracker gives it the data and the queries.
