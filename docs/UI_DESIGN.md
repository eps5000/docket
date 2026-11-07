# UI/UX design — MVP V1 human interface

Status: design proposal, revision 16, 2026-11-06. Inputs: [requirements draft](REQUIREMENTS_DRAFT.md), [Jira research](JIRA_RESEARCH.md).

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

### The checklist (tickets and epics)
Every ticket and epic has a **Checklist** card in the main body, always visible, with three sections:
- **Work:** the agent's step-by-step plan (one-liners; subagent notes attach here).
- **Agent review:** what the agent verifies itself, each with its evidence and state.
- **Human review:** what you verify yourself.

Each section has its own **Add** box (Enter adds). Items you add show "added by you" and can be removed until they're done. On an epic, the checklist holds epic-level steps and checks and is separate from **Tickets in this epic**: a checklist item is a sentence on this page, while a ticket has its own lead, blockers and review.

### Human review and handoff packets
**You can add, edit and remove human review items yourself,** on any ticket or epic. The Human review card has an "Add something you'll need to verify yourself" box, and each item shows who added it ("added by you" / "added by claude"). Items not yet handed off can be edited or removed. Items in the current packet are locked, because the packet was written against them. An item added while a packet is waiting goes into the next round, and the ticket stays open until it's decided.


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
| 7 | **Colour means state or type, never priority.** | State uses rounded text chips. Item type uses a small solid square with an icon. Priority uses neutral signal bars. The two colour uses never share a shape, so they can't be confused. |
| 8 | **Scope is always visible.** | One project switcher at the top of the sidebar scopes every work page. Every visit starts at *All projects*. |
| 9 | **Reversible or confirmed.** | Owner actions show an Undo toast. Destructive actions explain their scope and require confirmation. |

## Information architecture

```
Sidebar                                   Ticket page
┌ Project ▾ [All | Recipe App | Docs]     ├─ Header: ID · type · epic · labels · status · priority · Move to Planning/Ready
│  ── scoped to the chosen project ──     ├─ Banner when you must act: packet ready / agent question
├─ Needs you     badge = for you now      ├─ Outcome + acceptance · CHECKLIST (Work · Agent review · Human review)
├─ Work          Board | List | Map       ├─ Tabs: Documents · Activity
├─ Human review  badge = packets ready    └─ Rail: Lead & runs · Dependencies · Dates
├─ Timeline                               Epic page: tabs DETAILS (default) · Map (full width) · Activity
├─ Agents                                 Label page: brief, progress map across epics, "Move N to Ready"
│  ── service-wide ──
├─ Projects
└─ Connections
Header: breadcrumb · + New (quick capture to Inbox) · search/jump (Ctrl K or /; items, labels, pages) · theme
Under the header: open-item tabs (each ticket or epic you open; × to close; each remembers its own sub-tab)
```

## Screens

### Needs you (home): one-screen dashboard
Designed to fit on one laptop screen without scrolling. In the prototype it fits at 1440×900, and comes within about 20px at 1366×768.
- **Summary line:** for you now · problems · reviews coming up · deferred · in Planning.
- **Agent strip:** one line of run-state counts (live, reported, needs input, stale, failed) with a link to all runs. This replaces the earlier "Agents right now" card.
- **Top band:**
  - **For you now** (wide): packets to verify and agent questions. Answering a question happens inline.
  - **Problems:** stale or failed runs, cycles and date conflicts, at most five, each with its action.
- **One row of four compact cards**, each showing its top three items with *View all N →*:
  - **Coming up for you**, including epic-level reviews
  - **Deferred, not verified**, with *Create test ticket* where there's no follow-up
  - **Your Planning queue**, with *Move to Ready*
  - **Since you looked**
- **Every row is one or two lines.** Long text is truncated, with the full text on hover.

### Work
- **Board columns:** Inbox · Planning (yours) · Ready (Startable / Waiting on blockers) · In progress · Review (your human review) · Done.
- **Cards:** type, epic, labels, run state, plus chips for *Packet ready*, *Human review later*, *Question for you*, *Blocked*, and *Date risk*.
- **Filters:** epic, label, and saved filters (In planning, Ready to start, Blocked, For you, Human review later, Live run). Each shows the matching agent query.

