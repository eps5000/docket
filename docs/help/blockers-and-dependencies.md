---
title: Blocker rules and dependencies
summary: How "blocks" links decide what's ready, when a blocker counts as cleared (done, merged or verified), and how to fix cycles.
group: Planning
order: 1
anchors:
  - item.dependencies
  - settings.blocker-rule
  - map.criticalPath
related:
  - review-a-packet
  - dates-effort-forecast
---

When one item **blocks** another, the second can't start until the first is cleared. Docket works this out for agents: they only get items that are Ready, not blocked and not claimed. Agents add and remove links; you see them on each ticket's **Dependencies** tab and on the maps.

## When a blocker counts as cleared

Each project has a rule. Set it in **Settings → Projects**, with **Blockers clear when**:

| Rule | A blocker is cleared when it's… |
|---|---|
| **Done** (the default) | done. |
| **PR merged** | done, and its pull request is reported merged. The agent reports this; Docket doesn't check GitHub. |
| **Verified by you** | done, and you approved every check in its human review, with none deferred. |

An agent can set a stricter or looser rule on a single link. Changing a project's rule takes effect at once, and the toast says how many items it blocked or unblocked, with *Undo*.

A blocker that's done but still waiting says so on the ticket's page: "Open blockers: RCP-12 (needs merge)" or "(needs your verification)".

## Queued or Blocked

A ticket with an open blocker is one of three things. Its status stays Ready (or whatever it was), and agents still can't claim it until the blocker clears.

- **◷ Queued · Starts after RCP-12** (calm, never red): everything it waits on is moving. Each blocker is being worked, is Ready, or is queued itself. It's just waiting its turn. "and 2 more" means it has other open blockers too.
- **⊘ Blocked** (red): the wait needs you or a coordinator. The chip names the reason and the ticket, and its tooltip and the ticket's page say it in full:
  - **No next step:** a blocker somewhere in the chain could move, but nobody owns it and nothing has happened on it for 15 minutes. For example, it's still in Planning with no agent, or it's done and nobody is merging it.
  - **Owner decision not asked:** a blocker says it needs your decision, and nobody has asked you.
  - **Canceled blocker:** a blocker was canceled, so it will never clear.
  - **Blocker loop:** the chain loops back on itself.
  - **Parked too long:** a blocker's agent has been parked longer than the stall limit (24 hours by default), and not because of a decision you're holding.
- **Held by your decision:** your paused project, or a decision you recorded, is holding it. It's neither Queued nor Blocked, and nothing is wrong.

Work has a **Queued** filter and a **Blocked** filter. Overview's In flight card, epic cards, Pick next epic, the critical path, the daily brief and agents' `get_digest` and `get_context` all use the same rule, so their counts agree.

## Reading the Dependencies tab

The ticket's **Dependencies** tab shows what it waits on, then the ticket, then what it unblocks. Each node shows its status; a done blocker that still blocks says "done · waiting for merge" or "done · waiting for your verification". "Relates to (doesn't block)" lists links that never block. *See it on the epic map →* opens the whole picture. A link the epic's map hides because a chain already shows it says "Also implied through …" under its node.

Parent epics and "relates" links never block. Blocking works across projects.

## Reading the map

An epic's **Map** tab puts its tickets in waves, left to right: wave 1 can start now, wave 2 after it, and so on. The bar at the top and the card edges use the same colours as the status chips. In progress is Done's green with stripes, because it's on its way to Done, just as Queued is Ready's blue with stripes. Ready work that's waiting its turn is **queued** (a calm dashed outline), and only Ready work whose wait needs attention is red and **blocked**.

Arrows run through the gaps between cards and never across one, so several can share a gap. **Hover or focus a card** to pick out its arrows: they light up and the rest fade. A dashed green arrow is a blocker that's already cleared. Use − / + or **Fit width** to zoom, and drag the background to pan.

### Fit width

**Fit width** shrinks the map until every wave fits across the screen, then takes you to the top. A wave with many tickets runs further down: scroll down with the mouse wheel, a trackpad, a finger, or the arrow keys once you've selected the map. It never makes a small map bigger than normal (100%), and it stops at 50% so cards stay readable; a map with too many waves to fit even then scrolls sideways too. Press **Fit width** again to go back to 100%, or use − and + from where it left you.

