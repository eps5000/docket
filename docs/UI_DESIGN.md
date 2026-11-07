# UI/UX design — MVP V1 human interface

Status: design proposal, revision 3, 2026-11-06. Inputs: [requirements draft](REQUIREMENTS_DRAFT.md), [Jira research](JIRA_RESEARCH.md).

Clickable prototype: [`design/prototype.html`](../design/prototype.html). It is a single file with no build step and no network requests, and all data is disposable sample work (O09). Open it directly in a browser.

## Who the UI is for

One owner supervises several AI agents, and the agents do most of the writing through MCP. So the browser UI is mainly for **oversight and decisions**, not data entry. It answers two questions (H09):

1. **What needs me next?**
2. **What are the agents doing right now, and can I believe it?**

The second question shapes the visual language. Trust in the product comes from never letting an agent's claim look like a fact, or a merge look like an approval.

## Design principles

| # | Principle | How it shows up |
| --- | --- | --- |
| 1 | **Decisions first.** | The home screen is a queue. Decisions agents are blocked on appear first, highlighted, with the primary action. The sidebar badge counts *only* decisions owed. |
| 2 | **Never blur provenance.** | Each source has its own border style and icon. Only the solid green person badge means a human decided (H06, A17). |
| 3 | **Unknown is not done.** | Run state is shown as icon shape *plus* a text label: live, reported, stale, needs input, failed, finished, interrupted. Stale never turns into a check mark (H05, A06). |
| 4 | **Blocked is derived, not a column.** | It is computed from unresolved `blocks` links only. The Ready column splits into *Startable* and *Waiting on blockers*. |
| 5 | **Decisions bind to versions.** | Every decision names the version and hash it applies to. A new revision shows "Pending" again (H04). |
| 6 | **Entered ≠ forecast.** | Planned dates are labelled "set by X". When there isn't enough history, the forecast lane shows *no bar*, just what's missing (H08, H14). |
| 7 | **Colour means state, never priority.** | Priority uses neutral signal bars. Red, amber, green and violet are reserved for blocked/failed, owner-needed/review, done/approved, and agent work. |
| 8 | **Every owner action is reversible or confirmed.** | Small edits show an *Undo* toast. Destructive actions explain their scope and need confirmation. |
| 9 | **Project scope is always visible.** | One project switcher controls every work page. Each page title carries a scope pill ("Recipe App" or "All projects"), and service-wide pages are labelled as such. |
| 10 | **Agents build only what's been planned.** | Work passes through Planning (PRD, UX, TDD) before Ready. Agents can write planning docs, but can only claim the build once the item is Ready. |

## Information architecture

```
Sidebar (collapses to an icon rail below 1180px)      Work item page
┌ Project ▾  [All projects | Recipe App | Docs Site]  ├─ Header: ID · type · parent · status · blocked · priority (editable) · policy chip
│  ── scoped to the chosen project ──                 ├─ Banner (only when the owner must act): gate / review / question
├─ Needs you      badge = decisions owed              ├─ Definition of ready card (Planning items only)
├─ Work           Board | List, saved filters         ├─ Outcome + acceptance (evidence per criterion)
├─ Reviews        badge = pending reviews             ├─ Tabs: Progress · Evidence · Activity — default depends on status
├─ Dependencies   other-project links shown dashed    └─ Rail: Lead & runs · Dependencies · Dates & effort
├─ Timeline
├─ Agents         badge = active runs
│  ── service-wide ──
├─ Projects       pick a scope; per-project settings and delete
└─ Connections    clients, setup, service health
Header: scope / page breadcrumb · search/jump (Ctrl K or /, searches all projects) · theme toggle
```

## Project scope

In revision 2, the work pages silently showed every project, and the Projects page jumped to a filtered board. That was confusing: it wasn't clear what the pages above were showing, and choosing a project changed only one page. Revision 3 makes scope a single, explicit setting:

