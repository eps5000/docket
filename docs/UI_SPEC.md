# Task Lite: V1 UI spec (handoff)

Status: ready to build, 2026-11-07. This is the screen-by-screen contract for the web UI. Read it together with [BUILD_SPEC.md](BUILD_SPEC.md), which covers data, rules and API.

**References:**
- **Visual reference:** [design/prototype.html](../design/prototype.html) (revision 22). Its CSS is the source for every token and measurement here. Copy its token block into `web/src/styles/tokens.css` unchanged.
- **Where documents disagree:** this spec wins over the prototype. [UI_DESIGN.md](UI_DESIGN.md) explains *why*; read it when you have to make a judgement call.

---

## 1. Overview

**Who and why.** One owner, on one machine, supervising AI agents several times a day. Agents coordinate through Task Lite; this UI is how the owner sees and steers that coordination. The UI answers four questions, in this order:
1. What needs me?
2. What are agents doing?
3. Where is the work?
4. What happened?

Agents do almost all the writing. The owner verifies, decides, nudges and archives.

**Principles to apply when this spec is silent:**
1. **"For you" first.** Only Needs you has a red badge.
2. **Never blur provenance.** Owner approval, agent claims, observed child runs, relayed logs and CI look different. Nothing but an owner decision looks like approval.
3. **Unknown is not done.** Stale never becomes a check mark.
4. **One job per view.** Tickets and epics have four tabs: Details, Checklist, Dependencies (Map on epics) and Activity. Don't mix their content.
5. **Less text.** No explanatory subtitles under page titles. Rules show up where they apply (button labels, footnotes). Prefer a count or a dot over a sentence.
6. **Reversible or confirmed.** Owner mutations get an Undo toast. Destructive ones get a confirmation dialog with focus on Cancel.

---

## 2. Shell and layout

```
┌──────────────┬────────────────────────────────────────────────────────────────┐
│ Sidebar 220  │ Header: breadcrumb · [+ New] · [Search… Ctrl K] · [theme]       │ 9px 18px padding
│  Logo        ├────────────────────────────────────────────────────────────────┤
│  Project ▾   │ Open-item tab strip (only when ≥1 item open)                    │
│  Needs you ③ ├────────────────────────────────────────────────────────────────┤
│  Work        │ View: padding 18px 20px 28px                                    │
│  Agents ⑤    │                                                                 │
│  SERVICE-WIDE│                                                                 │
│  Settings    │                                                                 │
│  ● Healthy·3 │                                                                 │
└──────────────┴────────────────────────────────────────────────────────────────┘
```

- **Grid:** `220px minmax(0,1fr)`. Every grid child needs `min-width:0`. (Without it, wide maps and tables push the layout wider than the window.)
- **Sidebar:**
  - **Project switcher** (*All projects* or one project): a menu of radio items, each with its for-you count. It scopes every page except Settings.
  - **Nav items:** Needs you (red badge = for-you count), Work, Agents (gray badge = active runs), then the "Service-wide" divider, Settings and **Help** (decision 29).
  - **Health line** at the bottom: "Healthy · N clients", linking to Settings. When unhealthy, it shows "Service problem" in `--bad` with the same link.
- **Header:**
  - **Breadcrumb:**
    - `Scope / Page`;
    - tickets: `Project / ◆ Epic / ID Title`, where the epic is a link back to the tab you left;
    - packet: `Needs you / Human review · ID`;
    - Settings: `Settings` plus a "Service-wide" pill.
  - **+ New** (primary), **Search** (opens the palette; `Ctrl K` or `/`), and a theme toggle cycling System → Light → Dark.
- **Open-item tabs:** every ticket or epic you open becomes a tab.
  - Each tab is a fixed 200px with type icon, ID and title, and an × to close.
  - At most 8 tabs; when a 9th opens, the oldest inactive one closes.
  - Each tab remembers its own view tab.
  - Closing the active tab moves to its neighbour, or back to the page you came from.
  - The strip scrolls sideways and is hidden when empty.
