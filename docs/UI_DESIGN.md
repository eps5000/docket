# UI/UX design — MVP V1 human interface

Status: design record, revision 22, 2026-11-06. For building, use [UI_SPEC.md](UI_SPEC.md) and [BUILD_SPEC.md](BUILD_SPEC.md); this file explains the reasoning. Inputs: [requirements draft](REQUIREMENTS_DRAFT.md), [Jira research](JIRA_RESEARCH.md).

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
Every ticket and epic has a **Checklist** tab with three collapsible sections:
- **Work:** the agent's step-by-step plan (one-liners; subagent notes attach here).
- **Agent review:** what the agent verifies itself, each with its evidence and state.
- **Human review:** what you verify yourself.

Each section has its own **Add** box (Enter adds). Items you add show "added by you" and can be removed until they're done. On an epic, the checklist holds epic-level steps and checks and is separate from **Tickets in this epic**: a checklist item is a sentence on this page, while a ticket has its own lead, blockers and review.

### Human review and handoff packets
**You can add, edit and remove human review items yourself,** on any ticket or epic. The Human review section has an "Add something you'll need to verify yourself" box, and each item shows who added it ("added by you" / "added by claude"). Items not yet handed off can be edited or removed. Items in the current packet are locked, because the packet was written against them. An item added while a packet is waiting goes into the next round, and the ticket stays open until it's decided.


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
├─ Needs you     red badge = for you now  └─ Tabs, one per job (one column of collapsible sections each):
├─ Work          Board|List|Map|Timeline     DETAILS: Outcome · Documents · Dates   CHECKLIST: Work · Agent review · Human review
│   └ (packet screen opens from here)        DEPENDENCIES: 1-hop view              ACTIVITY: Lead & runs · History + note
├─ Agents        gray count of runs       Epic page: DETAILS (brief, docs, tickets) · CHECKLIST · MAP · ACTIVITY
│  ── service-wide ──                     Label page: header actions (Show on the board, Move N to Ready); brief, map, by-epic list
└─ Settings      Projects + Connections
   "Healthy · 3 clients" line at the bottom