- **One switcher** sits at the top of the sidebar: *All projects* or one project. It changes **every** work page (Needs you, Work, Reviews, Dependencies, Timeline, Agents) together. It stays selected as you move between pages.
- **The switcher menu shows decisions owed per project.** While viewing one project, you can still see that another project needs you.
- **Scope is visible everywhere:** in the breadcrumb ("Recipe App / Work"), as a pill next to each page title, and as a colour swatch in the collapsed rail.
- **Projects and Connections are service-wide** and labelled that way. On the Projects page, *Switch to* sets the scope and opens that project's Needs you. Per-project settings (approval policy, definition of ready, delete) also live there.
- **Links across projects stay visible.** When you're scoped to Recipe App, Docs Site items that block your work still appear: as dashed "Docs Site ↗" nodes on the graph, as blocker markers on the timeline, and with a project tag in dependency lists.
- **Opening an item from another project** (from a link or search) shows a notice ("DOC-4 belongs to Docs Site…") with a *Switch to Docs Site* button. Your scope never changes silently.
- **Search covers all projects** and shows each result's project.
- **Every visit starts at All projects** (owner decision), so you never come back to a page that is silently scoped to one project.

## Screens

### 1. Needs you (home) — H02, H09
- **Summary line:** "3 decisions owed: agents are waiting on these. 5 other items to look at."
- **Filter chips** with counts: All, Decisions, Stale runs, Failed runs, Blocked, Date risk, Missing evidence.
- **Each queue row** shows:
  - an icon for the kind of problem,
  - the item title as a link, the ID, and the run state,
  - one sentence explaining *why* it is here,
  - which items it is holding up,
  - one action button.
- **Ordering:** decisions first, then failed and stale runs, then blockers and date risk, then evidence gaps. Within each group, the row holding up the most items comes first.
- **Answering an agent question:** the reply box opens inline in the row. The owner never has to leave the queue.
- **Right rail:**
  - "Agents right now": each active run and its state.
  - "Since you looked at 08:30": changes since the owner last visited, each linked to its item.

### 2. Work — H01, A05
- **Board columns:** Inbox · **Planning** · Ready (*Startable* + collapsible *Waiting on blockers*, shown as ID chips) · In progress · Review · Done (last 7 days).
- **Planning cards** show the project's required planning docs as small chips: ✓ approved, ◐ in review, ✎ drafting, – not started. Example: "✓ PRD ◐ UX ✎ TDD".
- **Card contents:**
  - ID, type, and priority bars
  - title
  - state chips: *Blocked by X*, *Gate: …*, *Review owed*, *Question for you*, *Date risk*
  - run state with label, lead agent, and last activity
- **Card left border:** red if blocked, amber if the owner owes a decision.
- **Saved filters** have counts and match the agent queries one-to-one. The equivalent query string is shown, including the project when scoped ("Agent query: `status:ready -is:blocked project:RCP`"). *In planning* is one of the filters.
- **List view:** the same data as a table, with real links.

### 3. Work item — H03, H05, H06, H11, H13, A15, A16, A17
- **Banners** appear only when the owner must act:
  - *Done is locked*: a gate is pending.
  - *Review owed*.
  - *Agent question*: includes an answer box.

  Otherwise the approval policy is a quiet chip in the header.
- **Definition of ready card** (Planning items only):
  - Lists each planning doc the project requires, with its state. A doc in review links to its review.
  - **Move to Ready** stays disabled until every required doc is approved. The card names what's missing ("Waiting on UX, TDD").
  - The required docs come from the project's rule for this item type. The card says which rule applies ("Story in this project needs PRD, UX, TDD").
  - When everything is approved: in an *owner moves to Ready* project, the item appears in Needs you as a *Move to Ready* decision. In an *agent may move to Ready* project, the lead agent can move it, and the card shows "Agent may move to Ready". You can still move it yourself.