### Ticket
- **Human review is always the first card in the right-hand column**, on stories, tasks, bugs and epics alike, so it's in the same place whatever you open. It shows each item with its state and any notes from earlier rounds, plus *Open packet* when one is ready. A child ticket without its own review says "reviewed with its epic" and links there.
- **Work and checks tab:**
  - **Work:** items with state, who and when. Subagent contributions are nested under the item they belong to. Revised items show the old text. Items added from your review say so. A history view shows every revision.
  - **Agent checks:** each check with its state (passed, failed, not run) and evidence.
- **Documents tab:** planning docs (PRD, UX, TDD) and handoff packets. Documents open in a viewer with version, author and Download; packets open the review screen. **Planning and Inbox tickets open on this tab**, because reading the docs is what Planning is.
- **Activity tab:** history, plus a *note for the agent* box. That's how you steer work without a review round; the agent sees the note on its next query.
- **Rail:**
  - **Lead & runs:** the lease, any rejected claims, stale-claim release, and *Return to Ready* after a failed run.
  - **Dependencies:** a 1-hop view: *Waits on* → this ticket → *Then unblocks*, as small status-coloured boxes, plus *See it on the epic map*. If the ticket is in a dependency cycle, the card says so and offers *Remove link*.
  - **Dates** with who set them.

### Human review
- **Queue:** Ready for you, Decided, and Coming up.
- **Packet:**
  - A round selector. Earlier rounds are read-only and show your past decisions.
  - The commit the packet was built from, and an out-of-date warning if the code has moved on.
  - Each item with *Looks good*, *Needs changes* or *Defer*. Changes need a note and a choice: *checklist item* or *new bug ticket*. Defer takes an optional note and a follow-up choice.
- **The submit button names the outcome:** *Approve and close ticket*, *Close ticket (1 deferred)*, or *Send back to codex*. A footnote says exactly what will happen.

### Quick capture
*+ New* in the header opens a small dialog: title (required), type, project, optional epic, and notes. The item lands in **Inbox** and opens, ready to be shaped in Planning. It's deliberately minimal: agents fill in the rest.

### Epic page: three tabs for three jobs
- **Details** (default): brief and documents plus the epic's Checklist on the left; **Tickets in this epic**, grouped by status, on the right. There is no separate review card.
- **Map:** progress and wiring. Full width, no side column. It shows the progress header and the progress map. If the epic itself carries the human review (a one-PR epic), a thin strip above the map says so, with *Open packet* when it's ready.
- **Activity:** agent updates for the epic, plus a *note for the agents* box.
- **+ New item in this epic** sits beside the tabs. It opens the New dialog with the epic and project filled in; the item lands in Inbox and you stay on the epic.

### Open-item tabs
- Every ticket or epic you open becomes a tab under the header. Click to switch; × to close. Closing the active tab moves to its neighbour, or back to the page you came from.
- Each tab remembers its own sub-tab (e.g. Details vs Map, Documents vs Activity).
- Tabs are a fixed 200px with type icon, ID and title, and the strip scrolls sideways. Up to 8 tabs; the oldest inactive tab closes first.
- In the real app every item also has its own URL, so Ctrl/middle-click should open it in a browser tab too.

**Getting to an epic:**
- **Work has an Epics row** at the top: one compact card per epic, with done count, mini progress bar, status and "N for you". Clicking it opens the epic's Map tab.
- The epic name is a link wherever it appears as text: the ticket header ("in ◆ Pantry"), the ticket breadcrumb, list rows, and the label page.
- Board cards keep the epic as plain text, because a card is already one link.

The epic remembers which tab you were on. A ticket's breadcrumb reads *Project / ◆ Epic / ID*, and the epic link takes you back to the tab you left. On a ticket, *See it on the epic map* always opens the Map tab. (In the real app, browser Back should do the same.)