- **Breakpoint at 1180px and below:**
  - the sidebar becomes a 64px icon rail (labels move to `title` and `aria-label`);
  - Needs you stacks its top band to one column, with the lower cards 2 across;
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
| Everything else (filters, layout) | URL query | Shareable, Back works |

**Routes:**
- `/` Needs you
- `/work?layout=board|list|map|timeline&epic=&label=&filter=`
- `/items/:id?tab=details|checklist|deps|map|activity`
- `/review/:id?round=`
- `/labels/:project/:name`
- `/agents?state=` (Active now filtered to one run state, from the Needs you strip) and `/agents#workspaces`
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
| `--ok` / `--ok-soft` | #237032 / #e6f4ea | #5bd06f / #14281a | Done, owner approval |
| `--warn` / `--warn-soft` | #9a4705 / #fdf1e2 | #f0a020 / #2d2210 | For you, Review, packet ready, attention dot |
| `--bad` / `--bad-soft` | #c22b2b / #fdecec | #ff7b7b / #351818 | Blocked, failed, cycle, conflict |
| `--info` / `--info-soft` | #1864ab / #e7f1fb | #5cb3f8 / #132536 | Ready, callouts, deferred |
| `--violet` / `--violet-soft` | #6741d9 / #f0ebff | #a990ff / #241c3e | In progress, agent work |
| `--teal` / `--teal-soft` | #0b7285 / #e3f6f8 | #3bc9db / #10292d | Planning |
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
| `RunState` | live, reported, stale, parked, needs input, failed, finished, interrupted | `state, age?` | Icon shape + label + `title` holding the one-line meaning (§5). The live dot pulses, except under reduced motion. Used alone only where a state is counted (the Needs you strip). |
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
| `EpicCard` | — | `epic` | 4px `--t-epic` left edge; title + ID; mini progress bar (done green, active violet); "n/N done · Status · N for you". |
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

| Status | Colour |
|---|---|
| Inbox | gray |
| Planning | teal |
| Ready | blue |
| In progress | violet |
| Review | amber |
| Done | green |
| Canceled | gray, with strikethrough title |

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
| interrupted | ring "–" | Stopped without finishing (lease expired, released, or service restart) |

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

### 6.1 Needs you (`/`)
Fits one 1440×900 screen without scrolling at sample volume. Contents, top to bottom:

1. **h1 "Needs you".** No subtitle and no scope pill.
2. **Agents strip** (one line, a `nav` labelled "Agents"): counts per run state that has any (live, reported, needs input, parked, stale, failed). **Each count is a link** to Agents → Active now filtered to that state (`/agents?state=parked`). Then "n workspaces at risk", in `--warn`, when n > 0, linking to Agents → Workspaces (`/agents#workspaces`). Then *All runs →* (Agents). Empty: "No active runs".
3. **Top band** (`1.55fr | 1fr`):
   - **For you now · N:**
     - **packet rows:** box icon; title + ID; "Round n packet · k to verify · about 10 min", plus a red "out of date: code changed after it was written" when stale; *Open packet* (primary);
     - **question rows:** ? icon; "codex asks: “…”" on one truncated line; *Answer* opens an inline reply (textarea, *Send answer*, *Cancel*, "codex reads it on its next query");
     - rows have an amber tint, and clicking a row opens the item;
     - empty: "Nothing to verify. Agents will hand off when work is built."
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
     | Unpushed work may be lost ("1 commit not pushed · uncommitted changes · C:/work/rcp-25 · run ended (lease expired)") | *Handled* · *Open* → Activity |
     | Parked for 24 h ("Parked since Nov 14 · waiting on the coordinator · keeps its claim") | *Open* → Activity (Release lead claim is also on the agent bar) |
     | Ready to resume, unattended ("Ready to resume: RCP-11 is done · parked 40m") | *Open* → Activity |
     | Extra backup copy failed | *Open* → Settings |

     Empty: "No stale or failed runs, cycles or date conflicts."
4. **Lower row** (two cards, each showing the top 3 with *View all N →*):
   - **Deferred, not verified · N:** item + review text + "Test ticket RCP-29 · inbox" or "No follow-up ticket" with *Create test ticket*. *View all* goes to Work with the Deferred review filter. Empty: "Nothing deferred."
   - **Your Planning queue · N:** item + type and epic, with *Move to Ready*. *View all* goes to Work with the In planning filter. Empty: "Nothing in Planning."

