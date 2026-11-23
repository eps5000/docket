---
title: Blocker rules and dependencies
summary: How "blocks" links decide what's ready, when a blocker counts as cleared (done, merged or verified), and how to fix cycles.
group: Planning
order: 1
anchors:
  - item.dependencies
  - settings.blocker-rule
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

A blocker that's done but still waiting shows it on the chip: "⊘ Blocked by RCP-12 (needs merge)" or "(needs your verification)".

## Reading the Dependencies tab

The ticket's **Dependencies** tab shows what it waits on, then the ticket, then what it unblocks. Each node shows its status; a done blocker that still blocks says "done · waiting for merge" or "done · waiting for your verification". "Relates to (doesn't block)" lists links that never block. *See it on the epic map →* opens the whole picture.

Parent epics and "relates" links never block. Blocking works across projects.

## Reading the map

An epic's **Map** tab puts its tickets in waves, left to right: wave 1 can start now, wave 2 after it, and so on. The bar at the top and the card edges use the same colours as the status chips, and red is Ready work that's blocked.

Arrows run through the gaps between cards and never across one, so several can share a gap. **Hover or focus a card** to pick out its arrows: they light up and the rest fade. A dashed green arrow is a blocker that's already cleared. Use − / + or **Fit** to zoom, and drag the background to pan.

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

Ready doesn't always mean something can start. Work splits Ready in two. **Startable** tickets have nothing in their way. **Waiting** tickets are held by a blocker, a lead already on them, or your overlap or design decision, and each one says which. The ticket's status stays Ready either way.