### Hide implied links

If C waits on B and B waits on A, an arrow straight from A to C adds nothing: the chain already shows it. **Hide implied links**, beside the zoom controls, is on by default and leaves those arrows out. It hides an arrow when a chain of other arrows already connects the same two tickets, and "3 hidden" tells you how many. Turn it off to see every arrow; your browser remembers the choice.

It only changes the picture. The links are still there: the ticket's Dependencies tab lists every one, with a quiet "Also implied through GF-2" on a link the epic's map hides, and blocking works exactly as before. If the chain breaks, because a ticket in the middle is canceled, removed or outside the view, the direct arrow comes back on its own. A blocking link is only ever hidden behind other blocking links, never behind links that don't block.

## Bugs hold the release

Every epic has a **finish line**: its release ticket, the one that depends on other tickets in the epic while nothing else in the epic depends on it. Docket finds it from the links. When several tickets, or none, fit, the epic says **No finish line**: pick one under *Mark the release ticket* on the epic page, or ask the producer to mark it.

**Every open bug in the epic holds the finish line**, with no link needed. It can't go to Review or Done while a bug in the epic is open; the agent is told which bugs and the three ways forward:

- fix the bug;
- move it to another epic, as a follow-up;
- cancel it, with a reason.

Shipping without a fix is a choice you can see: moving the bug out or canceling it shows in Activity, and canceling a bug in an epic always asks why. Bugs in other epics don't count, and a bug that a story really waits on keeps its ordinary link too.

On the epic's **Map**, bugs with no links sit in a **Bugs** column on the left, with their status, instead of looking like starting work in Wave 1; its header counts the open ones. A bug that's part of the chain stays in its wave, marked "bug". The finish line's card says **Finish line · Waiting on 2 bugs**. The epic page, its card and Pick next epic show the same count.

## What's holding up a goal?

When a long chain of tickets is in the way, pick a ticket or epic under **What's holding up** on the Map, or use *See what's holding this up* on its page. Docket finds the longest chain of open blockers to it, numbers those cards and mutes the rest.

**Move next** names the one ticket at the start of that chain and why: it's ready to start, nobody owns it, its agent is parked, it's waiting on you, it's waiting to merge, it was canceled but still blocks, or it's in a loop of blockers. *The chain as a list* gives the same chain in order. If two chains are equally long, Docket picks the one that can start now, then the higher priority.

This only shows you where to look. It doesn't change any ticket or stop anyone from working.

## Splitting a ticket

If a blocker holds up only some of a ticket's acceptance criteria, split the ticket so the rest can go ahead. On the ticket, open **⋯** and choose **Split ticket…**.

- Name the new ticket, then choose what to **move** or **copy**: acceptance criteria, blockers, shared parts and checklist steps. Anything you leave stays.
- Choose how they relate: the new ticket waits for the original, the original waits for it, or neither.
- The preview shows both tickets before anything changes. No criterion is lost, and the original keeps at least one.

If an agent is working on the ticket, it keeps its claim, and the dialog warns you. An open review packet is never rewritten: if criteria moved, it's marked out of date. The toast's *Undo* puts both tickets back.

## Problems you may see

- **Cycle:** items block each other in a loop, so none can start. Agents can't create one, but imported data can contain them. Click *Fix*: the Dependencies tab shows the loop with a *Remove “A blocks B”* button for each of its links. Remove the one that’s wrong.
- **Blocked by a canceled item:** a canceled blocker never counts as cleared, so its dependents stay blocked. Click *Fix*, then *Remove link*, or reopen the canceled item.
- **A blocker that needs your verification closed with a deferred check:** under **Verified by you**, a deferred check doesn't count as verified. Click *Open* to see the link, then verify the deferred check or change the rule.

Docket never silently unblocks work.

## Startable and Waiting

Ready doesn't always mean something can start. Work splits Ready in two. **Startable** tickets have nothing in their way. **Waiting** tickets are held by a blocker, a lead already on them, or your overlap or design decision, and each one says which. A Waiting ticket behind a blocker is also Queued, Blocked or Held (see above). The ticket's status stays Ready either way.
