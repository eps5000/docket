# Docket (formerly Task Lite): V1 UI spec (handoff)

Status: ready to build, 2026-11-07. This is the screen-by-screen contract for the web UI. Read it together with [BUILD_SPEC.md](BUILD_SPEC.md), which covers data, rules and API.

**References:**
- **Visual reference:** [design/prototype.html](../design/prototype.html) (revision 22). Its CSS is the source for every token and measurement here. Copy its token block into `web/src/styles/tokens.css` unchanged.
- **Where documents disagree:** this spec wins over the prototype. [UI_DESIGN.md](UI_DESIGN.md) explains *why*; read it when you have to make a judgement call.

---

## 1. Overview

**Who and why.** One owner, on one machine, supervising AI agents several times a day. Agents coordinate through Docket; this UI is how the owner sees and steers that coordination. The UI answers four questions, in this order:
1. What needs me?
2. What are agents doing?
3. Where is the work?
4. What happened?

Agents do almost all the writing. The owner verifies, decides, nudges and archives.

**Principles to apply when this spec is silent:**
1. **"For you" first.** Only Overview has a red badge, counting the owner actions in its Needs you section.
2. **Never blur provenance.** Owner approval, agent claims, observed child runs, relayed logs and CI look different. Nothing but an owner decision looks like approval.
3. **Unknown is not done.** Stale never becomes a check mark.
4. **One job per view.** Tickets and epics have four tabs: Details, Checklist, Dependencies (Map on epics) and Activity. Don't mix their content.
5. **Less text.** No explanatory subtitles under page titles. Rules show up where they apply (button labels, footnotes). Prefer a count or a dot over a sentence.
6. **Reversible or confirmed.** Owner mutations get an Undo toast. Destructive ones get a confirmation dialog with focus on Cancel.

---

## 2. Shell and layout

```
┌──────────────┬────────────────────────────────────────────────────────────────┐
│ Sidebar 220  │ Header: breadcrumb · [+ New item|▾] · [Search… Ctrl K] · [theme]│ 9px 18px padding
│  Logo        ├────────────────────────────────────────────────────────────────┤
│  Project ▾   │ Open-item tab strip (only when ≥1 item open)                    │
│  Needs you ③ ├────────────────────────────────────────────────────────────────┤
│  Work        │ View: padding 18px 20px 28px                                    │
│  Agents ⑤    │                                                                 │
│  Agent files │                                                                 │
│  SERVICE-WIDE│                                                                 │
│  Settings    │                                                                 │
│  ● Healthy·3 │                                                                 │
└──────────────┴────────────────────────────────────────────────────────────────┘
```

- **Grid:** `220px minmax(0,1fr)`. Every grid child needs `min-width:0`. (Without it, wide maps and tables push the layout wider than the window.)
- **Sidebar:**
  - **Project switcher** (*All projects* or one project): a menu of radio items, each with its for-you count. It scopes every page except Settings. Below the projects and the hint, after a separator, comes **Project decisions** (a `menuitem`, only with a project chosen; decision 38), which opens that project's Decisions page (§6.3.7), and the last item is **+ New project** (a `menuitem`; B32), which opens the New project dialog (§6.7d). Arrow keys, Home and End reach it like the projects.
  - **Nav items:** Overview (red badge = the owner actions, decision 41), Work, Agents (gray badge = tickets being worked in the current project, the Overview card's *being worked*; parked or waiting tickets aren't counted; no badge at 0), **Agent files** (B25: project-scoped like the others, so not under the divider), then the "Service-wide" divider, Settings and **Help** (decision 29).
  - **Health line** at the bottom: "Healthy · N clients", linking to Settings. When unhealthy, it shows "Service problem" in `--bad` with the same link.
