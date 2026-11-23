# Design: the Overview page

**Status:** built in B51 (owner decision 43, 2026-11-22). BUILD_SPEC §5.24 and UI_SPEC §6.1 hold the exact definitions. Radar insights (below) are not built.

**B56 (the owner's review of the live page):** the open-ticket tab strip no longer shows here. The Agents card is now **Tickets with agents** ("N being worked", "M parked/waiting"), because it counts tickets and not sessions. The chart has a whole-number axis and a tooltip naming each bar's tickets. "Workspaces at risk" became a plain line saying which worktrees need the owner and which don't. The sketch below shows the original B51 layout.

**B59 (owner decision 48):** Overview adds flow trends (finished, recorded merges and parks) and links to a daily brief. See `docs/design/coordination-tooling.md`, BUILD_SPEC §5.29 and UI_SPEC §6.1b.

## Why

Needs you currently does two jobs: it lists what requires the owner, and it is the only place to see how the work is going. The owner should be able to open Docket and answer three questions in about ten seconds:

1. Are agents making progress?
2. Is anything stuck?
3. Do I need to do anything?

## The page

Overview replaces Needs you at `/`, and works for one project or All projects.

```text
Overview                                  [ 24h | 7d | 30d ]

┌ Completed ──┐ ┌ Agents ─────┐ ┌ In flight ──┐ ┌ Needs you ──┐
│ 18 tickets  │ │ 4 working   │ │ 23 tickets  │ │ 2 decisions │
│ +6 vs prior │ │ 3 waiting   │ │ 5 blocked   │ │ 1 review    │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘

Completed per day  ▂▃▁▅▇▄▆      Workload  ■ Ready ■ Active ■ Review ■ Blocked
                                Visual ████████░░  Deck █████░░░░░  Assets ███░░░

NEEDS YOU (3)                   HEALTH
• Approve GF-312 review         ✓ Agents handling 4 problems
• Design change on GF-240       ! 1 problem needs you
• Decide overlap: GF-255        ✓ Last backup 3h ago

PLANNING QUEUE (20) View all    DEFERRED, NOT VERIFIED (1) View all
Top 3 items                     Top 3 items
```

## Rules

- **The owner's actions come first.** With nothing to do, the section says "Nothing needs you" and the sidebar badge disappears. The badge always equals the number of owner actions on this page.
- **Every number is a link** to the filtered view behind it, such as Work filtered to Blocked.
- **Long lists keep their own pages.** Overview shows a count and the top few for the planning queue and deferred reviews.
- **Agent-owned problems stay collapsed** into one line unless they need the owner.
- **The time window** offers 24 hours, 7 days and 30 days. The default is 7 days, and the last choice is remembered. Comparisons use the preceding window of the same length.
- **Status colours** use the shared status tokens (B47).
- **Accessibility:** charts have text equivalents, and status is never shown by colour alone.

## Metrics

| Metric | Definition |
| --- | --- |
| Completed | Tickets that entered Done in the window and are still Done. Epics are excluded. |
| Agents working | Stories with live, current producer-level work now. |
| Agents waiting | Stories whose producer is parked on a real dependency, now. |
| In flight | Open tickets in In progress or Review. |
| Blocked | Open tickets with an uncleared blocker. |
| Workload | Open tickets by status, grouped by epic. |
| Needs you | Owner actions only: reviews, decisions, design changes and problems no agent can resolve. |

Counts of agents must be by **producer-level ownership**, not raw runs, so one story handed between small workers counts once. That is why this page depends on B50.

**Token use** was left out here because clients don't report it to Docket. B63 (decision 48) reverses that with measured data from the local agent logs, off by default. Dollars are always labelled as an estimate. See BUILD_SPEC §5.34.

## Build order

1. **B49:** truthful Problems, and a badge that matches owner actions.
2. **B50:** status drift fixes and producer-level ownership.
3. **Overview:** a read API for the metrics, then the page, Help and e2e with axe in both themes, tested for 1024 px and on the 300-item stress project.

## Later: Radar insights

The Overview page should leave room for an **Insights** section. As Radar grows beyond merge conflicts, it can review how work is flowing and suggest improvements, for example:

- work that repeatedly waits on the same shared part or person;
- epics whose branches keep conflicting;
- stories that bounce between claims or stay parked too long;
- review queues that are slowing delivery;
- changes in throughput over time.

Insights must follow these rules:

- each one cites the evidence behind it and links to the affected work;
- suggestions are **proposals**. Radar never changes a workflow, priority or plan by itself;
- the owner can accept, dismiss or redirect one, and a dismissed insight doesn't keep returning;
- accepted workflow changes go through the existing proposal and approval paths;
- insights stay quiet: they appear on Overview and don't add to the Needs you badge unless a real owner action is required.
