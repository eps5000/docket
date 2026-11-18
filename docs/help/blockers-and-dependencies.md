---
title: Blocker rules and dependencies
summary: How "blocks" links decide what's ready, when a blocker counts as cleared (done, merged or verified), and how to fix cycles.
group: Planning
order: 1
anchors:
  - item.dependencies
  - settings.blocker-rule
  - problems.cycle
  - problems.canceled_blocker
  - problems.deferred_verified_blocker
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

## Problems you may see

- **Cycle:** items block each other in a loop, so none can start. Agents can't create one, but imported data can contain them. Click *Fix*: the Dependencies tab shows the loop with a *Remove “A blocks B”* button for each of its links. Remove the one that’s wrong.
- **Blocked by a canceled item:** a canceled blocker never counts as cleared, so its dependents stay blocked. Click *Fix*, then *Remove link*, or reopen the canceled item.
- **A blocker that needs your verification closed with a deferred check:** under **Verified by you**, a deferred check doesn't count as verified. Click *Open* to see the link, then verify the deferred check or change the rule.

Docket never silently unblocks work.