- **Inbox items** get a *Move to Planning* button.
- **Default tab:** Review and Done items open on **Evidence**. Everything else opens on **Progress**.
- **Progress tab:**
  - Numbered plan steps with states: done, current, planned, blocked, skipped.
  - Subagent contributions are nested under their step, each with an *Observed child run* or *Relayed by lead* badge.
  - Revised steps show the old text struck through, plus the reason.
  - **Plan history** opens a dialog listing every version as a diff (v1 → v2 → v3).
- **Evidence tab:** each row has a provenance badge. If an agent closed an item in a project with no owner gate, the owner can *Accept without evidence* or *Reopen*.
- **Lead & runs rail:**
  - Lead run, lease, and heartbeat, plus any child runs and log-only subagents.
  - A rejected second claim on the item is shown as a notice (A15).
  - **Stale run:** *Release lead claim…* opens a confirmation. The run is marked *interrupted*, its work is kept, and the item returns to Ready.
  - **Failed run:** the error excerpt is shown, plus *Return to Ready*. The text makes clear that the service never launches agents (O08).
- **Priority is editable in place** (H11). The change is logged to activity, with an Undo toast and the note "agents see it on their next query".
- **Dates show who set them.** Date conflicts with blockers appear as red callouts.

### 4. Reviews — H04, H10, A09
- **Queue:** grouped into *Waiting* and *Decided today*. Decision chips use the same vocabulary everywhere: Pending · Approved · Changes requested · Deferred · Waived.
- **Document pane:**
  - The version selector shows each version's decision state.
  - Author, time, and hash are shown.
  - **Show/Hide changes since v1:** inline ins/del marks, or a clean reading view.
  - **Download .md**.
  - A warning appears when viewing an older version.
- **Owner gates** (e.g. "Release walkthrough") use the same screen. The submitted evidence is shown as badges, and the owner's walkthrough checklist is saved with the decision.
- **Decision panel:**
  - The four outcomes are a radio group. A reason is required for everything except Approve.
  - The submit button names the decision ("Record: Approve").
  - A footnote states exactly which version the decision applies to and what happens next.
  - An Undo button appears after recording.

### 5. Dependencies — H07, A04, A11
- **The graph** shows `blocks` links, with toggles to add `relates` and to show the parent epic grouping (labelled "never blocks").
- **Selecting a node** shows:
  - what it waits on, including indirect blockers (red),
  - what finishing it would free (green dashed),
  - what it is also needed for (still blocked by others).

  Nodes are keyboard-focusable buttons.
- **Cycles** are detected automatically. A fix button ("Remove ‘DOC-8 blocks DOC-7’") is offered, with Undo.
- **Delay impact:** pick a slip of 1, 3 or 5 days. Each downstream item shows *conflict*, *ok* or *unknown (no dates)*. Only entered dates are used.

### 6. Timeline — H08, H14
- Bars for entered dates, coloured by state:
  - blue: planned
  - red: date conflict, labelled "blocker ends later"
  - green: done
- A thin violet bar under each plan bar shows actual run time, ending at "now".
- A dashed marker shows where each unresolved blocker is planned to finish. The caption below the bar spells it out, e.g. "set by owner · Nov 3 · after **DOC-4 ends Nov 10**".
- **Forecast lane:** while there isn't enough history, it shows *no bar*, only the text "needs 8 completed items with effort (have 2)". A *Preview* toggle shows what a real forecast will look like: P50/P85 range, rate, window, and sample size.
- Items without dates are listed under the chart rather than silently left out.

### 7. Agents — H05
Shows every run and subagent log entry, with columns for state, item, what it is doing or did, last signal, and lease. A **How we know** column says whether the information is client heartbeat, observed child run, relayed by lead, or unknown. A legend explains every run state.