**Rows are one or two lines**; truncate with an ellipsis (Problems: whole facts, above) and put the full text in `title`. Reviews that are coming up do **not** appear here (they're the *Human review later* filter on Work).

### 6.2 Work (`/work`)
- **Header row:** h1 "Work", and on the right a segmented control: Board | List | Map | Timeline.
- **Filter row** (Board, List and Map; Timeline uses the same scope):
  - Epic select, Label select;
  - saved-filter chips with counts: All, Blocked, For you, Human review later, Deferred review, Live run, and Archived (shown only once something is archived, or while active). *In planning* and *Ready to start* aren't chips but can still be applied from the URL; a filter applied that way shows as an active chip;
  - each chip's `title` is "Agent query: <query>" (BUILD_SPEC §13).
- **Epics row:** "EPICS · N" and the type legend (Epic, Story, Task, Bug). One `EpicCard` per non-archived epic in scope; clicking one opens the epic. Shown on every layout except Timeline.
- **A label filter** shows a callout: "Filtered by #label. Open the label page for its brief, progress by epic and bulk actions."

#### 6.2.1 Board
- **Columns:** six, `repeat(6, minmax(176px,1fr))`, scrolling sideways when needed: Inbox · Planning ("Yours") · Ready · In progress · Review ("Your human review") · Done. Each header shows its name and count.
- **Ready** splits into *Startable · n*, then *Waiting on blockers · n*. Waiting items show as red ID chips. "Waiting on blockers · n · Show" is **one button** across the column (at least 32px tall, `aria-expanded`, a chevron), which expands them to cards.
- **Run line:** each claimed card ends with the lead's `RunLine` (§5): "parked · waiting on the coordinator · claude · orca-w4", in the parked style.
- **Review cards** with a ready packet open the packet screen directly (`title` "Open the handoff packet"). Other cards open the item.
- **Done** keeps every done item until it's archived (no time cutoff):
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
- **Packet ready:** amber banner, "Handoff packet ready (round n). k things to verify, about 10 min. The ticket can't close until you approve.", with *Open packet*.
- **Open question:** the question, an answer textarea and *Send answer*. After answering: "You answered: “…”. Waiting for codex to read it."
- **From review:** "Created from your human review of RCP-12 (…)".
- **Out of scope:** "RCP-21 belongs to Recipe App, outside the project you're viewing.", with *Switch to Recipe App*.

**View tabs** (`ViewTabs`, §4). One column of `Section`s per tab.

| Tab | Ticket | Epic | Label extras |
|---|---|---|---|
| **Details** (default) | Outcome (summary "n acceptance criteria"); Decisions (summary "n in scope · n by agents"; hidden when there are none); Documents (summary count); Dates and effort (summary "Nov 4 → Nov 11" or "not set") | Brief and documents; Decisions (this epic's own, plus a link "n project decisions"); Tickets in this epic (summary "n/N done · n ready but blocked · n for you"), grouped by status. Each row: type icon, ID, title, then the same pieces a Board card uses: the `BlockedChip`, a `ForYouChip`, and the lead's `RunLine`. Archived tickets fold into "+ N archived · Show". | — |
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

#### 6.3.2 Lead and runs
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
  - a bar split by status in order: done, review, progress, ready, planning, inbox;
  - status counts with swatches;
  - "n ready but blocked" in red;
  - "n ready to start · working on wave x of y".
- **Columns are waves:**
  - "Wave 1 / nothing blocks these";
  - "Wave n / after wave n−1";
  - before them, a dashed "Outside this epic / blocks work here" column (or "Outside this view" / "Without this label");
  - cycle members get a "Cycle" column;
  - wave index = the longest `blocks` path from a root within the scope set.
- **Card** (200px wide):
  - type icon · ID (+ "other epic ↗" or project) · title (2 lines) · "Status · run state" or "· after RCP-12" on Planning items;
  - left edge in the status colour;
  - done = green fill with ✓;
  - blocked Ready = red border and "blocked";
  - human review person icon at the top right (§5);
  - each card is a focusable button that opens the item.
- **Spacing:** columns 200px with a 76px gap (for arrows); 16px between cards; the canvas padding is 18px 22px; maximum height 540px; dotted background.
- **Arrows:**
  - SVG cubic curves from the right edge of a blocker to the left edge of the blocked item, with arrowheads;
  - solid `--ink-3` = still blocks; dashed `--ok` = cleared (blocker done);
  - redraw on resize (80 ms debounce) and on zoom;
  - hover or focus on a card highlights its links and dims the rest.
- **Pan and zoom:**
  - drag the background (grab cursor), scroll, or use arrow keys while the canvas is focused;
  - edge fades plus clickable *More →*, *← More*, *More ↓* pills when content overflows;
  - "Drag to pan" hint text only when overflowing;
  - zoom controls − / percentage / + / **Fit**: steps 50, 67, 80, 100, 125%, default 100%; Fit scales to show everything, down to 40% at the smallest.
- **Key** (one line under the map): "Arrow = blocks · dashed green = cleared · hover to trace", plus the two person icons with "packet ready for you" and "your review later".

#### 6.3.5 Decisions
Decision records (BUILD_SPEC §5.14) appear where they apply:
- **ticket Details:** everything in scope (project, epic, labels, this item);
- **epic Details:** the epic's own records;
- **label page:** the label's own records;
- **Settings → project:** project-wide records.

**Each section:**
- **Header:** "Decisions", with the summary "n in scope · n by agents". *+ Record a decision* sits in the section header.
- **`DecisionRow`:**
  - the title in bold;
  - the decision text (2 lines, then *More*), and the rationale under *Why* (collapsed);
  - a scope chip ("Project", "◆ Epic name", "#label", "This item"; shown on ticket Details, where records are inherited);
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

Agent decisions never appear in Needs you. They show here, and in the item's Activity ("claude recorded a decision: …").

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
  - **Needs changes** reveals "What needs to change (required)", a textarea, and "Send it back as" [Checklist item on this ticket | New bug ticket].
  - **Defer** reveals "Why defer, and what's still needed (optional)" and "Follow-up" [Create a test ticket in Inbox | No ticket: agent follows the project workflow], plus the note "Deferring clears the gate so work can continue. The item is recorded as not verified, never as approved."
  - **Past rounds** show the decision provenance badge, the note, and "→ checklist item", "→ bug RCP-30" or "→ test ticket RCP-29".
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
h1 "Agents", then three collapsible `Section`s (B20), in this order:

1. **Active now** (summary: the count). Runs in the order **needs input, failed, stale, parked, live, reported**, newest signal first within a state.
   - `?state=parked` (the Needs you strip's links) shows that state only: the summary reads "1 parked" and the header has *Show all*.
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
- **Columns:** State chip (*In use*, *Parked*, *At risk* in `--warn`, *Safe to prune* in `--ok`, *Unknown*), Path (with *Copy*), Branch, Item, Last activity, Pushed (`✓`, or `n behind`), Resources (unreleased count).
- **Sort order:** At risk, In use, Parked, Unknown, Safe to prune.
- **A filter chip** "Hide safe to prune", in the section header, is on by default.
- **Empty:** "No workspaces recorded yet. Agents report theirs when they claim work."

### 6.7 Settings (`/settings`)
h1 "Settings".

- **h2 "Projects":** one row per project:
  - colour swatch, name (+ "Current" chip), "KEY · n epics · n items · n documents · n for you";
  - label tags;
  - a mini status bar with "n done · n active · n review · n planning";
  - "Blockers clear when": a select with **Done** (default), **PR merged** and **Verified by you**. Its `title` reads: "When a blocking item counts as finished for its dependents. Agents can override it per link. PR merged is reported by the agent." Changing it shows the toast "Blocker rule for Recipe App set to PR merged. 2 items are blocked again." with Undo;
  - "n decisions", a link that opens a dialog with the project-wide Decisions section (§6.3.5);
  - *Switch to*, and *Delete…* (danger text);
  - *Import from Jira…* at the bottom (§9.2).
- **Delete dialog:** titled "Delete Sample · Recipe App?". Body: "This permanently removes **N work items**, their checklists, runs and history, and **N local documents** including handoff packets. Agents will get “not found” for these IDs." Then a warning callout: "Backups keep a copy until their 14-day retention ends. Removing the Docker container alone doesn't delete data." Then an input "Type RCP to confirm" and *Cancel* (focused) / *Delete project* (enabled only when the input matches).
- **h2 "Connections":**
  - **Client compatibility table** (Client, Transport, Last seen, Status chip Verified / Not verified, Results: Text only / Structured per MCP_SPEC §3 Results, Notes), with "Smoke test: claim, plan, log, read back" in the header. Surfaces that are off by default ("Agent in another container") are a **footnote under the table**, not a row: "**Agent in another container** (Docker network): not configured. Off by default. Needs an explicit network path (O02).";
  - **Client setup card:** Codex | Claude Code segmented control, a code block, and *Copy*. The token placeholder is `$TASKLITE_TOKEN`; show the token itself only behind *Reveal token*, which needs a click and auto-hides after 30 s;
  - **Endpoint card:** MCP URL, Web UI URL, Bind "Loopback only", Auth "Bearer token", Origins;
  - **Service health card:** Database and Documents with ready chips and sizes, Volume, Backups: one row per location, "In the data volume · Nov 6 03:00 · kept 14 days", and, if configured, "Extra copy: /backups-extra · Nov 6 03:01". When the extra location isn't configured, a muted line explains how to add it ("Mount a host folder and set TASKLITE_BACKUP_EXTRA_DIR; see the README"), Restarted (with "0 runs were active…"), *Download diagnostic log* (the last 7 days of agent calls, without contents), and *Lock this browser* / *Rotate owner key*.
  - **This browser card:** "Desktop notifications" with a switch, a status line ("On", "Off", "Blocked by the browser. Allow notifications for 127.0.0.1:7420 in your browser settings.") and *Send a test notification*. Theme is also set here.

### 6.7b Agent setup (`/settings/agent-setup`, decision 29)
A tab on Settings, plus a section on each project's Settings row (*Agent files & workflow*).
- **File list:** one row per agent file (each skill, and the AGENTS.md block), with its effective layer chip ("Bundled", "Your edit", "Project override"), the version, and a "Bundled version updated" chip when it applies.
- **File view:**
  - the rendered text and a *Raw* toggle;
  - a layer switcher (Bundled · Service-wide · this project);
  - *Edit* (the inline editor, with a required note), *Revert to …*, *History* (versions with author and note);
  - *Diff* against any other version or layer.
- **Project section:**
  - **Workflow notes:** a Markdown editor, versioned, with a line saying "Agents get this in get_context";
  - **Effective set:** each file, with which layer it comes from and links to its view.
- **Install dialog:**
  - choose the client (Claude Code or Codex), then the target (*This project's repo*, with a path field, or *User-wide*);
  - with push configured: *Install* writes the files and shows what changed;
  - otherwise, or always as an alternative: the PowerShell and bash commands, each with *Copy*, and a note "Run from the repo folder" for repo installs;
  - the dialog says plainly what will be written, and that only the marked Task Lite section of AGENTS.md/CLAUDE.md is touched.
- **Install log:** each install with time, client, target, method and file count. *Check* (with push), or the check command (without), shows "Up to date" or a per-file diff marked "edited locally", "missing" or "extra".
- **Push folder card:** whether it's configured, the host and container paths, a *Test* button, and a plain-language how-to ("Mount your code folder into Task Lite so it can install files for you").

### 6.7c Help (`/help`, `/help/:slug`, decision 29)
- **`/help`:** a searchable list of articles, each with its title and one-line summary, grouped as Getting started, Working with agents, Recovery, Planning and Operations.
- **An article:** the rendered Markdown, with "Related" links.
- **Contextual "?":** a small `IconButton` with an accessible name of "Help: <topic>", next to headings and states that have an article (Agents → Workspaces, run states, Problems rows, Settings cards, the packet screen). It opens the article in a side panel without leaving the screen, with *Open in Help* in the panel.
- **The palette** lists matching articles under "Help".

### 6.7a Desktop notifications
Spec clarification, 2026-11-14 (FR-068).
- **Opt-in:**
  - the first time the owner opens Needs you after unlocking, a one-line callout above the Agents strip says "Get a desktop notification when something needs you." with *Turn on* (requests browser permission) and *Not now* (hides it; Settings keeps the switch);
  - the callout never shows again once either is chosen.
- **What notifies:** only new *for-you* events, arriving over the live stream:
  - **packet ready:** title "Handoff ready: RCP-12 Weekly planner drag-and-drop", body "2 things to verify · about 10 min";
  - **question asked:** title "codex asks on DOC-4", body the question, truncated to 120 characters.

  Nothing else notifies: no problems, decisions or agent activity.
- **Click:** focuses the Task Lite tab, or opens one, and goes to the packet or the item's question.
- **No duplicates:**
  - each event notifies once per browser: event IDs are recorded in `localStorage`, and one tab per browser claims the job;
  - events that were already for-you when the page loaded never notify;
  - a burst notifies per item, not per event.
- **Tab title:** always `(N) Task Lite`, where N is the for-you count, or `Task Lite` when it's zero. This works even with notifications off.
- **Privacy:** notifications are generated in the browser from the live stream. Nothing is sent to any outside service.

### 6.8 Unlock (`/unlock`)
A centred card on the page background:
- logo, h1 "Unlock Task Lite";
- the line "Paste the owner key. Get it with: `docker compose exec tasklite tasklite owner-key`";
- a password input, then *Unlock* (primary);
- error: "That key didn't match." inline under the input.

On success, go to the page that was requested.

### 6.9 Dialogs
- **Quick capture (+ New):**
  - fields: Title (required, focused), Type (Story default), Project (the current scope, else the first project), Epic (optional; prefilled and fixed when opened from *+ New item in this epic*), Notes;
  - *Create* puts the item in Inbox and opens it. From an epic, you stay on the epic and get a toast "RCP-31 added to Pantry";
  - empty title: toast "Give it a title" and focus the title.
- **Command palette:** an input "Search items, IDs, labels or views…", then grouped results. The "Go to" views are Needs you, Work, Timeline (Work), Agents, and Settings: projects and connections.
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
A dialog with three steps. A step indicator "1 Connect · 2 Review · 3 Import" sits at the top, and *Back* is available on step 2.

1. **Connect:**
   - fields: Jira site (`https://yoursite.atlassian.net`), Email, API token (password field, with "Used for this import only. Not saved."), Jira project key, and Import into (New project: key + name | Existing empty project);
   - *Run dry run* (primary);
   - errors inline: "Couldn't sign in to Jira. Check the email and API token.", "Project ABC not found or not visible to this account.";
   - while it runs: a progress line, "Reading 140 of 512 issues…", plus *Cancel*.
2. **Review report:**
   - **summary tiles:** n issues, n would import, n skipped, n lossy, attachments size;
   - **mapping table** (Jira → Task Lite, count, lossy count);
   - an expandable **Lossy items** list (key, title, reason);
   - **Cycles found** (if any): "Imported as is. They'll show under Problems.";
   - **Fields used:** "Story points → customfield_10016", "Start date → not found";
   - *Download report (JSON)*;
   - *Import n items* (primary) and *Cancel*.
3. **Import:** a progress line ("Importing… / Downloading attachments 12 of 40"), then a result: "Imported 498 items into ABC. 3 attachments failed (listed). The report is saved in the project's documents." *Open project* switches the scope and goes to Work.

Owner-only. The token never appears again after step 1.

---

## 10. Content and edge cases

- **Long titles:** two lines on cards and map nodes, then an ellipsis; one line in tabs (200px), rows and breadcrumbs. The full title goes in `title`.
- **Long IDs and SHAs:** monospace, no wrapping.
- **Counts:** show "0" in a header (e.g. "Problems · 0") but hide zero-count *filter chips* (Archived) and zero tab counts.
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