- **Header:**
  - **Breadcrumb:**
    - `Scope / Page`;
    - tickets: `Project / ◆ Epic / ID Title`, where the epic is a link back to the tab you left;
    - packet: `Overview / Human review · ID`;
    - Settings: `Settings` plus a "Service-wide" pill.
  - **+ New item** (primary), **Search** (opens the palette; `Ctrl K` or `/`), and a theme toggle cycling System → Light → Dark.
  - **+ New item** (B32) is a split button. The main part stays one click for Quick capture (§6.9); its tooltip is "New item: capture it in Inbox". A caret beside it (accessible name "More to create", tooltip "Create a new item or a new project") opens a small menu: **New item** ("Capture it in Inbox") and **New project** ("A key, a name, then what next"). With no projects, the whole button is **+ New project** (tooltip "Create your first project") and opens New project. There is no keyboard shortcut for New item (there wasn't one before either).
- **Open-item tabs:** every ticket or epic you open becomes a tab.
  - Each tab is a fixed 200px with type icon, ID and title, and an × to close.
  - At most 8 tabs; when a 9th opens, the oldest inactive one closes.
  - Each tab remembers its own view tab.
  - Closing the active tab moves to its neighbour, or back to the page you came from.
  - The strip scrolls sideways and is hidden when empty.
  - **It doesn't show on Overview (`/`; B56).** The tabs stay open, and are there again on the next page that shows the strip.
- **Breakpoint at 1180px and below:**
  - the sidebar becomes a 64px icon rail (labels move to `title` and `aria-label`);
  - Overview stacks Needs you and Health to one column, with its four numbers, charts and lower cards still side by side;
  - on the packet screen, the decision panel moves under the queue (columns `220px | 1fr`, rows `auto 1fr`).
- **Minimum supported window:** 1024×768. Narrower layouts are out of scope for V1 (host-only, desktop).

**Persistence:**

| State | Storage | Why |
|---|---|---|
| Project scope | `sessionStorage` (resets on every new visit) | Owner decision 10: never unknowingly scoped |
| Open-item tabs + each tab's view | `sessionStorage` | Like browser tabs |
| Theme | `localStorage` | Preference |
| Desktop notifications on/off, and which events were already notified | `localStorage` | Opt-in per browser; no repeat notifications across tabs |
| Collapsed sections (per section *type*, e.g. "work") | `localStorage` | Close Work once, and it stays closed on the next ticket. A few sections start collapsed (Agents → Recent, the burn-down); opening one is remembered the same way |
| Work's last filter choice, per project (B43) | `localStorage` | Applied only when you arrive at Work with no filter in the URL; the URL then shows it |
| Everything else (filters, layout) | URL query | Shareable, Back works |

**Routes:**
- `/` Overview (decision 43); `/needs-you` redirects to its Needs you section (`/#needs-you`)
- `/brief?day=` the daily brief (decision 48; §6.1b)
- `/overview/:metric` the list behind a number: `completed` (`?window=`), `agents_working`, `agents_waiting`, `in_flight`, `no_epic`
- `/work?layout=board|list|map|timeline&epic=&label=&quick=&has=&show=` (B43: `quick` is `blocked` or `progress`, Active when omitted; `has` and `show` are comma-separated. An old `filter=` link is mapped and rewritten in place, §6.2)
- `/items/:id?tab=details|checklist|deps|map|activity`
- `/review/:id?round=`
- `/labels/:project/:name`
- `/projects/:key/decisions?filter=review&decision=` (decision 38; §6.3.7): a project's Decisions page. `filter=review` shows only agents' unconfirmed records; `decision` scrolls to one record and focuses it
- `/agents?state=` (Active now filtered to one run state) and `/agents#workspaces`
- `/agent-files?file=` (§6.7b); `?project=<KEY|all>` switches the scope, then drops out of the URL. `/settings/agent-setup` (B23–B24) redirects here
- `/settings`
- `/unlock`

---

## 3. Design tokens

Copy the prototype's `.tl` token block. Light and dark values below; the prototype supports both `data-theme` and `prefers-color-scheme`.

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--bg` | #f6f7f9 | #0f1115 | Page |
| `--panel` | #fff | #161920 | Cards, sidebar, header |
| `--panel-2` | #f1f3f6 | #1c2029 | Board columns, hover, collapsed sections |
| `--line` / `--line-2` | #e3e6eb / #d3d8df | #2a303b / #363d4a | Dividers |
| `--ctl` | #8a929f | #6f788a | Control borders (≥3:1) |
| `--ink` / `--ink-2` / `--ink-3` | #16191f / #444c59 / #5f6878 | #e6e9ef / #b8c0cc / #99a2b4 | Text, secondary, tertiary (≥4.5:1) |
| `--on-fill` | #fff | #0f1115 | Text on solid fills |
| `--brand` / `--brand-soft` | #3b5bdb / #e8edff | #8ea2ff / #1d2440 | Primary buttons, links, focus, active tab |
| `--ok` / `--ok-soft` | #237032 / #e6f4ea | #5bd06f / #14281a | Success, owner approval |
| `--warn` / `--warn-soft` | #9a4705 / #fdf1e2 | #f0a020 / #2d2210 | For you, packet ready, attention dot |
| `--bad` / `--bad-soft` | #c22b2b / #fdecec | #ff7b7b / #351818 | Blocked, failed, cycle, conflict |
| `--info` / `--info-soft` | #1864ab / #e7f1fb | #5cb3f8 / #132536 | Callouts, deferred |
| `--violet` / `--violet-soft` | #6741d9 / #f0ebff | #a990ff / #241c3e | Agent work |
| `--st-<status>` / `-soft` / `-text` | see §5 | see §5 | The one status colour system (B47) |
| `--gray-soft` | #eef0f3 | #23272f | Neutral chips |
| `--t-epic` `--t-story` `--t-task` `--t-bug` | #7b2fa3 #2b7a3b #1c64b9 #c92a2a | #d197f0 #6fd384 #74b8f7 #ff8a8a | Item type squares |
| `--shadow` | 0 12px 40px rgba(20,25,35,.18) | 0 12px 40px rgba(0,0,0,.5) | Menus, dialogs |
| `--sans` | Inter, "Segoe UI", system-ui, -apple-system, sans-serif | | Base 13px/1.45 |
| `--mono` | ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace | | IDs, SHAs, times (12px) |

**Type scale:**
- h1: 19px, weight 650, letter-spacing −.01em;
- h2: 14px, weight 650;
- h3 (section labels): 11.5px, uppercase, letter-spacing .06em, `--ink-3`, weight 650;
- secondary text: 12px `--ink-3`, never below 11.5px.

**Radii:** 4 (labels, kbd); 7–8 (buttons, inputs, nav items); 9–10 (cards, board columns); 12 (dialogs, shell); 999 (chips, filter chips).

**Spacing:** 4px base. Common gaps are 6, 8, 10, 12, 14 and 16. Card padding is 12px 14px; section header padding is 8px 14px 8px 8px; section body padding is 0 14px 14px 36px.

**Control sizes:** buttons 30px tall (small: 28px); icon buttons 32×32; inputs 30px tall; nav items 32px; filter chips 28px. Minimum target: 28px.

**Focus:** a 2px `--brand` outline with 2px offset on every focusable element (`:focus-visible`).

---

## 4. Components

| Component | Variants | Props | Notes |
|---|---|---|---|
| `Button` | primary, default, ghost, danger-text; sizes md, sm | `onClick, disabled, icon?` | Primary only for the one main action per view. A disabled primary uses brand at 55% opacity and keeps a label that says why ("Decide every item first"). |
| `IconButton` | — | `aria-label` (required) | 32×32. |
| `Chip` | status (7), blocked, human review (4), neutral, warn, ok, bad, info | `kind, children` | Rounded pill; always text, never colour alone. |
| `TypeBadge` / `TypeIcon` | Epic, Story, Task, Bug | `type, iconOnly?` | 16px square in the type colour with a white glyph, plus the name. Icon-only on board cards and tabs, with an sr-only name. |
| `RunState` | live, reported, stale, parked, needs input, failed, finished, interrupted | `state, age?` | Icon shape + label + `title` holding the one-line meaning (§5). The live dot pulses, except under reduced motion. Used alone only where a state is counted. |
| `RunLine` | one per run state | `state, reason?, agent?, age?` | **The one run-state line** (§5): `state · reason · agent`, then the age at the right. Cards, the epic's Tickets list, Agents, the agent bar and Lead and runs all use it. The separators keep to the segment before them, so a wrapped line never starts with "·"; the state and the agent never break inside. |
| `WorkspaceStateChip` | In use, Parked, At risk, Safe to prune, Unknown | `state` | Agents → Workspaces, the agent bar, Where the work lives, and recovery Problems rows. At risk is `--warn`, Safe to prune `--ok`. |
| `Provenance` | owner (approve), owner (changes), owner (defer), observed, agent, relayed, CI, git | `kind, label?` | §5. Only the owner variants are solid-filled. |
| `Priority` | P1–P3 | `p` | Three signal bars plus a `title`. Never coloured. |
| `Label` | — | `name` | Outline tag, links to the label page. |
| `EpicLink` | — | `epic` | ◆ in the epic colour, plus the title; links to the epic. |
| `Card` | plain, padded | | 1px `--line`, radius 10. |
| `Section` (collapsible) | open, collapsed | `key, title, summary, extraHead?, defaultCollapsed?, id?` | The header is a button: chevron + h3 title + `· summary`, with `aria-expanded`. Collapsed sections use `--panel-2` and render only the header. Collapse state is per section *type* (§2). `defaultCollapsed` starts it closed until the owner opens it (Agents → Recent, the burn-down). |
| `ViewTabs` | ticket, epic | `tabs[{key, label, count?, dot?}], active` | ARIA tablist. A count is muted text after the label. A dot is 7px, amber or red, with sr-only text. |
| `TicketCard` | default, blocked (red left edge), for-you (amber left edge), done (+ Archive) | `item` | Shows ID + type icon + priority; title (2–3 lines); epic and labels; chips; the lead's `RunLine` with its age. A parked lead's line says what it waits on: "parked · waiting on the coordinator · claude · orca-w4", or "parked · ready to resume · …". **Unclaimed cards show no run line.** |
| `ForYouChip` | — | | Amber "For you" with the attention icon: a packet is ready or an agent asked you something. On list rows that have no amber card edge (the epic's Tickets list). |
| `EpicCard` | default, empty | `epic` | 4px `--t-epic` left edge; title + ID; mini progress bar (done green, active violet); "n/N done · Status · N for you". **Empty** (no tickets; B35): no bar, and "No tickets yet · Status" (for example "No tickets yet · In progress"), never "0/0 done". |
| `ProgressMap` | epic, label, work | `items, scopeTitle` | §6.3.4. |
| `HandoffPacket` | live round, past round | `packet, verdicts` | §6.4. |
| `Toast` | info, with Undo | `message, onUndo?` | Bottom right. 3.2 s, or 6 s with Undo. `role=status`. |
| `Dialog` | default, destructive | `title, children, footer` | Max width 640px, overlay rgba(10,12,16,.38), 80px from the top. Traps focus, closes on Esc. Destructive dialogs focus Cancel first. |
| `CommandPalette` | — | | Groups: Work items, Labels, Go to. Arrow keys move, Enter opens, Esc closes. Archived items show an "Archived" tag. |
| `EmptyState` | — | `text` | One muted line inside the card. No illustrations. |
| `DecisionRow` | owner, agent; active, superseded, withdrawn | `record, canAct` | §6.3.5. The authority badge must **not** look like review approval: no solid fill. |

---

## 5. Visual language (state → appearance)

**Item types** (Jira convention):

| Type | Light | Dark | Icon |
|---|---|---|---|
| Epic | #7b2fa3 | #d197f0 | lightning bolt |
| Story | #2b7a3b | #6fd384 | bookmark |
| Task | #1c64b9 | #74b8f7 | check mark |
| Bug | #c92a2a | #ff8a8a | bug |

**Work status chips:**

| Status | Colour | Solid (light / dark) | In bars |
|---|---|---|---|
| Inbox | gray | #8a8c91 / #c5c7ce | solid |
| Planning | orange | #cf6a07 / #f8a60d | solid |
| Ready | blue | #0f65af / #35c3fc | solid |
| In progress | violet | #9d68fb / #7361ff | solid |
| Review | magenta | #b51c6e / #ea509e | solid |
| Done | green | #136c3f / #5befa0 | solid |
| Blocked (a state) | red | #ad0707 / #e0503c | solid |
| Canceled | dark gray, with strikethrough | #303337 / #727070 | hatched |

**One status colour system (B47).** Each status has three tokens in `tokens.css`: `--st-<status>` (solid: bars, legend swatches, card edges), `--st-<status>-soft` (chip fill) and `--st-<status>-text` (chip text). Chips, the Map's bar and legend, epic-card bars, Settings project bars and card edges all use them, and nothing else defines a status colour. A unit test over the real tokens holds, in both themes: every pair of bar colours at least 20 apart in CIEDE2000; at least 12 apart under simulated deuteranopia and protanopia; chip text at least 4.5:1; bars at least 3:1 on the track and the panel; every status at least 14 from the epic type colour. Bars always carry text or an accessible label, so status is never told by colour alone.

Blocked is derived and shows as a separate red chip, "⊘ Blocked by RCP-12, …", next to the status. When a blocker is done but its link needs more, the chip says what it's waiting for: "⊘ Blocked by RCP-12 (needs merge)" or "(needs your verification)".

**Decision authority** (decision records, §6.3.5). This is deliberately distinct from review provenance, whose solid fill means only human review approval:

| Badge | Style |
|---|---|
| Owner | outline in `--ink-2` with a person icon, the text "Owner" |
| Agent · claude | dashed violet outline (the same family as Agent-reported) |
| Superseded / Withdrawn | gray chip; the title is struck through |

**Run state** (labels and meanings come from `shared/`; the meaning goes in `title`):

| Label | Icon | Meaning |
|---|---|---|
| live | solid green, pulsing | Working: the client session is responding |
| reported | violet ring | The agent says it's working, with no recent session signal |
| stale | dashed ring | No signal; state unknown, not assumed finished |
| parked | ring with a pause bar, `--ink-3` | Waiting on purpose (on an item, the coordinator or a person, or until a time). Keeps its claim; never mistaken for finished. Shown as "parked · waiting on RCP-12", "· waiting on the coordinator", "· waiting on a person", "· waiting until Nov 20 10:00", or "· ready to resume" once what it waited on has cleared. |
| needs input | amber "?" | Waiting on you |
| failed | red "×" | Run ended with an error |
| finished | gray "✓" | Run ended normally |
| interrupted | ring "–" | Stopped without finishing (lease expired or released; a service restart for a child run that didn't signal in time, or in history from before decision 41) |

**One run-state line** (B20). Everywhere a run is shown with its context (Board and List cards, the epic's Tickets list, Agents, the agent bar, Lead and runs) it is one `RunLine`: `state · reason · agent`, then the age.
- **state:** the run state's icon and label;
- **reason:** why, when there is one worth a glance: what a parked run waits on, or "ready to resume";
- **agent:** `client · label`. Omitted where the agent has its own column (Agents) or its own line;
- segments are omitted, never left empty, and a wrapped line never starts with "·".

**Provenance:**

| Badge | Style |
|---|---|
| Your decision | Solid fill with a person icon, coloured by outcome: green = approved (**the only thing that means human approval**), amber = needed changes, blue = deferred, not verified |
| Observed child run | solid violet outline |
| Agent-reported | dashed violet outline |
| Relayed by lead | dotted gray outline |
| CI | blue tint |
| Git | neutral; never approval |

**Human review states:**

| State | Chip |
|---|---|
| Coming up | gray |
| Ready for you | amber |
| Approved | green |
| Deferred · not verified | blue |

The map and the board show human review as a person icon:
- **filled amber:** a packet is ready for you;
- **outlined:** review comes later;
- **none:** no human review.

---

## 6. Screens

Every screen has three states before its content renders:
- **Loading:** skeleton blocks for the card shapes after 200 ms. Never a spinner over the whole view.
- **Error:** an inline `--bad-soft` callout in place of the content, with the error code, one-line message and *Retry*.
- **Empty:** the per-card lines specified below.

### 6.0 First run (B32)
What a Docket with **no projects** shows. Deleted projects don't count: the test is the bootstrap's project list being empty. While bootstrap loads or fails, screens render as usual, so a slow start never flashes the Welcome page.

- **Needs you (`/`) is the Welcome page:**
  - **h1 "Welcome to Docket"** with the "?" (anchor `needs-you.welcome`, article "Your first look around"), and the line "The shared record your AI agents work from.";
  - **three starts**, as cards in a row (stacked under 1000px), each with an h2:
    - **Create a project:** "Start empty…", *New project* (primary) opens the New project dialog (§6.7d);
    - **Import from Jira:** "Copy a Jira Cloud project into a new Docket project, after a dry run…", *Import from Jira…* opens the import (§9.2) with *New project* selected;
    - **Onboard a repo with an agent:** the line to give an agent, "Onboard this repo into Docket as project <KEY>, using onboard_project." with *Copy*, the `onboard` prompt name, and a callout "The agent needs to be connected first: see Connect an agent" (a link to Help → Connect an agent);
  - **"How Docket works:"** one line (agents claim items, log what they do and hand finished work back for review; you decide on Needs you; Docket doesn't start agents), then *Read Help*.
- **Work, Agents and Agent files** show one line instead of their empty states: "No projects yet. Start on the Welcome page to create one, import one from Jira, or have an agent onboard a repo." (the link goes to `/`). Work and Agents show only their h1 and that line; Agent files keeps its defaults list below it (they can be installed user-wide before any project exists).
- **The header** shows *+ New project* (§2).
- **After the first project is created,** the New project dialog lands on its "What next" choices (§6.7d) and the scope switches to the new project. Closing it leaves the Welcome page for the normal Needs you.

### 6.1 Overview (`/`; decision 43)
Answers three questions in about ten seconds: are agents making progress, is anything stuck, do I need to do anything? For one project or All projects. At 1440×900 the four numbers and the first owner action show without scrolling. Metric definitions are in BUILD_SPEC §5.24. Contents, top to bottom:

1. **h1 "Overview"**, "N things to act on" when there are any, a **Daily brief** link (§6.1b; decision 48), and the **time window** (`24h | 7d | 30d`, a pressed-button group): 7d by default, remembered in this browser (`docket.overviewWindow`), and safe when storage is unavailable.
2. **Four numbers**, each a link to the view behind it:
   - **Completed:** "18 tickets" → `/overview/completed?window=`, then "+6 vs the previous 7 days" (the sign and words carry the direction);
   - **Tickets with agents (B56):** "4 being worked" and "3 parked/waiting" → `/overview/agents_working`, `/overview/agents_waiting`. Tickets at producer level, never raw runs or sessions. *Being worked* is the sidebar badge, from the same `agents_now`, and the badge uses the same words. One line under the four cards says: "Counts tickets in Docket, not agent sessions. Orca can show more sessions, because coordinators and helpers don't each hold a ticket." No session count is shown or estimated;
   - **In flight:** "23 tickets" → `/overview/in_flight`, "5 blocked" → Work, *Blocked*, "7 of 74 Ready can start" → Work, *Startable* (decision 48);
   - **Needs you:** "3 to act on", then reviews, questions, decisions and problems, each linking to its section. "✓ Nothing" at zero.
3. **Needs you and Health** (`2fr | 1fr`, one column at ≤ 1180 px). **Needs you · N** (`#needs-you`) holds every owner action, in the order below; a card with no rows isn't shown. With no actions, one line: "Nothing needs you". **Health** (`data-card="health"`): "n problems need you" (→ `#problems`) or "No problems need you"; the last backup (→ Settings; "!" when it failed, is overdue or never ran); the **at-risk worktrees line** (→ Agents → Workspaces; B56), which separates what needs the owner from what doesn't, such as "3 worktrees hold unsaved work. None need you: agents own 2, and you kept 1 for later." It has a ✓ when none need the owner, a ? when Docket can't tell who owns one (it says so), and a ! only when one needs an owner choice under decision 41's routing; the collapsed lines "Agents are handling N problems" and "You acknowledged N problems"; "n agent file changes proposed"; "Docket handled N overlaps today"; and *All runs →*. Each state has a ✓ or ! as well as its words. None of these lines adds to the badge.
4. **Completed per day** (per hour for 24h): one series in the Done token, with a one-sentence summary, a **vertical axis** of whole-number ticks from 0 (steps of 1, 2 or 5 times a power of ten, at most four intervals) with gridlines, the first and last date, and a screen-reader table of the same values and tickets. **Each bar opens a tooltip (B56)** on hover or keyboard focus: the date or hour, the count, and up to 6 tickets (newest first, ID and title, each a link), then "and N more"; an empty bucket says "None completed". The bars are one tab stop: ←, →, Home and End move between them, Tab goes into the tooltip's links, and Esc closes it. The tooltip stays inside the window at every edge. **Workload · N open:** a status bar per epic (`StatusBar`, B47 tokens) with a legend and a text label, its count linking to Work filtered to that epic ("No epic" → `/overview/no_epic`). The top 6 epics, then *View all open work →*.
   **Flow per day** (per hour for 24h; decision 48, BUILD_SPEC §5.30; `data-card="flow-chart"`) sits between the two: three small panels, **Finished**, **Merged** and **Parked**, over one time axis, each named with its total and its own whole-number scale from 0, because parks can far outnumber finished tickets. A one-sentence summary comes first, then the divergence note when there is one, in plain text with no colour or badge. Under the chart, one line always says "Merged counts only PRs an agent recorded in Docket", and adds how many finished tickets have none recorded. Each time slot is **one button across the panels**, one tab stop (←, →, Home, End), whose tooltip gives all three values on hover or focus; Esc closes it. Assistive tech gets the summary and a table of the same values. The three cards share a row above 1320 px. Below that, Completed and Flow share one and Workload takes the next.
5. **Your Planning queue** and **Deferred, not verified:** a count and the top 3, with *View all N →* whenever the list has anything, so each count links to its view.

Radar insights get their own section between 4 and 5 when they exist; nothing renders there until then. Token use and estimated metrics are not shown. `/overview/:metric` is a small table (ticket, title, status, epic, plus when completed or the producer) with the same count as the number.

**The owner's actions** (what Needs you was before decision 43):

3a. **Cards and rows:**
   - **For you now · N:**
     - **packet rows:** box icon; title + ID; "Round n packet · k to verify · about 10 min", plus a red "out of date: code changed after it was written" when stale; *Open packet* (primary);
     - **question rows:** ? icon; "codex asks: “…”". **With the question contract (decision 47):** the whole question, a "Recommended" line naming the option, and *Answer* opens the **answer dialog** (§6.3). **An older question** stays on one truncated line and keeps its inline reply (textarea, *Send answer*, *Cancel*, "codex reads it on its next query");
     - rows have an amber tint, and clicking a row opens the item;
   - **Problems · N:** at most 5 rows, then "N more". Each row has icon, ID link + title, a reason of **up to two lines with the key fact first**, and its action. The server writes the reason as facts joined by " · "; each fact is kept whole, so the line wraps between facts and a fact that doesn't fit is hidden whole rather than cut (the full reason is in `title`). A single long fact (an error message) ends in an ellipsis. **Recovery rows** (orphaned resources, unpushed work, parked, ready to resume) show the worktree's `WorkspaceStateChip` after the title.

     | Problem | Action |
     |---|---|
     | Stale run ("Lead silent for 47m · the lease expires in 13m · treated as unknown, not finished") | *Inspect* → item, Activity tab |
     | Failed run | *Inspect* → item, Activity tab |
     | Cycle | *Fix* → item, Dependencies tab |
     | Date risk | *Timeline* → Work, Timeline layout |
     | Canceled blocker | *Fix* → item, Dependencies tab |
     | A blocker that must be verified closed with a deferred check ("RCP-22 needs RCP-12 verified, but 1 check was deferred") | *Open* → the blocked item, Dependencies tab |
     | Orphaned resources ("vite :5173 still running 18m after its run ended · stop it, then mark it released") | *Mark released* (once you've stopped it) · *Open* → Activity |
     | Work left in a worktree ("3 uncommitted files · commits already on main · C:/work/gf-280 · run ended (finished)") | *Keep for later* · *Safe to discard* (each opens a dialog saying what it does and doesn't do; undoable) · *Open* → Activity |
     | Parked for 24 h ("Parked since Nov 14 · waiting on the coordinator · keeps its claim") | *Open* → Activity (Release lead claim is also on the agent bar) |
     | Ready to resume, unattended ("Ready to resume: RCP-11 is done · parked 40m") | *Open* → Activity |
     | Extra backup copy failed | *Open* → Settings |
     | Backup failed or overdue (decision 41: "Last backup failed: …", "The backup due at Nov 21, 3:00 AM hasn't run") | *Open* → Settings |

     **Decision 41 (B49):** parked-too-long and unpushed-work rows go to the lead or coordinator first, so they sit under "Agents are handling N" until they reach the owner, with why ("No coordinator or lead is on GF-280", "Not handled by an agent for a day"). *Keep for later* leaves the worktree At risk; *Safe to discard* lets it count as Safe to prune and says so before it's confirmed. Both dialogs say "It doesn't commit, push, save or delete anything." "N more" under the rows is a button that opens the rest, because every counted row must be reachable. **The sidebar badge, the tab title and "N things to act on" beside the h1 are one number** (`needsYouCount`, from this page's own response for the current project: every card plus the Problems above), and there's no badge at 0.

     **Decision 37 (B42): every row says three things,** compactly so Needs you still fits one screen (a `dl`): after the ID and title, **who acts** as a "You" or "Agent" chip (its full line, "An agent (the lead of GF-228)", in the chip's `title` and for screen readers); **what's wrong** on up to two lines (the old one-line reason in its `title`); and **"Fix:"** on one line (the whole fix in `title`). An agent problem that reached you adds a `--warn` line, "Not fixed by an agent for a day" or "Nobody is working on GF-228". The item's banner shows the three lines in full. The actions sit under the text: the kind's own (table above; every *Open* now lands on the item's problem banner, `?problem=<id>`), then for agent problems *Remind the agent*, *Open the item* and *Not an active branch* (one per reported branch of a radar finding, named "Not an active branch: <branch>"; with two, "Not active: <branch>"), then *Acknowledge* on every problem not already acknowledged, and the "?" to "Problems and what to do".

     | Problem (decision 37) | Who acts | Actions |
     |---|---|---|
     | Out of date with main (a radar finding on one branch) | An agent | *Remind the agent* · *Open the item* · *Not an active branch* · *Acknowledge* |
     | Heading for a merge conflict (two items' branches) | An agent | the same, with *Not active: <branch>* for each reported side |
     | Every other row | You (or you or your coordinator, for recovery) | its own action · *Acknowledge* |

     On Overview these two lines sit in **Health**, each a disclosure button that opens its rows in place: **"Agents are handling N problems"** (agent problems within their grace period, with a "?") and **"You acknowledged N problems"**. Neither counts in the header or the sidebar.
   - **Agents' project-wide decisions** (decision 38; B44): a card each above the top band, after the proposed resolutions, counted as for you: "New project-wide decision by <agent>: <title>", the project and date, the decision text and "Why: …" (the reason), then *Confirm* (primary), *Withdraw…* (an optional reason inline, then *Withdraw* or *Keep it*), *Acknowledge* (keeps it as an agent decision without confirming it) and *Open* (the project Decisions page, focused on the record), and the "?" to "Decision records". Each action has a toast with Undo, and the card leaves once the owner confirms, withdraws, supersedes or acknowledges the record (undo brings it back). Item, epic and label decisions never make cards. **Older ones:** agents' project decisions recorded before decision 38 share one card per project, "3 project-wide decisions by agents to review", with the project, the first 3 titles ("and N more"), *Review* (the page filtered to *Needs your review*) and *Acknowledge all*; acting on each from the page shrinks it. The sample seed has none.
   - **Proposed resolutions** (decision 37): a card each above the top band, beside the shared-changes questions, counted as for you: "claude · orca-w3 proposes how to resolve a problem on GF-228" (the ID links to the banner), the kind ("Proposed: Split the work"), the reason, the plan (Markdown), and *Go a different way* (opens "Which way instead (required)"; *Send: go a different way*), *Acknowledge* and *Approve*. Each has a toast with Undo.
3b. **The lower row** (two cards, each showing the top 3 with *View all N →*):
   - **Deferred, not verified · N:** item + review text + "Test ticket RCP-29 · inbox" or "No follow-up ticket" with *Create test ticket*. *View all* goes to Work with the Deferred review filter. Empty: "Nothing deferred."
   - **Your Planning queue · N:** item + type and epic, with *Move to Ready*. *View all* goes to Work with the In planning filter. Empty: "Nothing in Planning."

**Rows are one or two lines**; truncate with an ellipsis (Problems: whole facts, above) and put the full text in `title`. Reviews that are coming up do **not** appear here (they're the *Human review later* filter on Work).

### 6.1b Daily brief (`/brief`; decision 48)
Answers in about a minute what finished, what's stuck, what needs the owner and what changed in decisions, for one day and the current project or All. Read-only, with no notifications or scheduled sends. Definitions are in BUILD_SPEC §5.29.

- **Header:** *← Overview*, h1 "Daily brief" with its "?", a labelled **Day** date field (latest: today in the configured timezone), *Today*, and a line naming the day and timezone ("Nov 23, in Europe/London, so far."). `?day=` holds the choice, and a value that isn't a real day is ignored.
- **Four cards** (two columns, one at ≤ 1180 px), each with an h2:
  - **What finished · N:** ticket and the time it finished.
  - **What's stuck:** **Parked longest · N** (how long, and the next step), **Blockers nobody owns · N** (status, and how many tickets it holds up) and **Held by your decision · N**, which says "These are waiting as you decided. Nothing is wrong." and names the decision. It appears only when a run has one (B58). On a past day the card says it's shown as it is now.
  - **What needs you · N:** the same number as the badge, from the same query, one line per action.
  - **What changed in decisions · N:** the title, what happened and who did it.
- **Every line is a link** to its ticket. A decision wider than one ticket links to the project's Decisions page, and an action with no ticket to where it's handled. Each list shows up to 8 lines, then "and N more". An empty section says so in one line.
- **What it cost** isn't shown until measured data exists: no section, placeholder or estimate.

### 6.2 Work (`/work`)
- **Header row:** h1 "Work", and on the right a segmented control: Board | List | Map | Timeline.
- **Filter row** (Board, List and Map; Timeline uses the same epic and label scope, and none of the status filters). Owner feedback from the Gameflow pilot (B43): the old row of seven chips wasn't what the owner reached for, so three quick filters stay on the row and the rest moved into a menu:
  - Epic select, Label select;
  - **quick filters**, chips with counts, one at a time: **Active** (not done or canceled; the default view), **Startable** and **Waiting** (Ready, split by whether it can start now; decision 48, BUILD_SPEC §5.30), **Blocked**, **In progress**. Each chip's `title` is "Agent query: <query>" (BUILD_SPEC §13; Active is `-status:done -status:canceled`, In progress `status:progress`);
  - a **Filters** menu button (`aria-haspopup="menu"`, a `menu` of `menuitemcheckbox`es, each with its count): *For you*, *Human review later*, *Deferred review*, *Live run*, *Has a problem* (an open problem on the item, decision 37), *Archived* (only once something is archived, or while ticked), a separator, then *Shows done* and *Shows canceled*. Enter, Space or Down opens it on the first entry (Up on the last); Up, Down, Home and End move; Enter or Space ticks and keeps it open; Escape closes it and returns to the button; Tab or a click outside closes it. The button shows a count badge when anything is ticked;
  - **combining:** ticked checks narrow the quick filter (AND); *Shows done* and *Shows canceled* add those items back on top of it (OR). *Archived* swaps the view to archived items (so archived done items need *Shows done* too). The old *All* is *Active* with both shows ticked;
  - each ticked entry shows as a removable pill next to the chips ("For you ×"), and a *Clear* button (shown while anything differs from Active) goes back to Active with nothing ticked. *In planning* and *Ready to start* aren't in the menu but still apply from the URL, as pills;
  - **counts** are over the current epic and label scope: each chip and check counts what you'd see with it chosen (the other ticks kept); *Shows done* and *Shows canceled* count the items they'd add;
  - **state:** the filter lives in the URL (§2), so links are shareable and Back and Forward work. The last choice per project is remembered in `localStorage` and applied when you arrive with no filter in the URL. Old links map: `filter=all` → Active + Shows done; `blocked` → Blocked; `for_you`, `human_review_later`, `live_run`, `planning`, `ready_to_start` → Active + that check; `deferred_review` and `archived` → Active + that check + Shows done.
- **Epics row:** "EPICS · N" and the type legend (Epic, Story, Task, Bug). One `EpicCard` per non-archived epic in scope; clicking one opens the epic. Shown on every layout except Timeline. **Done epics** (B43, owner feedback: with Gameflow's 40 epics the strip was mostly done ones) are hidden until *Show N done* at the end of the strip, which toggles to *Hide done* (`aria-expanded`); N in the heading counts the cards showing. An epic with no tickets always shows, and so does the epic the page is filtered to. Canceled epics never appear (§6.3).
- **A label filter** shows a callout: "Filtered by #label. Open the label page for its brief, progress by epic and bulk actions."

#### 6.2.1 Board
- **Columns:** six, `repeat(6, minmax(176px,1fr))`, scrolling sideways when needed: Inbox · Planning ("Yours") · Ready · In progress · Review ("Your human review") · Done. Each header shows its name and count.
- **Ready** splits into *Startable · n*, then *Waiting · n* (decision 48), by the server's `ready_state`. Waiting items show as red ID chips, each followed by what it waits on in words ("waits on RCP-12"). "Waiting · n · Show" is **one button** across the column (at least 32px tall, `aria-expanded`, a chevron), which expands them to cards. A card waiting on something other than a blocker says so.
- **Run line:** each claimed card ends with the lead's `RunLine` (§5): "parked · waiting on the coordinator · claude · orca-w4", in the parked style.
- **Review cards** with a ready packet open the packet screen directly (`title` "Open the handoff packet"). Other cards open the item.
- **Done** keeps every done item until it's archived (no time cutoff). Under the default *Active* filter (B43) done items are hidden, and the column says so: "Hidden by the filter." with *Show N done* (ticks *Shows done*). Under *Shows canceled* a seventh column, Canceled, follows Done.
- **Done** cards and the column:
  - each card has *Archive* (a small button at the bottom right, outside the card link);
  - the column header has *Archive all* (ghost button), which archives the visible done items;
  - both show an Undo toast.

#### 6.2.2 List
A table with these columns: ID, Title (type icon + title + labels, with the epic link below), Status (+ blocked chip), Priority, Lead · run, Human review, Last activity. The whole row is clickable. Empty: "No items match."

#### 6.2.3 Map
A `ProgressMap` of the filtered set, titled "Outside this view". When no epic or label is chosen, show the callout "Tip: pick an epic or label above. A whole project on one map gets busy."

#### 6.2.4 Timeline
- **Week grid:** a left column (type icon + ID + truncated title), then week columns.
- **Per row:**
  - an entered-plan bar (rounded, `--info-soft` fill), with `title` "Planned Nov 4 → Nov 11 · set by claude";
  - an actual-time line (5px violet) below it;
  - bar text when relevant: "✓ done", "⊘ blocked", "overdue", or "⚠ blocker ends later";
  - text under the bar **only** when there's a blocker: "after DOC-4 ends Nov 10", with the risky one in bold `--bad`;
  - a dashed vertical tick at each blocker's planned end; a red "Now" line.
- **Bottom:** a forecast lane per project (§9.1); a legend (Entered plan, Actual, Forecast, Blocker's planned end, Now); "Not on the timeline (no dates): ID, ID, …".
- **Burn-down card** above the grid (§9.1), collapsed to its one-line summary until opened.
- Archived items are excluded.

### 6.3 Ticket and epic (`/items/:id`)

**Header:**
- **First line:** ID, type badge, "in ◆ Epic" link + epic ID, labels, and an "Imported from Jira" chip when imported.
- **h1:** the title. Editable inline: an *Edit* pencil button appears on hover or focus (see "Inline editing" below).
- **Second line:**
  - status chip and blocked chip;
  - closed provenance on done items: "Closed after your human review", "Closed · n review deferred, not verified", or "Closed by agent: checks passed, no human review";
  - Priority select (P1–P3);
  - contextual actions:
    - Inbox: *Move to Planning*;
    - Planning: *Move to Ready* (primary) with "Planning is yours. Move it when you're satisfied, or ask an agent to.";
    - Done: *Archive*, or "Archived" chip + *Unarchive*;
    - any open status: *Cancel item…* in a "⋯" overflow menu at the end of the actions row. It opens an inline confirm, "Cancel RCP-31? Optional reason", with *Keep item* (focused) and *Cancel item*. Afterwards there's a toast with Undo. For an epic with open children, the confirm instead lists them and offers no Cancel button. For an item an agent leads, the confirm adds: "codex is working on this; its run will be interrupted."
    - any open Story, Task or Bug: *Split ticket…* in the same menu (decision 48). The dialog asks for the new ticket's title and type; each acceptance criterion, blocker, shared part and step is a labelled select (*Keep here*, *Move*, *Copy*); a radio group says how the tickets relate; and a live preview lists what stays and what goes. It warns when a lead is working on the ticket and when moving criteria will mark an open packet out of date. A toast offers Undo. The header then shows "Split from RCP-12" or "Split into RCP-33" as links.
    - History marks a question an agent retracted with a **Withdrawn** chip and its reason (decision 48).
    - Canceled items show the status chip "Canceled" and a struck-through title, and they leave the board, list and timeline (they're still in search).
- **Epic header:** status chip; "Project · N items · n done"; on a Planning epic, *Move to Ready* with "This epic is still a brief."

**Inline editing** (spec clarification 2026-11-14). The owner edits the **title, description, outcome and acceptance criteria**. Planned dates, effort and blocker links stay agent-edited in V1.
- **Entry:**
  - title: the pencil next to the h1;
  - outcome and description: *Edit* in the Outcome section header (Details tab);
  - acceptance criteria: *Edit* in the same section, which turns the list into one input per line, with *+ Add criterion* and a remove (×) on each.
- **Editing:**
  - the title is a single-line input;
  - description and outcome are Markdown textareas that auto-grow, with a *Preview* toggle;
  - *Save* is primary and *Cancel* is a ghost button;
  - `Ctrl+Enter` saves and `Esc` cancels (and asks to confirm if anything changed).
- **Save:**
  - sends `expected_version`;
  - on success, a toast "Saved. Agents see it on their next read." with Undo;
  - the Activity tab shows "You edited the outcome".
- **Conflict** (an agent changed the field since you started): the editor stays open with an inline `--warn` callout, "codex changed this at 10:52. Their version is shown above; your text is kept below to copy back." The two texts appear stacked, with *Use mine anyway* (re-sends against the new version) and *Keep theirs*.
- **Limits:** title 200 characters, outcome and description 20,000, each criterion 500. A counter appears once 80% of the limit is used.
- **Accessibility:** the edit button's label is "Edit title" (etc.), and focus moves into the field on open and back to the button on close.

**Agent bar** (B20), directly under the header, on every tab, so the coordination state is never a tab away. A `section` labelled "Lead agent".
- **With a lead:** one line: the lead's `RunLine` (`state · client · label`) · "last signal 40s ago" · "step 2/4" (the step it's on, its text in `title`) · the worktree's `WorkspaceStateChip`, then at the right *Release lead claim…* (stale or parked lead) and *Copy resume note* (stale or parked). These are the Lead and runs actions (§6.3.2), the same code and dialog.
- **Parked lead:** a second line, "Parked: waiting on the coordinator since 10:57" (or "waiting on RCP-12", "a person", "until …"; a day and time once it's over 24 h), with the park's own reason in `title`, plus a "Ready to resume" chip when it can.
- **No lead:** nothing, except a quiet dashed "No agent on this" while the item is In progress (its run failed, or was released). Epics show no bar.
- It updates in place from the live stream without moving focus. A polite live region announces only a change of run state ("claude · orca-w4 is stale on RCP-17."), never the ages ticking.
- Activity → Lead and runs stays: it is the full run history.

**Banners above the tabs** (visible on every tab):
- **Problems** (decision 37; first): a `section` labelled "Problems with GF-228", shown while the item has an open problem, acknowledged or not, until it's resolved. Each problem is a `--warn` banner (a `group` named by its title, focusable): a warning icon (an exclamation, `role="img"`, named "Problem" or "Problem (acknowledged)"), a short title ("Out of date with main", "Heading for a merge conflict", "Lead agent silent", "Dependency cycle", …), the You/Agent chip, the three lines, "Why you see it", "Acknowledged by you 5m ago", any proposed resolution with its choices, and the row's actions (without *Open the item*). Several stack under "n open problems". Open overlap and undeclared-changes questions on the item stack here too, as their Needs you cards with a warning icon. `?problem=<id>` focuses that banner (outlined) and scrolls it into view.
- **Packet ready:** amber banner, "Handoff packet ready (round n). k things to verify, about 10 min. The ticket can't close until you approve.", with *Open packet*.
- **Open question:** the question, then either the recommended option and *Answer* (decision 47), or, on an older question, an answer textarea and *Send answer*. After answering: "You answered: “…”. Waiting for codex to read it."
- **Answer dialog (decision 47):** titled with the plain question. *Background*, *Why this matters*, then *Your choice*: each option as a selectable card with its description and "If you choose this", the recommended one marked with "Why it’s recommended", and a last card, *Something else*, which swaps the optional note for a required free-text answer. *Technical details* stay collapsed. The recommended option starts selected and focused, so *Answer* then *Send answer* (or Enter) picks it in two actions. Arrow keys move between cards, Ctrl+Enter sends from a text box, Esc or *Cancel* closes and returns focus to *Answer*, and what was typed is kept if it is reopened. The header and footer stay visible while the body scrolls, at 1024 px and 1440 × 900 with the longest allowed text. The success toast has *Undo*.
- **From review:** "Created from your human review of RCP-12 (…)".
- **Out of scope:** "RCP-21 belongs to Recipe App, outside the project you're viewing.", with *Switch to Recipe App*.

**View tabs** (`ViewTabs`, §4). One column of `Section`s per tab.

| Tab | Ticket | Epic | Label extras |
|---|---|---|---|
| **Details** (default) | Outcome (summary "n acceptance criteria"); Decisions (summary "n in scope · n by agents"; hidden when there are none); Documents (summary count); Dates and effort (summary "Nov 4 → Nov 11" or "not set") | Brief and documents; Decisions (this epic's own, plus a link "n project decisions"); Tickets in this epic (summary "n/N done · n ready but blocked · n for you"; with no tickets, "No tickets yet · Status", the same as its card, and the empty text "No tickets yet. Add one with + New item in this epic."), grouped by status. Each row: type icon, ID, title, then the same pieces a Board card uses: the `BlockedChip`, a `ForYouChip`, and the lead's `RunLine`. Archived tickets fold into "+ N archived · Show". | — |
| **Checklist** | Work (summary "n/N done · the agent's plan"; *Checklist history* in the header when there are revisions); Agent review ("n/N passed · what the agent verifies itself"); Human review ("n items · packet ready · what you verify yourself"; *Open packet* in the header when ready) | Same three sections, at epic level | Count: work done/total on tickets; total item count on epics; amber dot when a packet is ready |
| **Dependencies** (ticket) | A plain card. h3 "Waits on n · unblocks n"; the 1-hop view (§6.3.3); a cycle callout with a *Remove "A blocks B"* button per cycle link; "Relates to (doesn't block): …"; *See it on the epic map →* | — | Count = links; red dot when in a cycle |
| **Map** (epic) | — | Epic-level review strip (when the epic has human review), then a `ProgressMap` of its children | Count "done/total" |
| **Activity** | Lead and runs, the full run history (summary "codex · orca-w1 · stale" or "unclaimed"); History (summary "n updates"), with the *note for the agent* box at the top | History with *note for the agents* | Amber dot on stale, failed or claim-conflict runs |

*+ New item in this epic* sits at the right of an epic's tab row.

**Tab memory and entry points:**
- An item opens on Details, or on the tab you last used for it.
- *Inspect* opens Activity; *Fix* opens Dependencies; *See it on the epic map* opens the epic's Map.
- Arrow keys move between tabs (ARIA tabs pattern).

#### 6.3.1 Checklist rows
- **Work step:**
  - layout: state icon (done ✓ green, current violet ring, todo dashed, blocked red) · text (bold) · who and when, right-aligned;
  - a revised step shows the old text struck through, plus "Changed: <reason>" in `--warn`;
  - "Added from your review, round n" with a person icon;
  - "Stopped here: see the failed run" on blocked steps;
  - subagent contributions are nested underneath, each with provenance badge, name, source and outcome;
  - owner-added steps show "added by you" and *Remove* (while not done).
- **Agent check:** state icon · text and evidence · provenance badge, or "not run yet". Owner-added checks: "added by you", and *Remove* while still todo.
- **Human review item:**
  - person icon · text · "added by claude" or "added by you" · state chip;
  - *Edit* and *Remove* while declared;
  - while in a packet: a lock and "In the current packet" in place of the actions;
  - edit mode is an inline textarea with *Save* and *Cancel*;
  - the last decision note shows underneath with its provenance badge.
- **Add rows:** one input with an *Add* button at the end of each section. Enter adds. Placeholders:
  - Work: "Add a step for the agent, e.g. Handle an empty week plan"
  - Agent review: "Add something the agent should verify, e.g. Run the full test suite on a clean checkout"
  - Human review: "Add something you'll verify, e.g. Try it on your phone"
  - On epics, the Work and Human review examples become "Update the release notes" and "Walk through the whole feature before the PR merges".
- **Notes under Human review:**
  - "The agent writes a handoff packet when the work is built. This ticket can't close until every item is decided." (open, no packet);
  - "No human review declared. When its checks pass, the agent can close this without you." (none);
  - "None on this ticket. It is reviewed with its epic: ◆ …" (a child of an epic-level review);
  - "New items aren't in the current packet; the agent includes them next round." (packet open).

#### 6.3.1a Step dialog (decision 33)
- **Opening it:** clicking a step's title, or its details icon (shown when the step has details, with an accessible name of "Details for <step>"), opens a dialog. There's no inline expansion. The row also shows the step's source, muted, after the icon (B34). A link with `?step=<id>` (B35; the palette's sub-task key hits) opens that step's dialog, and the parameter then leaves the URL; moving and closing are local, as before.
- **Contents:**
  - the title, status chip and source (a Jira key linking to the Jira issue when the project has a Jira site);
  - the rendered details (Markdown, sanitized);
  - the history (wording changes with reasons, state changes by whom and when);
  - subagent notes with their provenance.
- **Editing:** *Edit details* opens the inline editor in the dialog, with `expected_version`, the conflict callout, *Ctrl+Enter* to save and Esc to cancel.
- **Moving around:** *Previous* and *Next* step buttons, with "Step 2 of 5" (and ← → when focus isn't in a field or the editor; both are off while editing). Esc closes, and focus returns to the row of the step last shown. Esc inside the editor cancels the edit, not the dialog.
- **Data** (B34): `GET /api/items/:id/work/:stepId` gives the step, its history (the same as `get_step`'s) and the project's Jira site; the dialog opens on the row's data and fills the history when it arrives.
- **Size:** it's sized for long text (up to 960 px wide and 85 vh tall, with the body scrolling), and works at 1024 px.

#### 6.3.2 Lead and runs
- **Wait card (decision 45):** under a parked lead's line: "Waiting for GF-381 (planning, clears when done)", "Waited since 20:48" (when this run first parked on it, with the ISO time in `title`), "Next: orca · GF-381: shape it or assign it", the exact sentence on how the same run resumes, a warning chip per raised flag, and, when a blocker was linked after the claim, "GF-381 was added after work started: confirm it holds the whole story. If only part is held, split that part out and let the rest proceed." On a blocker: "Unblocks GF-243, waiting since 20:48". Advisory: it has no controls and holds nothing.
- **Coordinator's park (decision 44):** the status line reads "Parked by X until Nov 22 14:20" in place of "Status updated by X", with the deadline's ISO time in `title`. After it runs out: "Park by X ran out at 14:20. It has a short lease to call back." until the run speaks or its lease ends.
- **Status line (decision 42):** under the agent bar, "Producer X", "Status updated by Y" and "Activity since parked: 2 commits, RCP-25 cleared", or "Commits while silent… Its session may not have Docket." A story between workers reads "Between workers: X holds this until 14:32" instead of "No agent on this". Board cards show "Producer X" or "Between workers · X".
- **Run rows:** the run's `RunLine` (`state · reason · agent`, the agent in bold, the last-signal age), a "lead" chip, "started 30m ago", and "what" (current step or last report).
- *Release lead claim…* and *Copy resume note* are shared with the agent bar (§6.3): one implementation, one dialog.
- **Where the work lives** (owner decision 26), one compact block under each run row:
  - `branch · worktree path` (path truncated in the middle, full path in `title`, *Copy*);
  - `last commit 4be1c09 · pushed ✓`, or `2 commits not pushed !` in `--warn`, plus `uncommitted changes` when `dirty`;
  - the orchestrator's IDs, muted (`orca · ctx_6f2d…`);
  - the brief as a link that opens the document viewer;
  - a resource list (`dev server :5173 · running` / `released 03:20`), with *Mark released* on unreleased ones once the run has ended;
  - **parked runs** show "Parked · waiting on RCP-12 · since 10:40 · reason …" and, when resumable, a "Ready to resume" chip.
- ***Copy resume note*** (on interrupted, stale and parked runs) copies a plain-text block for a coordinator:
  ```text
  Resume RCP-15: worktree <path> on <branch> @ <pushed_sha>
  (<n> unpushed commits / uncommitted changes, or "clean"),
  brief <document link>, checklist <done>/<total>, claim_lead first
  ```
- **Claim conflict:** a warning callout, "claude · orca-w2 tried to claim lead at 10:58. Rejected: codex · orca-w1 still holds the lease."
- **Error output:** in monospace on `--bad-soft`.
- **Stale lead:**
  - *Release lead claim…* opens a destructive dialog titled "Release lead claim on RCP-15?". Body: "codex · orca-w1 has been silent for 47 minutes. Releasing will:", then the bullets "mark run r-58 as **interrupted**, not finished", "keep its checklist, log and partial work on the ticket", and "move RCP-15 back to Ready so another agent can claim it". Footnote: "If codex comes back, it gets a conflict response with the current state." Buttons: *Cancel* (focused) and *Release claim*.
  - Under the button: "Or wait: the lease expires on its own at 11:13."
- **Failed run:** *Return to Ready*, with "This service never launches agents. A connected agent picks it up next."

#### 6.3.3 1-hop dependency view
A vertical stack:
1. "Waits on" plus a node per blocker (marked "other epic" or with the project when outside);
2. ↓;
3. the current node (highlighted);
4. ↓;
5. "Then unblocks" plus a node per dependent.

Nodes are the map cards from §6.3.4. A done blocker that still blocks shows "done · waiting for merge" or "done · waiting for your verification", with the link's rule in `title` ("This link needs RCP-12's PR merged (reported by the agent)"). Empty: "No blocking links."

#### 6.3.4 Progress map
Used on the epic Map tab, label pages and Work → Map.

- **Header:**
  - "n / N done" (big n);
  - a bar split by status in order: done, review, progress, ready, blocked, planning, inbox, in the §5 status colours (Ready that can't start is its own red segment, so the bar adds up to the total);
  - status counts with swatches, including "n ready but blocked" in red;
  - "n ready to start · working on wave x of y".
- **Columns are waves:**
  - "Wave 1 / nothing blocks these";
  - "Wave n / after wave n−1";
  - before them, a dashed "Outside this epic / blocks work here" column (or "Outside this view" / "Without this label");
  - cycle members get a "Cycle" column;
  - wave index = the longest `blocks` path from a root within the scope set;
  - cards within a wave are ordered to reduce crossings (a deterministic barycenter pass) and sit on rows shared across the map, so the map doesn't jump between renders.
- **Card** (200px wide):
  - type icon · ID (+ "other epic ↗" or project) · title (2 lines) · "Status · run state" or "· after RCP-12" on Planning items;
  - left edge in the status colour;
  - done = green fill with ✓;
  - blocked Ready = red border and "blocked";
  - human review person icon at the top right (§5);
  - each card is a focusable button that opens the item.
- **Spacing:** columns 200px with gutters of at least 76px; at least 16px between rows; both grow with the number of arrow lanes they carry; the canvas padding is 18px 22px; maximum height 540px; dotted background.
- **Arrows:**
  - rounded orthogonal SVG paths from the right edge of a blocker to the left edge of the blocked item, with arrowheads;
  - **an arrow never crosses a card** other than its two ends, at any zoom: it runs only through the vertical gutters between waves and the horizontal channels between rows (B47);
  - parallel arrows get their own lanes, and several arrows on one card spread across its edge;
  - solid `--ink-3` = still blocks; dashed `--ok` = cleared (blocker done);
  - redraw on resize (80 ms debounce) and on zoom;
  - hover or focus on a card highlights its links, paints them on top and dims the rest.
- **Pan and zoom:**
  - drag the background (grab cursor), scroll, or use arrow keys while the canvas is focused;
  - edge fades plus clickable *More →*, *← More*, *More ↓* pills when content overflows;
  - "Drag to pan" hint text only when overflowing;
  - zoom controls − / percentage / + / **Fit**: steps 50, 67, 80, 100, 125%, default 100%; Fit scales to show everything, down to 40% at the smallest.
- **Key** (one line under the map): "Arrow = blocks · dashed green = cleared · hover to trace", plus the two person icons with "packet ready for you" and "your review later".
- **Critical path (decision 48, B60)**, on the epic Map tab and Work → Map:
  - *What's holding up* picks a ticket or epic as the goal (`?goal=`). The ticket's Dependencies tab and the epic's Map tab link to it;
  - above the map: **Move next**, the ticket, its reason as a labelled chip and one plain sentence, then the chain's length and the number of open blockers. A blocker loop gets a callout;
  - *The chain as a list* is the same chain as an ordered list, first ticket to move first, each with its status in words;
  - on the map, chain cards are outlined and read "Step n of N" ("Move next · Step 1 of N" on the first), chain arrows are heavier, and other arrows fade. Other cards are muted without opacity, so their text keeps its contrast. The ticket to move next scrolls into view;
  - chain tickets outside the view are added as outside cards and aren't counted in the header.

#### 6.3.5 Decisions
Decision records (BUILD_SPEC §5.14) appear where they apply:
- **ticket Details:** the decisions made for it: this item's, its epic's and its labels' (decision 38);
- **epic Details:** the epic's own and its labels' (decision 38);
- **label page:** the label's own records;
- **the project Decisions page** (§6.3.7): project-wide records. Settings → Projects links to it.

**Decision 38 (B44): project records aren't listed on tickets or epics.** Instead, under the listed records, one line: "3 project decisions also apply · View" ("1 project decision also applies"), counting the active project records, shown only when there is at least one; *View* (an underlined link, accessible name "View RCP project decisions") opens the project Decisions page. On a ticket the section is hidden only when nothing is listed and no project record applies. The header counts and *Show withdrawn and superseded* cover what's listed.

**Each section:**
- **Header:** "Decisions", with the summary "n in scope · n by agents". *+ Record a decision* sits in the section header.
- **`DecisionRow`:**
  - the title in bold;
  - the decision text (2 lines, then *Show all* / *Show less*, shown only when the text is longer), and the rationale under *Show reasoning* / *Hide reasoning* (collapsed; shown as "Why: …");
  - a scope chip ("◆ Epic name", "#label", "This item" on ticket Details; "This epic", "#label" on epic Details, where records are inherited);
  - the authority badge (§5);
  - the author and date ("claude · Nov 6").
- **Actions:**
  - on an agent record: *Confirm* (makes it an owner decision) and *Withdraw…*;
  - on an owner record: *Withdraw…*;
  - *Supersede* opens the record form prefilled, and saving marks the old one superseded.
  - *Withdraw…* asks for an optional reason inline (no dialog) and shows an Undo toast.
- **Order:** owner records first, then newest. *Show withdrawn and superseded* reveals the inactive records, greyed.
- **Record form** (inline, under the header): Title (required, ≤ 120), Decision (required, Markdown, ≤ 4,000), Why (optional), Scope (preset to where you are; on a ticket you can pick This item, the epic, or the project). *Save* and *Cancel*. Records you create are owner decisions.
- **Empty** (ticket): the section is hidden. Elsewhere: "No decisions recorded. Agents record conventions and choices here; yours are authoritative."

Agent decisions for an item, an epic or a label never appear in Needs you. They show here, and in the item's Activity ("claude recorded a decision: …"). An agent's **project** decision is a Needs you card until the owner handles it (decision 38; §6.1).

#### 6.3.7 Project Decisions page (`/projects/:key/decisions`, decision 38)
Project-wide decisions, managed in one place.
- **Breadcrumb:** project name › Decisions. **h1** "Project decisions · <project name>" with the "?" to "Decision records", and one line: "Decisions that apply to every item in RCP. Agents get them with every item's context; tickets show only their own, their epic's and their labels', with one line pointing here."
- **Filter:** a `SegmentedControl` labelled "Show decisions", *All* and *Needs your review (n)*: agents' active, unconfirmed records. It is in the URL (`?filter=review`).
- **The Decisions section** (§6.3.5), always open here (it is the page's content, so a collapse saved on a ticket doesn't apply and its header isn't a toggle), with every project-scope record: *Confirm* on agent records, *Supersede*, *Withdraw…*, *+ Record a decision* (scope Project, shown as text), *Show withdrawn and superseded*; each action toasts with Undo. Empty under *Needs your review*: "Nothing to review. Agents' project-wide decisions wait here until you confirm, supersede or withdraw them."
- **`?decision=<id>`** (a Needs you card's *Open*, a kept review note's link): once loaded, the record scrolls into view, gets focus and a focus ring. A withdrawn or superseded record opens with *Show withdrawn and superseded* on, so the link still lands.
- **Opens from:** the "also apply" line, the project switcher's *Project decisions*, Settings → Projects ("n decisions"), the Needs you cards and Help.
- An unknown key shows "There's no project XYZ." with a link to Settings. Fits 1024 px; axe-clean in both themes.

#### 6.3.6 Shared changes (decision 36)
- **An item's Details tab** gains a **Shared changes** section, listing:
  - each declared part with its change (add, change or remove) and note;
  - "None" when declared none, or "Not declared yet" (warn);
  - overlaps with other items (linked, with their state);
  - leases held (with *Release lease*);
  - radar findings;
  - **Branches** (B40; B41: several): the branches the radar trial-merges, a list of "<name> · reported by <who>" with *Remove* on each. With none reported, "Branch found by the radar: <name>"; with several matches, "Several branches match; add the branch: <names>" (warn); with neither, "No branch yet". *Add branch* opens a small dialog (suggesting the matches when none is reported). Removing a branch moves focus to *Add branch*; removing the last lets the radar look again. Both are undoable. A finding names both branches ("<own> vs <other>") and adds "branch found by the radar" for a found one.

  The owner can edit the declaration with the same editor pattern as elsewhere.
- **Needs you:**
  - **Overlap questions**, a card for each pair: "GF-240 and GF-312 both change model Token", with *Run one after the other*, *They're compatible* (an optional note) and *Open both*;
  - **Undeclared-changes holds:** *Add to the declaration* or *Send back*;
  - **Problems:** radar findings ("Heading for a conflict"). Decision 37: they're agent problems ("Agents are handling N problems") until nobody leads the item or a day passes; overlap and hold cards show the three lines (§6.1).
- **Decision 39 (B46), who is asked:**
  - **The ticket's Overlaps** show each outcome on both tickets: a chip ("Docket: in parallel", "Docket: in order", "waiting for you"), why, what it rests on (each item's declared change), any design note, and the files whose lines collide. On an outcome Docket chose: *Run in parallel* or *Run in order*, with Undo on the toast.
  - **A radar conflict** on the ticket says who goes first ("This item merges first" or "Rebases after GF-240 merges"), with the honest line: "The radar sees committed local branches only. A clean trial merge means git can combine them, not that they work together."
  - **A change to an approved design** always gets a Needs you card and a ticket banner, with or without an overlap and in every mode: "GF-312 changes an approved design", the item with a "paused" chip, the three lines, each part with its change and note, "Other work continues", and *Approve the design change* or *Send back* (which opens a required note, "What should the agent do instead?"; an empty note keeps focus there with an inline error). Both have Undo on the toast. The ticket's Shared changes lists its reviews under "Approved-design changes" ("waiting for you", "approved by you", "sent back", with the owner's note).
  - **Needs you** gets an overlap card only for level 3: a cycle, a dispute, what the setting asks, or a sequence unresolved after the grace period ("Not settled by agents for a day"; *Run in parallel* or *Keep this order*). Everything else is one quiet line, "Docket handled N overlaps today", which opens them in place, each linking to its tickets.
  - **The declaration editor** takes a member in the part field, plus "Changes an approved design" (with a required note) and "Ownership is disputed" per part.
- **Work cards:** a small "overlap" or "conflict ahead" marker when relevant.
- **Settings → Projects → <project> → Shared parts** (B39: its own page, `/settings/projects/<key>/shared-parts`, linked from the project row):
  - the registry (key, kind, paths, single-writer, in-flight declarations);
  - the radar settings (repository path, main branch, *Run radar now*, last run).

### 6.4 Human review packet (`/review/:id`)
Not in the sidebar. It opens from *Open packet* (Needs you, the ticket banner, the Checklist), Review cards, and handoff packets in a ticket's Documents. While it's open, Needs you is the active nav item.

- **Layout:** three columns, `230px | 1fr | 300px`, gap 14 (narrower: see §2).
- **Left, queue:** "Ready for you · N" lists packet buttons (ID, a "Round n" chip, title, "about 10 min" and "out of date" when stale). Viewing a decided packet adds a "Viewing" group. Empty: "Nothing else is waiting on you."
- **Middle, packet:**
  - **Header:** ID link + title; round buttons, each showing "sent back" (amber) or "approved" (green), plus a dot on the current round; on the right, "codex · Nov 6 10:42 · pkt-9c0e · built from 9c0e7f2 · about 10 min".
  - **Earlier round:** callout "Earlier round. Its decisions are shown below and don't carry over." Read-only.
  - **Out of date:** red callout with *Ask for a fresh packet*.
  - **Sections:**
    - **What you're verifying:** each item is a bordered box with the number + text and a verdict radio group: *Looks good* (✓), *Needs changes* (×), *Defer* (‖);
    - **How to verify:** ordered list;
    - **Already checked by the agent:** provenance badge + text + evidence;
    - **Known gaps:** bullets;
    - **Attachments:** buttons that open the document viewer.
  - **Looks good** reveals "Notes for later (optional)", a textarea with the placeholder "e.g. Fine here, but next time put the fixture in tests/fixtures/" (decision 35). Once the note has text, "Keep it for" [This ticket | The epic's future tickets | All <project> work] (the project's short name; *This ticket* is the default), and a line under it says what the choice does: "Posted as a note for the agent on RCP-12.", "Also saved as an owner decision on RCP-1: agents get it on the epic's other tickets." or "Also saved as an owner decision for Recipe App: every agent working on it gets it." Without an epic, *The epic's future tickets* is disabled, and "RCP-20 has no epic, so the note can't go to an epic's tickets." (its description) shows under the control. A blank note sends nothing.
  - **Needs changes** reveals "What needs to change (required)", a textarea, and "Send it back as" [Checklist item on this ticket | New bug ticket].
  - **Defer** reveals "Why defer, and what's still needed (optional)" and "Follow-up" [Create a test ticket in Inbox | No ticket: agent follows the project workflow], plus the note "Deferring clears the gate so work can continue. The item is recorded as not verified, never as approved."
  - **Past rounds** show the decision provenance badge, the note, and "→ checklist item", "→ bug RCP-30" or "→ test ticket RCP-29". An approval's note reads "Note for later: “…”"; when it was kept for the epic or the project, "→ decision for the epic's future tickets" or "→ decision for all the project's work" links to the ticket's Details, whose Decisions list it (its *Why* reads "From your review of RCP-12, round 2: …"). The item's History row for the review adds "· See the decision".
- **Right, decision:**
  - "Your decision · round n", "n of k items decided";
  - the primary button names the outcome:

    | Situation | Button label |
    |---|---|
    | Not every item decided | *Decide every item first* (disabled) |
    | Any item needs changes | *Send back to codex* |
    | Any item deferred | *Close ticket (1 deferred)* |
    | All approved | *Approve and close ticket* |

  - a callout below says exactly what will happen ("Approving records your decision on pkt-9c0e and closes RCP-12, which unblocks RCP-22, RCP-23.").
  - After submitting: a toast with Undo, and the queue advances to the next packet.

### 6.5 Label page (`/labels/:project/:name`)
- **Header row:** "#name" + "Project · n/N done"; on the right, *Show on the board* and *Move N to Ready* (primary, only while something with the label is in Planning).
- **Below, one column:**
  - Brief card (or "No brief. Add one if this label is an initiative with shared decisions."), with "written by owner · Nov 2";
  - Progress across epics: a `ProgressMap` with "Without this label";
  - By epic: a group per epic (or "No epic") with done counts, and rows of type + ID + title + status + human review chip;
  - Decisions: the label's records (§6.3.5).

### 6.6 Agents (`/agents`)
h1 "Agents", then one line with the ticket counts the sidebar and Overview show and what this page lists instead: "2 tickets being worked · 0 parked/waiting. The lists below show individual runs, so one ticket can have several." Then three collapsible `Section`s (B20), in this order:

1. **Active now** (summary: "n runs"). Runs in the order **needs input, failed, stale, parked, live, reported**, newest signal first within a state.
   - `?state=parked` shows that state only: the summary reads "1 parked run" and the header has *Show all*.
   - Empty: "No runs yet. Connect an agent from Settings." when nothing has ever run, else "No active runs." (or "No parked runs right now." when filtered).
2. **Workspaces** (summary "n at risk"; anchor `#workspaces`), below.
3. **Recent** (summary "n in the last 24 h"), **collapsed by default**, its open state remembered like any section: finished and interrupted runs that ended in the last 24 h, newest first. Empty: "No runs ended in the last 24 h."

Active now and Recent share one table, with these columns:
- State (the `RunLine` without the agent: "parked · waiting on RCP-12");
- Agent (bold, never wrapped);
- Item (link);
- Doing / did;
- Last signal ("40s ago");
- Lease ("Until 12:02", "Expires 11:13", "Paused", "Released", "—");
- How we know: "Client heartbeat" when live, `Provenance` for agent-reported, observed or relayed, or the gray chip "Unknown: no heartbeat" when stale.

Rows link to the item. **Subagent log entries aren't listed here;** they show on their item's Checklist (§6.3.1).

**Workspaces** (the second section on Agents; owner decision 26): every recorded worktree, so you and a coordinator can see what's safe to prune.
- **Columns:** State chip (*In use*, *Parked*, *At risk* in `--warn`, *Safe to prune* in `--ok`, *Unknown*), **What to do** (B56), Path (with *Copy*), Branch, Item, Last activity, Pushed (`✓`, or `n behind`), Resources (unreleased count).
- **What at risk means (B56):** with any at-risk row, a line above the table explains it and says to leave the worktree in place until the work is dealt with. **What to do** comes from `at_risk_owner`: "Needs your choice." with a link to Problems, "Nothing for you" with the reason (an agent owns it, you kept it for later, you acknowledged it), or "Docket can't tell who owns it. Ask your coordinator to check it." It never suggests deleting anything.
- **Sort order:** At risk, In use, Parked, Unknown, Safe to prune.
- **A filter chip** "Hide safe to prune", in the section header, is on by default.
- **Empty:** "No workspaces recorded yet. Agents report theirs when they claim work."
- **Every worktree (decision 48, B60).** A switch in the header, *Recorded by agents* / *Every worktree* (`?worktrees=all`), shows every worktree of the project's repository. With All projects in scope, a Project menu picks one.
  - **Columns:** Verdict (labelled chip and why), Branch and folder, Ticket or "Not tracked by Docket", Last activity, What it holds (uncommitted files, commits not on a remote and merged to main, each labelled), What to do. A value git couldn't read says "Unknown", never 0.
  - **Groups,** in order: Holds work, In use, Unknown, Kept for later, Safe to remove, 50 rows each until *Show all*.
  - **Filters:** a chip per verdict with its count, *Not tracked by Docket*, and text over branch, ticket and folder.
  - **What to do:** the at-risk owner's words (B56) on Holds work. *Show command*, with the full command on its own row to read and copy, on Safe to remove only, under a note that Docket never removes a worktree, to check each command first, and that ignored files go with the folder.
  - A status line gives the check's progress or age and says remotes are as of the last fetch, with *Check again*.

### 6.7 Settings (`/settings`)
h1 "Settings".

- **h2 "Projects":** one row per project:
  - colour swatch, name (+ "Current" chip), "KEY · n epics · n items · n documents · n for you";
  - label tags;
  - **Coordinators** (decision 42): names, comma-separated, who may correct a run's status with `update_run_status` here, and nothing else;
  - a mini status bar with "n done · n active · n review · n planning";
  - "Blockers clear when": a select with **Done** (default), **PR merged** and **Verified by you**. Its `title` reads: "When a blocking item counts as finished for its dependents. Agents can override it per link. PR merged is reported by the agent." Changing it shows the toast "Blocker rule for Recipe App set to PR merged. 2 items are blocked again." with Undo;
  - "n decisions", a link to the project's Decisions page (§6.3.7; decision 38 replaced the dialog);
  - *Switch to*, and *Delete…* (danger text);
  - *Import from Jira…* at the bottom (§9.2).
- **Delete dialog:** titled "Delete Sample · Recipe App?". Body: "This permanently removes **N work items**, their checklists, runs and history, and **N local documents** including handoff packets. Agents will get “not found” for these IDs." Then a warning callout: "Backups keep a copy until their 14-day retention ends. Removing the Docker container alone doesn't delete data." Then an input "Type RCP to confirm" and *Cancel* (focused) / *Delete project* (enabled only when the input matches).
- **h2 "Connections":**
  - **Client compatibility table** (Client, Transport, Last seen, Status chip Verified / Not verified, Results: Text only / Structured per MCP_SPEC §3 Results, Notes), with "Smoke test: claim, plan, log, read back" in the header. Surfaces that are off by default ("Agent in another container") are a **footnote under the table**, not a row: "**Agent in another container** (Docker network): not configured. Off by default. Needs an explicit network path (O02).";
  - **Client setup card:** Codex | Claude Code segmented control, a code block, and *Copy*. The token placeholder is `$DOCKET_TOKEN`; show the token itself only behind *Reveal token*, which needs a click and auto-hides after 30 s;
  - **Endpoint card:** MCP URL, Web UI URL, Bind "Loopback only", Auth "Bearer token", Origins;
  - **Service health card:** Database and Documents with ready chips and sizes, Volume, Backups: one row per location, "In the data volume · Nov 6 03:00 · kept 14 days", and, if configured, "Extra copy: /backups-extra · Nov 6 03:01". When the extra location isn't configured, a muted line explains how to add it ("Mount a host folder and set DOCKET_BACKUP_EXTRA_DIR; see the README"), Restarted (with "2 open runs were kept. Agents continue with the same run; one that doesn't return ends when its lease runs out."), *Download diagnostic log* (the last 7 days of agent calls, without contents), and *Lock this browser* / *Rotate owner key*.
  - **This browser card:** "Desktop notifications" with a switch, a status line ("On", "Off", "Blocked by the browser. Allow notifications for 127.0.0.1:7420 in your browser settings.") and *Send a test notification*. Theme is also set here.

**Overlap handling** (decision 39; B46): a section after Projects. A default for all projects as three radios (*Agents resolve*, *Ask on shared data*, *Ask on every overlap*), each with one line saying what reaches the owner (a change to an approved design always does), and a table with one select per project ("Default (…)" or an override). Owner only: no MCP tool writes it. Leases, merge checks and decided overlaps are the same in every mode.

### 6.7b Agent files (`/agent-files`, decision 29; redesigned in B25)
**Start a session with Docket connected (decision 42):** a card of copyable per-launch commands for Claude Code, Codex and Codex in protected mode. They apply to that session only and change no config file.

Its own nav item, after Agents. It isn't under Settings and isn't marked service-wide: like the other pages it follows the project switcher (All projects, or one project). The screen shows **two ideas, not three layers**, and never uses the words bundled, layer, override, effective set or service-wide:
- **Default:** what every project uses (stored as the bundled version plus the owner's service-wide edit). It reads "Docket's version", or "Edited" with a small marker when the owner edited it; *Reset to Docket's version* removes the edit (B23's revert of the service layer).
- **<Project>'s copy:** exists only once the owner customizes a file for that project (the project layer). Its presence is the indicator.

**With one project selected** (h1 "Agent files · Recipe App", with *Install into Recipe App's repo* on the right):
```
Workflow notes   Rules agents get with every Recipe App item (in get_context)      [Edit]

FILE                     USING
docket-worker          Recipe App's copy · edited 2d ago      [Edit] [Use default]
docket-coordinator     Default                                [Customize for Recipe App]
docket-planner         Default (edited)                       [Customize for Recipe App]
AGENTS.md block          Default                                [Customize for Recipe App]
⚠ The default docket-worker changed since Recipe App's copy was made.   [Compare]

Install log · Recipe App
```
- **Workflow notes** (top): the versioned Markdown editor (optional note, history with diffs, "Saving an empty text clears the notes"). Empty notes show *Start from template*, which loads `docs/templates/WORKFLOW-starter.md` (bundled into the web build) into the editor, unsaved.
- ***Customize for <project>*** opens the editor on a new copy, starting from the current default; saving (note required) creates it. ***Use default*** removes the copy (B23's revert of the project layer); its versions stay in History, and the toast has Undo.
- **"The default changed since <project>'s copy was made"** shows when Docket shipped a new version since the copy (the server's bundled-updated flag on the project layer) or the default was edited after the copy's current version. *Compare* opens the file on that comparison.

**With All projects selected** (h1 "Agent files · Defaults", with *Install user-wide*):
```
FILE                 DEFAULT                          CUSTOMIZED IN
docket-worker      Docket's version              Recipe App
docket-planner     Edited · 1d ago  [Reset]         —
AGENTS.md block      Docket's version              —
```
- Opening a file edits **the default**. "Customized in" links to that project's view of the file. A default edited before Docket shipped a new version says "Docket's version of … changed since you edited the default" with *Compare*. The full install log sits at the bottom.

**Opening a file** (`?file=`, under the list): the rendered text and a *Raw* toggle; *Edit* (or *Customize for …*) with a required note; *Use default* or *Reset to Docket's version*; *History* (the copy's versions, or the default's edits and Docket's versions, each with *View* and *Compare with the one before*); and *Compare with*: the default, or any earlier version. A flagged file has a warning callout with the two comparisons (what changed in the default, and the default next to the copy; B23's three-way view, relabelled). Versions are named "Docket's version v2", "Edited default v1", "Recipe App's copy v3". With a project selected and no copy, a line links to All projects to edit the default.

**Install dialog** (*Install into <project>'s repo*, or *Install user-wide* from All projects):
- **Clients** (decision 34): a checkbox each for Claude Code and Codex, each with its install-state chip (below) and "found in the repo" when Docket saw that client's markers. The ticked defaults come from `GET /api/install-state` (`defaults`): the clients the repo has markers for (`.claude/`, `CLAUDE.md`; `.codex/`, `.agents/`, `AGENTS.md`) or that are installed, else both; a state row's *Install*, *Update* or *Reinstall* opens it with only that client ticked. With none ticked, the button is disabled and "Tick at least one client." shows. A ticked client whose files changed outside Docket shows a warning with *Review changes*;
- *Repo folder*, prefilled from that project's last install that had a path (the install log has it), so it is remembered without new storage;
- the method is automatic: **push** when the push folder is ready and the folder is inside it ("Docket writes the files into this folder itself", with a *Copy a command instead* link), otherwise the command, with a line saying why and, when push isn't set up, *Set up one-click install* (to Settings → General → One-click install). A user-wide install is always a command;
- **What will be written** is a collapsed disclosure; it says that only the marked Docket section of AGENTS.md/CLAUDE.md is touched;
- the **placeholder warning** fires only when the block being installed still has a `{{…}}` (the shipped block has none; `{{KEY}}` is filled for a repo install), with *Edit block* and *Install anyway*;
- **the button** (push) says what happens to the ticked clients: *Install* (not installed), *Update* (update available), *Reinstall* (up to date, or changed outside Docket), or the verbs joined when they differ (*Install and update*), so an installed client is never offered a plain *Install*. A command install's button stays *Create the command*; one command installs every ticked client;
- **What will be written** lists each ticked client's files, and with Claude Code ticked says that a new CLAUDE.md starts with `@AGENTS.md` when the repo has an AGENTS.md (decision 34);
- the result is **one summary**: a section per client listing its files, each with what changed (push: *Created*, *Updated*, *Unchanged*) or what the command will write, with notes ("its Docket section only", "starts with @AGENTS.md…"); for a command, the PowerShell and bash commands come first, each with *Copy*, and "Run from the repo folder" when no folder was given.

**Install state** (decision 34; the card *Installed in <project>'s repo*, or *Installed user-wide*, above the install log): one row per client, with its chip and one action:
```
Claude Code   [Installed · up to date]        pushed Nov 19 10:40  C:/code/recipes   [Check] [Reinstall]
Codex         [Installed · update available]  2 files newer in Docket · …            [Update]
```
- **Installed · up to date** (ok): *Check* runs the push check inline (or shows the check command for a command install), *Reinstall* opens the dialog;
- **Installed · update available** (info): *Update* opens the dialog with that client;
- **Changed outside Docket** (warn): *Review changes* scrolls to the drift section (§6.7b-1);
- **Not installed** (neutral): *Install* opens the dialog with that client.
The state comes from `GET /api/install-state` (BUILD_SPEC §5.17b); it is refreshed by installs, agent-file edits and drift events.

**Install log** (bottom): one project's installs with a project selected, every install with All projects. Each row has the time, client, target, method and file count, *Versions sent* (linked to each file), and *Check* (push) or *Check command* (command); an edited file in a check result has *Show diff*.

**The push folder card** stays in Settings → General, under "One-click install" (`/settings#push-folder`), because it's service setup: the status (*Not set up*, *Ready*, *Not writable*), the host and container paths, *Test*, and the plain-language how-to that fills in the `compose.yaml` line, the `.env` lines and the restart command. Settings has no tabs any more.

Help anchors: `agent-files.page` (the h1), `agent-files.workflow`, `agent-files.install-log`, `agent-files.install-state` (decision 34), `settings.push-folder`, all claimed by the "Agent files" article.

### 6.7b-1 Proposals and drift (decision 30)
- **Proposals:** on the project's Agent files page, a "Proposed changes · n" section above the files. Each shows the file, the proposing agent and run, the reason, and a diff against the current version (three-way if the file changed since), with *Approve*, *Edit, then approve* and *Decline…*. Needs you shows one line: "n agent file changes proposed" → Agent files.
- **Drift:** a Problems row, "Agent files changed outside Docket · <project> · <file>" → the Agent files page's "Changed outside Docket" section: where (path, install), how it was found (scheduled check, or reported by <agent> on <item>), a diff when content is known, and *Adopt as <project>'s copy*, *Restore Docket's version* and *Keep local*.
- **Runs:** the Lead and runs section and the agent bar show "Instructions: <file> · <source> v<n>", with a ⚠ "edited locally" chip linking to the drift entry.
- **Files:** a file row shows "1 proposal" and "changed outside Docket" chips when they apply.

### 6.7d New project and onboarding review (decision 31)
- **Settings → *New project*:** a dialog with key (2–5 letters, uppercase as you type, checked for uniqueness), name, colour and *Blockers clear when*. After creating, it offers "Onboard it with an agent". That shows the line to give an agent ("Onboard this repo into Docket as project GF, using onboard_project"), the prompt name for clients that support prompts, and *Import from Jira…*.
- **B32: "What next".** The dialog opens from anywhere: the Welcome page (§6.0), the header's *+ New* menu, the project switcher's *+ New project*, and Settings → Projects. After creating, it is titled "<Name> created" and lands on **What next** (h3, with the "?"), three choices in order:
  1. **Import from Jira:** "Tickets in Jira? Import them first, so an agent enriches them instead of duplicating them." *Import from Jira…* opens the import with the new project as its target;
  2. **Onboard it with an agent:** the explanation, the line and the prompt, each with *Copy* (as in B30);
  3. **Install agent files:** "Put Docket's AGENTS.md block, skills and connection file into the repo, so agents there find Docket." *Install agent files* opens Agent files for the project (`/agent-files?project=GF`).
  The footer has *Switch to GF* (not shown for the first project, which is already switched to) and *Done*.
- **The Needs you card,** when an onboarding is ready for review: "<Project> was set up by <agent> · review". It shows the counts (created, enriched, documents, decisions, proposals) linking to filtered views, the agent's summary and questions, the proposed Workflow notes (linking to the proposal), *Install agent files*, and *Mark reviewed*.
- **Agent-created projects** show a "created by <agent> · review" chip in Settings and in the project switcher until reviewed. In Settings it links to Needs you; in the switcher it sits under the project's name.
- **B30 details:**
  - *New project* sits in the Projects card's footer, next to *Import from Jira…*. A taken key says "GF is taken. Pick another key." and *Create project* stays disabled. "Onboard it with an agent" shows both lines with *Copy* (the prompt as `/mcp__docket__onboard GF`, the Claude Code form), *Import from Jira…* (opening the import with the new project as its target), *Switch to GF* and *Done*.
  - The card sits above For you now, one per session. *Created* and *Enriched* open Work's list with only those items (`?onboarding=<id>&onboarding_change=created`), and a removable chip says why the list is short: "Onboarding by claude (GF) · created". *Documents* and *Decisions* open Settings, where the project's decisions are; the proposal link opens Agent files' proposals for the project. The footer says "n items in GF · nothing was made Ready".
  - Each card counts toward the for-you badge and the tab title. `onboarding.finished` notifies (§6.7a).
  - Agent files lists the guide as "Onboarding guide", after the AGENTS.md block, editable as the default or per project like the others.

### 6.7e Trust mode and connecting (decision 32)
- **Settings → Connections:** a "Security" line says "Local trust: anything on this computer can use Docket. Turn on protected mode to require an unlock and an agent token", with how to turn it on (the setting, then restart). *Lock this browser*, *Rotate owner key* and *Reveal token* appear only in protected mode.
- **The Install dialog** lists the connection files it will write, and says "Then open Claude Code (or Codex) in this repo and approve Docket when it asks."
- **Activity** shows owner actions made by a script as "owner (script: <user agent>)".

### 6.7c Help (`/help`, `/help/:slug`, decision 29)
- **`/help`:** a searchable list of articles, each with its title and one-line summary, grouped as Getting started, Working with agents, Recovery, Planning and Operations.
- **An article:** the rendered Markdown, with "Related" links.
- **Contextual "?":** a small `IconButton` with an accessible name of "Help: <topic>", next to headings and states that have an article (Agents → Workspaces, run states, Problems rows, Settings cards, the packet screen). It opens the article in a side panel without leaving the screen, with *Open in Help* in the panel.
- **"Problems and what to do"** (decision 37): every Problems row, the "Agents are handling" line, proposal and shared-changes cards, and the item's problem banner open this one article: each kind, who acts, and what each button does.
- **The palette** lists matching articles under "Help".

### 6.7a Desktop notifications
Spec clarification, 2026-11-14 (FR-068).
- **Opt-in:**
  - the first time the owner opens Needs you after unlocking, a one-line callout above the Agents strip says "Get a desktop notification when something needs you." with *Turn on* (requests browser permission) and *Not now* (hides it; Settings keeps the switch);
  - the callout never shows again once either is chosen.
- **What notifies:** only new *for-you* events, arriving over the live stream:
  - **packet ready:** title "Handoff ready: RCP-12 Weekly planner drag-and-drop", body "2 things to verify · about 10 min";
  - **question asked:** title "codex asks on DOC-4", body the question, truncated to 120 characters;
  - **onboarding ready for review** (decision 31; B30): title "Onboarding ready: Gameflow", body "claude set it up · 12 created, 30 enriched · review it on Needs you"; a click opens Needs you.

  Nothing else notifies: no problems, decisions or agent activity.
- **Click:** focuses the Docket tab, or opens one, and goes to the packet or the item's question.
- **No duplicates:**
  - each event notifies once per browser: event IDs are recorded in `localStorage`, and one tab per browser claims the job;
  - events that were already for-you when the page loaded never notify;
  - a burst notifies per item, not per event.
- **Tab title:** always `(N) Docket`, where N is the for-you count, or `Docket` when it's zero. This works even with notifications off.
- **Privacy:** notifications are generated in the browser from the live stream. Nothing is sent to any outside service.

### 6.8 Unlock (`/unlock`, protected mode only; decision 32)
A centred card on the page background:
- logo, h1 "Unlock Docket";
- the line "Paste the owner key. Get it with: `docker compose exec docket docket owner-key`";
- a password input, then *Unlock* (primary);
- error: "That key didn't match." inline under the input.

On success, go to the page that was requested.

### 6.9 Dialogs
- **Quick capture (+ New item):**
  - fields: Title (required, focused), Type (Story default), Project (the current scope, else the first project), Epic (optional; prefilled and fixed when opened from *+ New item in this epic*), Notes;
  - *Create* puts the item in Inbox and opens it. From an epic, you stay on the epic and get a toast "RCP-31 added to Pantry";
  - empty title: toast "Give it a title" and focus the title.
- **Command palette:** an input "Search items, IDs, labels or views…", then grouped results. The "Go to" views are Needs you, Work, Timeline (Work), Agents, and Settings: projects and connections.
  - **Sub-task keys** (B35): a key held in a work step's source (a Jira sub-task imported as a step) finds the parent item, with the step named: "STR-203 · step: Prove SVG admission… · <item title>", the key in the row's meta. Choosing it opens the item's Checklist with that step's dialog (`/items/STR-203?tab=checklist&step=<id>`). An item whose own ID or Jira key matches exactly still ranks first; step hits come next, then text matches.
- **Document viewer:** title + version + "by · when", the preview (BUILD_SPEC §5.10), and *Download*.
- **Checklist history:** each plan version, with its reason, author and time, and the steps added, removed or changed.

---

## 7. States and interactions

| Element | State | Behaviour |
|---|---|---|
| Any owner mutation | pending | Optimistic update. On `conflict`: roll back, refetch, toast "Changed by codex just now. Showing the latest." |
| Any owner mutation | success | Toast: past-tense summary + *Undo* (6 s) where undo is supported (BUILD_SPEC §5.11) |
| Data from agents | arrives | SSE invalidates the affected queries. Lists update in place without moving focus. New For-you rows get a 1 s `--warn-soft` highlight (skipped under reduced motion). The agent bar updates in place too, and announces only a change of run state, politely. |
| Stream | disconnected > 10 s | A thin banner at the top of the view: "Reconnecting to the service…". After 60 s: "Service unreachable. Changes you make won't be saved." All write actions are disabled. |
| Buttons | hover / active / disabled | Hover `--panel-2` (primary: 8% darker); active 1px down; disabled 55% opacity with `cursor:not-allowed` |
| Section header | click / Enter / Space | Toggle collapse; the chevron rotates −90° when collapsed |
| Board card | click | Open the item (or the packet, for Review with a packet ready) |
| Map node | hover / focus | Highlight links, dim the others |
| Map canvas | drag on background | Pan. Clicks on nodes still open them; ignore drags under 4px |
| Answer box | Enter | New line. Ctrl+Enter sends |
| Add rows | Enter | Add (same as the button) |
| Palette | ↑↓ / Enter / Esc | Move / open / close |
| Global | `Ctrl K`, `/` | Open the palette (unless typing in a field) |

**Focus is kept across re-renders.** After any update, the same control (by stable key) keeps focus and its caret position.

---

## 8. Motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Toast | show/hide | fade + 8px rise | 200 ms | ease-out |
| Section chevron | toggle | rotate | 120 ms | ease |
| Live run dot | always | soft pulse (scale 1 → 1.35, opacity) | 1.6 s loop | ease-in-out |
| New For-you row | arrives | background highlight fade | 1 s | ease-out |
| Map zoom | − / + / Fit | scale transform | 150 ms | ease-out |

All of these are off under `prefers-reduced-motion: reduce`.

---

## 9. Screens not prototyped

### 9.1 Burn-down and forecast (Work → Timeline)
- **Burn-down card**, above the timeline grid, scoped by the same Epic and Label filters, otherwise the project scope. A `Section` that **starts collapsed** to its one-line summary and opens on click; its state is remembered (§2):
  - h3 "Remaining effort", with the summary "n pts open · n not estimated · last 4 weeks · Forecast P50 Nov 24 – P85 Dec 3" (or "· no forecast yet");
  - **Chart:** 180px tall, full width.
    - X is days (last 28, plus forecast space to the P85 date); Y is points, starting at 0.
    - A `--violet` 2px step line shows remaining effort.
    - Scope additions are small `--warn` up-ticks with `title` "+3 pts: RCP-31 added".
    - A dashed `--ink-3` "Today" line.
    - When a forecast exists: a shaded `--info-soft` band from today to the P50 and P85 dates, with labels "P50 Nov 24" and "P85 Dec 3".
  - **Under the chart, one line:** "Forecast: P50 Nov 24 – P85 Dec 3 · 6.2 pts/wk over the last 4 weeks · n=11 · excludes 2 unestimated items". With no forecast: "No forecast yet: needs 8 completed items with effort (have 2)."
  - **Accessibility:** an sr-only summary sentence, and a *Show as table* toggle (date, remaining, change).
  - **Empty** (nothing estimated in scope): "No estimated work in this view. Agents set effort with update_item."
- **Days and time zone:** the chart's "Today" and the Timeline's red Now line both use the server's time zone (config `TZ`), which the Timeline response sends as `time_zone`, never the browser's, so they always agree on the day.
- **Forecast lane** at the bottom of the Timeline, per project in scope:
  - with a forecast: a hatched bar from P50 to P85 labelled "P50 Nov 24 – P85 Dec 3";
  - without one: the "No forecast yet…" line.

### 9.2 Jira import (Settings → Projects → *Import from Jira…*)
A dialog with three steps. A step indicator "1 Connect · 2 Review · 3 Import" sits at the top, and *Back* is available on step 2. Since B32 it also opens from the Welcome page (§6.0) and from New project's "What next" (§6.7d).

1. **Connect:**
   - fields: Jira site (`https://yoursite.atlassian.net`), Email, API token (password field, with "Used for this import only. Not saved."), Jira project key, and Import into (New project: key + name | Existing empty project);
   - **under the site (B32):** "Just the site: https://<yoursite>.atlassian.net, with no /jira and no path." Leaving the field normalises it: `https://` added if missing; paths (`/jira/…`, `/browse/…`), queries and trailing slashes dropped. The server normalises it again;
   - **under the token (B32):** a **"Which token?"** disclosure: *Use a personal API token* (link to id.atlassian.com → Security → API tokens, *Create API token*; it must belong to the email above); *Tokens with scopes work too* (give them `read:jira-work` and `read:jira-user`; Docket reaches Jira through `api.atlassian.com` for them); *Organization API keys don't work* (the keys from admin.atlassian.com are for Atlassian's admin APIs only and can't read Jira projects or work items). The link is underlined and opens in a new tab;
   - *Run dry run* (primary);
   - **errors inline (B32),** one `role="alert"` callout, the token field cleared:
     - "Site not found: check the URL (https://yoursite.atlassian.net).";
     - "That looks like an organization API key from admin.atlassian.com. Those can't read Jira. Create a personal API token at id.atlassian.com instead.";
     - "Wrong email or API token. The token must belong to <email>'s Atlassian account.";
     - "Signed in, but this account can't browse that project (or the token's scopes don't include reading Jira work items)." For a scoped token it adds "A scoped token needs the read:jira-work and read:jira-user scopes.";
     - "Project ABC not found or not visible to this account.";
     - (BUILD_SPEC §9 "Signing in" has the probe order that picks one);
   - while it runs: a progress line, "Reading 140 of 512 issues…", plus *Cancel*.
2. **Review report (B32 wording):**
   - **a legend** at the top: **Imported as is** (comes across unchanged), **Imported with changes** (what changes, and what isn't kept, is listed by reason below), **Skipped** (not imported, with the reason). The word "lossy" is never shown;
   - **summary tiles:** n issues, n as is, n with changes, n skipped, attachments size;
   - **the summary line:** "Imports 328 items and 57 checklist steps. Sub-tasks become checklist steps on their parent." (no steps part when there are none);
   - **Imported with changes,** grouped by reason, one row each: the count and what happens in bold ("42 sub-tasks → checklist steps on their parent"), opening to the issues (key, title, that issue's details), and under it what is kept and not ("Kept: title, done or not done, description and dates (in the step’s details), comments (in a note on the parent). Not kept: attachments, labels and links on sub-tasks (each one lists what it had)."; B34). The reasons and their lines come from BUILD_SPEC §9's mapping table. Then one line: fields Docket doesn't have (assignee, reporter, sprint, fix versions, components, other custom fields) aren't imported as fields, a sub-task's assignee is kept in its step's details, and *By field* counts them;
   - **Skipped,** grouped the same way (for example "1 sub-task whose parent isn't in this import");
   - **mapping table** (Jira → Docket, count, with-changes count; sub-task rows read "Checklist step on the parent"), and *By field* (mapped, skipped, with changes);
   - **Cycles found** (if any): "Imported as is. They'll show under Problems.";
   - **Fields used:** "Story points → customfield_10016", "Start date → not found";
   - *Download report (JSON)*;
   - *Import n items and m checklist steps* (primary; "Import n items" when there are no steps) and *Cancel*.
3. **Import:** a progress line ("Importing… / Downloading attachments 12 of 40"), then a result: "Imported 498 items into ABC. 3 attachments failed (listed). The report is saved in the project's documents." *Open project* switches the scope and goes to Work.

Owner-only. The token never appears again after step 1.

---

## 10. Content and edge cases

- **Long titles:** two lines on cards and map nodes, then an ellipsis; one line in tabs (200px), rows and breadcrumbs. The full title goes in `title`.
- **Long IDs and SHAs:** monospace, no wrapping.
- **Counts:** show "0" in a header (e.g. "Problems · 0") but hide zero-count filters (Archived, in Work's Filters menu) and zero tab counts.
- **Large boards** (70+ items): columns scroll vertically inside the view; no virtualization needed below 500 items. *Archive all* keeps Done short.
- **Many open tabs:** at most 8, with the oldest inactive one closed automatically.
- **Times:**
  - relative under 24 h ("40s", "47m", "16h");
  - "Nov 5" beyond that;
  - "Nov 6 10:42" in packet and audit contexts;
  - always local time;
  - the full ISO time goes in `title`.
- **Missing data:** no lead → nothing (not "Unclaimed"), except the agent bar's quiet "No agent on this" on an In progress item; no dates → "not set"; no outcome → "No outcome written yet."; no documents → "No documents yet. Planning docs (PRD, UX, TDD) and handoff packets appear here."
- **Imported items:** an "Imported from Jira" chip and the Jira key in search results.
- **Service errors:** API errors appear as the inline callout from §6. A validation error from a form shows next to the field.

---

## 11. Accessibility

Target: WCAG 2.1 AA, in both themes.

- **Contrast:** text ≥ 4.5:1, control borders and focus ≥ 3:1 (the tokens are pre-checked). Type squares: glyph ≥ 5.3:1, square against the page ≥ 4.8:1.
- **Semantics:**
  - cards and IDs are links (`<a>`), and actions are `<button>`;
  - map nodes are buttons;
  - section headers are buttons with `aria-expanded`;
  - view tabs follow the ARIA tabs pattern (`role=tablist/tab/tabpanel`, arrow keys, Home/End);
  - the item's agent bar is a region labelled "Lead agent"; the Needs you Agents strip is a `nav` labelled "Agents" whose counts are links;
  - verdicts are radio groups (`role=radiogroup`) labelled "Decision for item n";
  - the project menu uses `menuitemradio`.
- **Dialogs:** `role=dialog`, `aria-modal`, labelled by the title. Focus is trapped, Esc closes, and focus returns to the trigger. Destructive dialogs focus Cancel first.
- **Live regions:** toasts use `role=status` (polite); the reconnecting banner uses `role=alert`.
- **Never colour alone:**
  - run states, review states, provenance and status always carry text;
  - attention dots have sr-only text ("packet ready", "stale run", "in a dependency cycle");
  - the priority bars have a title and sr text.
- **Labels:** every icon button has an `aria-label`. Inputs have visible or sr-only labels (for example "Note for the agent", "Your answer to codex").
- **Keyboard:** every action is reachable by keyboard. The map canvas is focusable and pans with the arrow keys. Skip-to-content is the first focusable element.
- **Reduced motion:** see §8.
- **Testing:** axe (via Playwright) finds no serious or critical violations on every screen in both themes; screen reader spot checks with NVDA on the packet decision flow.

---

## 12. Copy rules

- **Sentence case** everywhere; buttons are verbs that name the result ("Approve and close ticket", not "Submit").
- **Address the owner as "you"** and agents by their name ("codex reads it on its next query").
- **Don't explain the system in page chrome.** If a rule needs saying, say it at the point of action, in one sentence.
- **Use the terms:**

  | Use | Not |
  |---|---|
  | ticket or item | issue |
  | decision (a decision record) | ADR, memory |
  | your review (verdicts on a packet) | decision, in review contexts |
  | human review | owner gate |
  | handoff packet | review doc |
  | lead claim | assignment |
  | archive | acknowledge, hide |