### 8. Connections — O01, O02, O07, O08 (new)
- **Client compatibility matrix** (the O07 smoke test): host Codex, host Claude, Orca + Codex, Orca + Claude (*not verified*), and agents in other containers (*off by default*).
- **Setup snippets** for Codex and Claude Code, with a Copy button. They are labelled as samples to check against each client's docs. The token is supplied through an environment variable, never written into tickets.
- **Endpoint:** loopback bind, bearer auth, allowed origins.
- **Service health:** database, document storage, volume, last backup and its retention, last restart, and what happened to active runs at restart.

### 9. Projects — O10, O11 (service-wide)
- **Switch to** sets the project scope and opens that project's Needs you. The current project is marked *Current*. Each row also shows decisions owed.
- **Definition of ready** per project and item type: which planning docs must be approved before an item can move to Ready. *Ceremony fits the risk.* In the sample, Recipe App (a money-making, ships-to-prod project) needs PRD, UX and TDD for Stories, PRD and TDD for Tasks, and nothing for Bugs. Docs Site (a side project) needs only a PRD for Stories and Tasks, and nothing for Bugs.
- **Who moves items to Ready** per project: *Owner moves to Ready*, or *Agent may move to Ready* once the required docs are approved. Like the approval policy, this setting should match the project's agent workflow documents.
- **Approval policy** per project, changeable inline with Undo.
- **Status bar** per project, with an accessible text label.
- **Delete** opens a dialog that states its scope (items, documents, what agents will see, and backup retention). The owner must type the project key to confirm.

### Global
- **Search and jump** (`Ctrl K` or `/`): one palette for work items and views, with arrow-key navigation.
- **Theme:** follows the system setting, with a manual light/dark override.
- **Toasts** confirm owner mutations and offer Undo for 6 seconds.

## Visual language

### Work status chips
| Status | Treatment |
| --- | --- |
| Inbox | gray |
| Planning | teal |
| Ready | blue |
| In progress | violet |
| Review | amber |
| Done | green |
| Canceled | gray, struck through |
| **Blocked** (derived) | red chip, "⊘ Blocked by X", shown *next to* the status chip |

### Run state — icon shape + text label, separate from status
| Icon | Label | Meaning |
| --- | --- | --- |
| ● solid green, pulsing | live | Client heartbeat received |
| ○ violet ring | reported | Agent says it's working; no heartbeat |
| ◌ dashed gray ring | stale | No heartbeat; state unknown |
| amber disc with "?" | needs input | Waiting on the owner |
| red disc with "×" | failed | Run ended with an error |
| gray disc with "✓" | finished | Run ended normally |
| gray ring with "–" | interrupted | Lease released or service restarted |

The pulse turns off under `prefers-reduced-motion`.

### Provenance badges — each kind has its own border style and icon
| Badge | Style | Meaning |
| --- | --- | --- |
| Owner decision | **solid green fill, person icon** | The only style that means human approval |
| Observed child run | solid violet outline + tint, eye icon | Seen directly by the service |
| Agent-reported | dashed violet outline, bot icon | The agent's own assertion |
| Relayed by lead | dotted gray outline, relay icon | Second-hand, from the lead agent |
| CI / Automated check | blue tint, gear icon | Test or build systems |
| Git · not approval | neutral gray, branch icon | A merge is never an approval |
| Owner gate pending | amber outline, clock icon | Waiting on the owner |

### Priority
Priority is shown as three neutral signal bars plus "P1"/"P2"/"P3" in mono text, and is never coloured. This keeps red and amber free to mean *something is wrong* or *you need to act*.