Header: breadcrumb · + New (quick capture to Inbox) · search/jump (Ctrl K or /; items, labels, pages) · theme
Under the header: open-item tabs (each ticket or epic you open; × to close; each remembers its own sub-tab)
```

## Screens

### Needs you (home): one-screen dashboard
Designed to fit on one laptop screen without scrolling. In the prototype it fits at 1440×900, and comes within about 20px at 1366×768.
- **Agent strip:** one line of run-state counts (live, reported, needs input, stale, failed) with a link to all runs. This replaces the earlier "Agents right now" card.
- **Top band:**
  - **For you now** (wide): packets to verify and agent questions. Answering a question happens inline.
  - **Problems:** stale or failed runs, cycles and date conflicts, at most five, each with its action.
- **One row of two compact cards**, each showing its top three items with *View all N →*:
  - **Deferred, not verified**, with *Create test ticket* where there's no follow-up
  - **Your Planning queue**, with *Move to Ready*
- **Every row is one or two lines.** Long text is truncated, with the full text on hover.
- **What's deliberately not here:** reviews that are coming up but have no packet yet. They aren't asking anything of you today; the *Human review later* filter on Work lists them. "Since you looked" is gone too: what agents did lives in Agents and each item's Activity tab.

### Work
- **Board columns:** Inbox · Planning (yours) · Ready (Startable / Waiting on blockers) · In progress · Review (your human review) · Done. A Review card with a packet ready opens the packet directly.
- **Epics row** at the top (kept on purpose): one compact card per epic with progress and "N for you". Done epics wait behind *Show N done* (B43), so a big imported project's strip shows what's still moving.
- **Done waits for you, then you archive it.** There's no 7-day cutoff: a finished item stays in the Done column until you've seen it.
  - Each Done card has **Archive**, and the column has **Archive all**. Both show an Undo toast.
  - Archiving only hides the item from your views. It stays in the tracker, in agents' queries, and in search, and it opens normally with *Unarchive* in its header.
  - Archived items leave the board, the list, Timeline and the Epics row (for a done epic). An epic's *Tickets in this epic* folds them into "+ N archived · Show".
  - An **Archived** entry appears in the Filters menu once anything is archived.
  - **Progress maps keep archived items,** because done work is part of the dependency picture and the "N / M done" count.
- **Layouts:** Board, List, Map and **Timeline** (entered dates vs actual run time vs forecast; who set a date shows on hover, and only blocker dates are written under a bar).
- **Cards:** type icon (the type legend sits once above the board), epic, labels, run state if claimed, plus chips for *Packet ready*, *Human review later*, *Question for you*, *Blocked*, and *Date risk*. Unclaimed cards say nothing rather than "Unclaimed".
- **Filters** (B43, owner feedback): epic, label, three quick filters (**Active**, the default; **Blocked**; **In progress**), and a **Filters** menu of checkboxes for the rest (For you, Human review later, Deferred review, Live run, Has a problem, Shows done, Shows canceled). Ticked filters show as removable pills, and *Clear* goes back to Active. *In planning* and *Ready to start* are left off because their columns already show them; links such as *View all* in the Planning queue still apply them. Hovering a quick filter shows the matching agent query.

### Tickets and epics: one tab per job
Each tab is a view that answers one question. Epics and tickets use the same four slots, so you always know where to look.

| Tab | The question | Ticket | Epic |
|---|---|---|---|
| **Details** (default) | What is this? | Outcome and acceptance, Documents, Dates & effort | Brief and documents, Tickets in this epic (grouped by status) |
| **Checklist** | What has to happen, and what's verified? | Work, Agent review, Human review | Same three, at epic level |
| **Dependencies** / **Map** | Where does it sit? | 1-hop view: *Waits on* → this → *Then unblocks*, cycle fix, *See it on the epic map* | Progress map on the pannable canvas, plus the epic-level review strip |
| **Activity** | What did the agents do? | Lead & runs (lease, rejected claims, release, *Return to Ready*), then History with the *note for the agent* box | History with the *note for the agents* box |

- **Tab labels carry state**, so you don't have to open a tab to see it: *Checklist 1/4*, *Dependencies 4*, *Map 1/12*. A dot flags something that needs a look: amber for a packet that's ready (Checklist) or a stale, failed or conflicted run (Activity), and red for a dependency cycle (Dependencies).
- **Inside a tab, content is one column of collapsible sections.** Each header shows a one-line summary (for example, "Work · 1/4 done · the agent's plan"). Collapse state is remembered per section type, so if you close Work on one ticket, it stays closed on the next.
- **Checklist tab:**
  - **Work:** items with state, who and when. Subagent contributions are nested under the item they belong to. Revised items show the old text, and items added from your review say so. *Checklist history* shows every revision.
  - **Agent review:** each check with its state (passed, failed, not run) and evidence.
  - **Human review:** what you'll verify yourself, with state, any notes from earlier rounds, and *Open packet* when one is ready. You can add, edit or remove items, but items in the current packet are locked. A child ticket without its own review says "reviewed with its epic" and links there.
- **Above the tabs, on every tab:** the header (status, priority, *Move to Ready*), plus banners for things that need you now: *Handoff packet ready* and agent questions.
- **Entry points land on the right view.** *Inspect* on a stalled or failed run opens Activity; *Fix* on a cycle opens Dependencies; *See it on the epic map* opens the epic's Map. Otherwise an item opens on Details, or on whichever tab you last had open for it.
- **+ New item in this epic** sits at the right of an epic's tab row. It opens the New dialog with the epic and project filled in; the item lands in Inbox and you stay on the epic.

### Human review (packet screen)
- **Not a sidebar page.** It's the screen where you read a handoff packet and decide each item. It opens from *Open packet* on Needs you, the packet banner on a ticket, a Review card on Work, or a handoff packet in a ticket's Documents. The breadcrumb reads *Needs you / Human review · RCP-12*, and Needs you stays highlighted in the sidebar.
- **Why:** a ready packet already showed in Needs you and in the Review column, so a third list was redundant.
- **Queue:** only *Ready for you*, so you can step from one packet to the next. When you're viewing a decided packet (from the ticket's Documents), it shows under *Viewing*.
- **No subtitle and no Ticket side card.** The packet header names the ticket and links to it.
- **Packet:**
  - A round selector. Earlier rounds are read-only and show your past decisions.
  - The commit the packet was built from, and an out-of-date warning if the code has moved on.
  - Each item with *Looks good*, *Needs changes* or *Defer*. Changes need a note and a choice: *checklist item* or *new bug ticket*. Defer takes an optional note and a follow-up choice.
- **The submit button names the outcome:** *Approve and close ticket*, *Close ticket (1 deferred)*, or *Send back to codex*. A footnote says exactly what will happen.

### Quick capture
*+ New* in the header opens a small dialog: title (required), type, project, optional epic, and notes. The item lands in **Inbox** and opens, ready to be shaped in Planning. It's deliberately minimal: agents fill in the rest.

### Open-item tabs
- Every ticket or epic you open becomes a tab under the header. Click to switch; × to close. Closing the active tab moves to its neighbour, or back to the page you came from.
- Each tab remembers its own view (Details, Checklist, Dependencies or Map, Activity).
- Tabs are a fixed 200px with type icon, ID and title, and the strip scrolls sideways. Up to 8 tabs; the oldest inactive tab closes first.
- In the real app every item also has its own URL, so Ctrl/middle-click should open it in a browser tab too.

**Getting to an epic:**
- **Work has an Epics row** at the top: one compact card per epic, with done count, mini progress bar, status and "N for you". Clicking it opens the epic on Details, or on the tab you last used for it.
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
- **Arrows** mean "blocks". Solid arrows still block; dashed green ones are cleared. They run through the gaps between columns and rows and never across a box. Hovering a box highlights its links.
- **It sits on a canvas with fixed spacing**, so it never gets packed: 200px columns with gaps of at least 76px for the arrows, wider when more arrows pass through (a four-wave epic fits the full-width Map tab at 1440px without panning), and 16px between items. The canvas is at most 540px tall, with a dotted background so it reads as a surface you can move around.
- **Panning is obvious when it's needed:**
  - drag the background, scroll, or use the arrow keys;
  - fades on any edge with more beyond it, plus clickable *More →* / *← More* / *More ↓* pills;
  - the grab cursor;
  - a short "Drag to pan" hint that appears only when the map overflows.
- **Key:** one line under the map: "Arrow = blocks · dashed green = cleared · hover to trace", plus the review person icons.
- **Zoom:** − / 100% / + / **Fit**. Steps are 50%, 67%, 80%, 100% and 125%. It defaults to 100% (spacious); Fit shrinks the map to show everything, down to 40% at most.

**Why the old page went:** a global, hand-placed graph of every dependency was too big at ten items and unreadable at seventy. Cycles and date conflicts still surface in Problems on Needs you, and their *Fix* button opens the ticket.

### Labels and epics
- **Label page:** one column. The header carries the done count and two actions: *Show on the board* and *Move N to Ready* (the latter only while something is in Planning). Below that come the brief, a progress map across epics, and a by-epic list.
- **Epic page:** Details, Checklist, Map and Activity tabs (see *Tickets and epics* above). A Planning epic is described as "still a brief".

### Agents and Settings
- **Agents:** run table with "how we know". The run-state glossary card is gone, because every state already has an icon and a label.
- **Settings** (service-wide) is one page:
  - **Projects:** switch scope, labels, progress, and typed-confirmation delete.
  - **Connections:** client compatibility matrix, setup snippets, endpoint and service health.

### Page chrome
- **Scope shows in two places, not three:** the sidebar switcher and the breadcrumb. Page titles no longer repeat it.
- **No explanatory subtitles under page titles.** Rules like "CI and merges never count" are enforced and shown where they apply, such as the submit footnote on a packet.

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
| Planning | orange |
| Ready | blue |
| In progress | violet |
| Review | magenta |
| Done | green |
| Canceled | dark gray, hatched in bars |
| **Blocked** (derived) | red chip shown *next to* the status |

Chips, bars, legends and card edges share one set of status tokens (UI_SPEC §5).

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
| `--ok` | #237032 | #5bd06f | Success, your approval |
| `--warn` | #9a4705 | #f0a020 | For you |
| `--bad` | #c22b2b | #ff7b7b | Blocked, failed, conflict |
| `--info` | #1864ab | #5cb3f8 | Callouts |
| `--violet` | #6741d9 | #a990ff | Agent work |
| `--st-<status>` | see UI_SPEC §5 | see UI_SPEC §5 | Status: solid, soft, text |
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
| Reviews coming up | Work → *Human review later* filter (RCP-14, RCP-16, RCP-22, RCP-23, RCP-25, DOC-9) |
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
- A 123-check scripted click-through of the scenarios above also passed.

## Revision history
- **Revision 22 (final check):**
  - On windows narrower than 1180px, the packet's decision panel sits under the queue instead of below the whole packet.
  - The theme is applied from state on every render.
  - The Checklist intro sentence is gone, because the section headers say it.
  - Stale doc lines are fixed: open-item tab memory, where the Epics row opens, the epic *Map | List* toggle that was never built, and Done crowding.
- **Revision 21:** archive for Done.
  - Done items wait in the Done column, with no 7-day cutoff, until you archive them, one at a time or all at once. Undo works for both.
  - Archived items leave the board, the list, Timeline, the Epics row and epic ticket lists, which show "+ N archived".
  - They stay in the tracker, in search, under an *Archived* filter and on progress maps.
- **Revision 20:**
  - Human review leaves the sidebar, which is now Needs you, Work, Agents and Settings. The packet screen opens from Needs you, ticket banners and Review cards, and its queue lists only packets ready for you. Upcoming reviews are the *Human review later* filter on Work.
  - "Since you looked" is removed from Needs you.
  - The agent query moves to a tooltip on each filter.
  - The Epics row on Work stays.
- **Revision 19 (simplicity pass):**
  - The sidebar goes from 7 items to 5: Timeline became a Work layout, and Projects and Connections merged into Settings. The health box is one line.
  - Only Needs you keeps a red badge.
  - Needs you lost its summary line and the Coming up card, which now lives only on Human review.
  - Page subtitles and the repeated scope pill are gone.
  - On Work: no workflow sentence, no type word or "Unclaimed" on cards, and no filters that duplicate a column.
  - The packet page lost its Ticket card.
  - Agents lost its glossary card.
  - The label page is one column, with actions in the header.
  - Map keys are one line.
  - Timeline bars no longer repeat "set by".
  - The open-item tab hint is gone.
- **Revision 18:** tickets and epics share four tabs, one per job: Details, Checklist, Dependencies (Map on epics) and Activity. The Checklist tab splits into collapsible Work, Agent review and Human review sections. Lead & runs moved to Activity. Tab labels show counts, plus an attention dot for a ready packet, run trouble or a cycle. *Inspect* and *Fix* in Problems open the matching tab.
- **Revision 17:** ticket pages and epic Details are a single long column, with no side rail and no Documents/Activity tabs. Every section is collapsible and shows a one-line summary in its header. Collapse state is remembered per section type, and Activity starts collapsed.
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
| Very large boards (70+ tickets, as in a big UI overhaul) | Label pages, epic filter and saved filters keep it workable | Consider epic swimlanes if boards get crowded (Done is already kept short by Archive) |
| Burn-down and velocity forecast (H14, P1) | The forecast lane already shows "insufficient history" honestly | Once 8+ items with effort have completed |
| Jira import dry run (O05) and backup/restore UI (O03) | Pilot comes after V1 | Before the first real project moves over |

## Open questions
None outstanding for the UI. The remaining behaviour (how reliably agents report commits, when to use epic-level review, how deferred checks get cleaned up) belongs to each repo's agent workflow; the tracker gives it the data and the queries.