### Progress map (epic pages, label pages, Work → Map)
The dependency view is a **progress picture**, not a standalone graph page. It always draws one epic, one label, or the current Work filter, so it stays small.
- **Header:** "1 / 12 done", a bar split by status, counts per status, "N ready but blocked", "N ready to start", and "working on wave X of Y".
- **Columns are waves:**
  - wave 1 is work that nothing blocks;
  - wave 2 can start once wave 1 is done; and so on.
  - Blockers from outside the epic sit in a dashed column on the left, labelled with their project (or "other epic").
  - Items in a dependency cycle get their own column.
- **Human review on the cards:** a **filled amber person** means a handoff packet is ready for you now; an **outlined** person means a human review is coming later; no person means no human review. A key under the map explains it. This replaces any separate review widget on the map.
- **Each box is coloured by status.** Done is filled green with a ✓; the left edge shows the status colour. Red marks only *Ready* items that are blocked. Planning items show a neutral "after RCP-12".
- **Arrows** mean "blocks". Solid arrows still block; dashed green ones are cleared. Hovering a box highlights its links.
- **It sits on a canvas with fixed spacing**, so it never gets packed: 200px columns with a 76px gap for the arrows (a four-wave epic fits the full-width Map tab at 1440px without panning), and 16px between items. The canvas is at most 540px tall, with a dotted background so it reads as a surface you can move around.
- **Panning is obvious when it's needed:**
  - drag the background, scroll, or use the arrow keys;
  - fades on any edge with more beyond it, plus clickable *More →* / *← More* / *More ↓* pills;
  - the grab cursor;
  - a hint line ("Bigger than the view: drag the background, scroll, or use the arrow keys") that appears only when the map overflows.
- **Zoom:** − / 100% / + / **Fit**. Steps are 50%, 67%, 80%, 100% and 125%. It defaults to 100% (spacious); Fit shrinks the map to show everything, down to 40% at most.
- On an epic, *Map | List* switches to the plain status-grouped list. The progress header stays.

**Why the old page went:** a global, hand-placed graph of every dependency was too big at ten items and unreadable at seventy. Cycles and date conflicts still surface in Problems on Needs you, and their *Fix* button opens the ticket.

### Labels and epics
- **Label page:** brief, a progress map across epics, a by-epic list, *Move N to Ready* for everything with that label still in Planning, and a link to the filtered board.
- **Epic page:** the progress map first, then brief and documents, with the same Human review card first in the right-hand column. A Planning epic is described as "still a brief".

### Timeline, Agents, Connections, Projects
- **Timeline:** entered dates vs actual run time vs forecast.
- **Agents:** run table with "how we know".
- **Connections:** client compatibility matrix, setup snippets, service health.
- **Projects:** switch scope, labels, progress, and typed-confirmation delete. The per-project policy, ready-gate and item-type settings are gone.

## Visual language

### Item types (solid square + icon + name)
| Type | Light | Dark | Icon |
| --- | --- | --- | --- |
| Epic | #7b2fa3 | #d197f0 | lightning bolt |
| Story | #2b7a3b | #6fd384 | bookmark |
| Task | #1c64b9 | #74b8f7 | check mark |
| Bug | #c92a2a | #ff8a8a | bug |

These follow the familiar Jira convention for quick recognition. The icon on its square is at least 5.3:1, and the square against the page at least 4.8:1, in both themes. The type square appears on cards, list rows, ticket, epic and label pages, timeline rows, and a board legend. Graph nodes get a thin stripe in the type colour.

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
| Your decision | **solid fill with person icon**, coloured by the decision: green = looked good / approved (the only badge that means human approval), amber = needed changes, blue = deferred, not verified |
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
| Cycle in imported data | Needs you → Problems → DOC-7 *Fix* → *Remove link* on the ticket |
| How far along is the feature? | Open RCP-1 Meal planning MVP: 1 / 12 done, three waves, DOC-4 blocking from Docs Site |
| One ticket's dependencies | RCP-21: waits on RCP-15 and RCP-14 (other epic) → RCP-21 |
| Project scope | Sidebar *Project* menu; counts per project; items from other projects flagged |

**Testing:**
- `design/prototype.html?selftest` renders every page in every scope, plus every item, tab, label, packet round, dialog and filter. It reports `SELFTEST OK` in headless Edge.
- A 103-step scripted click-through of the scenarios above also passed.