### Tokens
Every text pair below was measured. All text is at least 4.5:1 and all control borders at least 3:1 (WCAG 1.4.3 and 1.4.11).

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--ink` / `--ink-2` / `--ink-3` | #16191f / #444c59 / **#5f6878** (5.6:1) | #e6e9ef / #b8c0cc / #99a2b4 (6.9:1) | Text levels. `ink-3` is the smallest allowed for secondary text. |
| `--ctl` | #8a929f (3.1:1) | #6f788a (4.0:1) | Borders on inputs, buttons, chips |
| `--line` | #e3e6eb | #2a303b | Decorative card and divider lines only |
| `--ok` | **#237032** | #5bd06f | Done, owner approval |
| `--warn` | **#9a4705** | #f0a020 | Owner action needed, review |
| `--bad` | #c22b2b | #ff7b7b | Blocked, failed, conflict |
| `--info` | **#1864ab** | #5cb3f8 | Ready, informational |
| `--violet` | #6741d9 | #a990ff | Agent work, in progress |
| `--teal` | #0b7285 (5.0:1 on tint) | #3bc9db | Planning |
| `--on-fill` | #fff | **#0f1115** | Text on solid fills. Dark mode uses dark text, which fixed the 2:1 failures in revision 1. |

- **Type:** Inter or the system UI font, 13px base. Secondary text is at least 11.5px. IDs, hashes and endpoints use a mono font at 12px.
- **Hit targets:** at least 28px tall for small buttons and chips, 32px for nav and tabs.
- **Radius:** 8–12px.

## Accessibility (built in the prototype, not just intended)
- **Semantic, focusable controls:**
  - Cards and IDs are real `<a>` links.
  - Actions are `<button>`s.
  - Graph nodes are `role="button"`, focusable, and respond to Enter or Space.
  - Table headers use `scope`.
- **Tabs** follow the ARIA tabs pattern: `tablist`, `tab`, and `tabpanel`, with roving tabindex and ←/→/Home/End keys.
- **Decision choices** are a `radiogroup`.
- **Dialogs** have `role="dialog"` and `aria-modal`. They trap focus and close on Esc. Destructive dialogs focus **Cancel** first.
- **Focus is kept across re-renders,** so keyboard users don't lose their place after an action.
- **Run states and provenance carry text,** not just colour or shape. Badges include screen-reader prefixes such as "Agent-reported:". Status bars have `aria-label`.
- **Toasts** use `role="status"` with `aria-live="polite"`.
- **Reduced motion** is respected.

## Validation scenarios in the prototype
| Scenario from the requirements | Where to try it |
| --- | --- |
| PR merged and CI passed, but the owner walkthrough is pending | Needs you → RCP-12 → Review. Approving moves RCP-12 to Done, and RCP-22 becomes startable on the board. |
| Plan revised mid-flight, with a subagent contribution | RCP-14 → Progress → Plan history |
| Revised document after requested changes | Reviews → RCP-19, v1 vs v2, Show/Hide changes |
| Cross-project blocker with a date conflict | RCP-16: Needs you, Timeline (red), Dependencies |
| Stale run shown as unknown; competing claim rejected | RCP-15 → Release lead claim… → run becomes *interrupted* (Undo available) |
| Agent waiting on an owner answer | Needs you → DOC-4 → Answer (inline) |
| Cycle in imported data | Dependencies → DOC-7 → Remove link |
| Project without an owner gate; agent closed without evidence | DOC-2 → Evidence → Accept or Reopen |
| Client compatibility (O07) | Connections |
| Switching project scope | Sidebar *Project* menu → Recipe App: badges, board, graph and timeline all narrow; DOC-4 stays visible as an external blocker |
| Planning gate | RCP-23 → approve the UX doc in Reviews; Move to Ready stays disabled until the TDD is approved |
| Planning complete, agent may move it | Docs Site → DOC-9: not an owner decision; the card explains the lead agent may move it, and you can still click *Move to Ready* |
| Ceremony fits the risk | Projects: compare per-type rules (Recipe App Story: PRD, UX, TDD; Docs Site Bug: none) and switch who moves items to Ready |
| Starting planning | RCP-20 (Inbox) → *Move to Planning* |

The prototype has a self-check: open it with `?selftest` and it renders every view in each project scope, plus every item, tab, dialog and filter, then reports any errors in the page title. In revision 3, that check passed in headless Edge. A 28-step scripted click-through of the flows above also passed.

## Changes in revision 3 (owner feedback)
1. **Project scope:**
   - One sidebar switcher scopes every work page. Projects and Connections are labelled service-wide.
   - Scope appears in the breadcrumb and as a pill on each page title.
   - The switcher shows decisions owed per project.
   - Items from other projects are flagged, with a notice and a *Switch to* button.
   - The Projects page now switches scope instead of opening a filtered board.
2. **Planning status:**
   - The flow is now Inbox → Planning → Ready → In progress → Review → Done.
   - Each project defines which planning docs each item type needs before Ready (ceremony fits the risk), and whether the owner or the lead agent moves items to Ready.
   - Planning docs go through the normal review screen.
   - Moving to Ready is offered only when the required docs are complete. It is an owner decision only in projects that require one.

## Changes in revision 2 (from the design critique)
1. **Accessibility:**
   - Cards and rows are now real links. Tabs, dialogs and the radiogroup have proper ARIA. Focus is preserved across re-renders.
   - All text colour pairs pass AA; the owner badge went from 4.37:1 to 6.1:1. Dark-mode fills use dark text.
   - Control borders now meet 3:1.
2. **Provenance:** "Observed child run" is now solid and distinct from "Agent-reported" (dashed).
3. **Colour:** priority uses neutral bars. Run states always carry a text label.
4. **Forecast:** no bar is drawn when data is insufficient. A preview toggle shows the future state instead.
5. **Counts:** one counting rule. The sidebar shows decisions owed, the chips show queue counts, and the Reviews badge shows pending reviews.
6. **Ready column:** split into Startable and Waiting on blockers.
7. **New flows:**
   - inline answer to agent questions
   - plan history dialog
   - stale-claim release with an *interrupted* run state
   - claim-conflict notice
   - failed-run "Return to Ready"
   - cycle fix with Undo
   - delay-impact what-if
   - evidence acknowledgement
   - inline priority and policy edits with Undo
   - typed-confirmation delete
8. **New screens and features:** Connections (client matrix, setup, health), command palette, theme toggle, "Since you looked".
9. **Timeline:** blocker-end markers, date-conflict highlighting, actual bars stop at "now", and undated items are listed.
10. **Responsive:** the sidebar collapses to an icon rail, the Reviews layout reflows, and the board scrolls horizontally.
11. **Removed** every control that did nothing in revision 1.

## Open design questions
1. **Agent questions:** should a question pause the agent's lease (as the prototype assumes)? Or should the agent keep the lease and poll?
2. **Gate shape:** are gates per project only (as the prototype assumes), or can an item type or a single item add its own gate?
3. **Last visit:** how is "since you looked" tracked — the last time this browser loaded the page, or an explicit "mark all seen"?
4. **Document previews:** which formats does V1 preview besides Markdown (images, PDF, HTML)?
5. **Forecast threshold:** the prototype uses 8 completed items with effort values. Confirm the number and the window.
6. **Releasing a claim:** should the owner be able to release a *live* agent's claim, or only a stale one? The prototype offers it only for stale claims.
7. **Per-item exceptions:** should an item be able to skip a doc its type normally requires (e.g. a one-line Story), with a recorded reason? Or is the per-type rule enough?
8. **Rule shape:** are item types (Story, Task, Bug) the right key for planning rules? Or should projects use an explicit size or risk field?

### Decided (owner, 2026-11-06)
- **Moving to Ready** doesn't have to be done by the owner. Each project defines that gate; an agent may move an item when the project allows it.
- **Planning docs** are set per project and can differ by item type. Small changes can skip UX and TDD. High-stakes projects can require all of them. The principle: ceremony fits the risk.
- **Project scope** always starts at *All projects* when the UI loads, so returning to the app never leaves you in an unexpected project.