## Revision history
- **Revision 16:** a Checklist card in the main body of every ticket and epic, with Work, Agent review and Human review sections and an Add box for each. The right-hand Human review card is gone. Epic "Items" is renamed "Tickets in this epic". Ticket tabs are now Documents · Activity.
- **Revision 15:** epics open on Details (then Map, Activity); *+ New item in this epic*; you can add, edit and remove human review items yourself, with who-added-it shown and packet items locked; an all-approve round no longer closes a ticket that has newer undecided items; open-item tabs under the header that remember each item's sub-tab.
- **Revision 14:** epics get a front door. An Epics row on Work opens each epic's Map tab, and epic names are links in ticket headers, list rows and label pages. Previously the epic page was only reachable through a ticket's "See it on the epic map" link.
- **Revision 13:** epic pages use Map (default, full width) · Details · Activity tabs; human review shows on map cards (filled = ready for you, outlined = later); epic-level review is a strip above the map; ticket breadcrumbs link back to the epic and its last tab.
- **Revision 12:** the progress map sits on a pannable canvas with fixed, generous spacing, overflow cues (edge fades, *More* pills, hint line, grab cursor), drag/scroll/keyboard panning, and zoom with Fit.
- **Revision 11:** the standalone Dependencies page is replaced by a progress map on epic and label pages and in Work → Map, plus a 1-hop dependency view on each ticket. The delay what-if is removed.
- **Revision 10 (polish pass):** your past decisions are coloured by outcome (a "needed changes" no longer shows green); document and attachment viewer; Planning tickets open on Documents; *+ New* quick capture to Inbox; note for the agent on every ticket; type icon before the title in dense lists; Human review chips sit under the item text in the narrow column; shorter page subtitles; Coming up capped in the review queue; secondary styling for project switch buttons.
- **Revision 9:** item types are colour-coded with solid squares and icons (Epic purple, Story green, Task blue, Bug red), with a board legend, timeline icons and graph stripes.
- **Revision 8:** Human review is one card in a fixed place (top of the right-hand column) on every work item, epics included. Needs you is a one-screen dashboard: an agent status strip, For you now with Problems, and four compact cards capped at three rows.
- **Revision 7:** commits are reported per ticket; epic-level human review for single-PR epics; a *Deferred, not verified* list on Needs you and a matching Work filter, shared with agents for cleanup.
- **Revision 6:** *Defer* verdict with follow-up choice; packets record their commit and are flagged out of date automatically; approvals record their commit and carry forward; agents may create labels.
- **Revision 5:** simplified to Epic → item → checklist. Removed Feature, Design, custom types, the Structure view, per-project ready gates and planning-doc rules. Added labels with briefs for initiatives, the three-part checklist, human review items, handoff packets with rounds, and findings turned into checklist items or bugs. Needs you is rebuilt around Ready for you, Coming up and Problems.
- **Revision 4:** item types and structure (since removed).
- **Revision 3:** project scope switcher and the Planning status.
- **Revision 2:** accessibility and contrast fixes, provenance badges, Connections, search, and Undo.
- **Revision 1:** first draft.

## Known gaps (deliberately not designed yet)
| Gap | Why it can wait | When it matters |
| --- | --- | --- |
| Editing dates, blockers and acceptance from the UI (H11) | You can ask an agent, or leave a note; priority and status moves are already direct | If notes prove slower than direct edits |
| Service-down / disconnected state | The health card covers the healthy case; a full-width "service unreachable" banner is easy to add | When the real UI talks to the live service |
| Very large boards (70+ tickets, as in a big UI overhaul) | Label pages, epic filter and saved filters keep it workable | Consider epic swimlanes and collapsing Done if boards get crowded |
| Burn-down and velocity forecast (H14, P1) | The forecast lane already shows "insufficient history" honestly | Once 8+ items with effort have completed |
| Jira import dry run (O05) and backup/restore UI (O03) | Pilot comes after V1 | Before the first real project moves over |

## Open questions
None outstanding for the UI. The remaining behaviour (how reliably agents report commits, when to use epic-level review, how deferred checks get cleaned up) belongs to each repo's agent workflow; the tracker gives it the data and the queries.
