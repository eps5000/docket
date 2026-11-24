---
title: Pick the next epic
summary: Choose an epic for a new agent that won't immediately park on another epic's work.
group: Planning
order: 2
anchors:
  - work.pick-next-epic
related:
  - blockers-and-dependencies
  - pause-a-project
---

**Pick next epic** shows which open epic you can hand to a new agent. Choose a project, open **Work**, then select **Pick next epic**.

The page only reads your plan. It doesn't assign anything, and it doesn't stop an agent from claiming a ticket. It's based on dependencies recorded in Docket, so work that depends on something nobody linked won't show.

## What the columns mean

- **Can finish on its own:** open tickets whose whole chain of open blockers stays inside this epic, such as "18 of 18".
- **Can start now:** Ready tickets with nothing blocking them and nobody on them, the same rule as the **Startable** filter on Work. In a paused project the column says **Can start once resumed**, and counts what could start after you resume it.
- **Waits on:** the other epics, or tickets with no epic, that this epic's open chain depends on, with how many tickets in each.
- **Unblocks elsewhere:** open tickets in other epics that wait on this epic, directly or further down the chain. Each ticket counts once.
- **Not shaped yet:** tickets still in Inbox or Planning.
- **Being worked:** the live lead or producer already holding the epic or one of its tickets, so you don't assign a second one.

A blocker on the epic itself counts for every ticket in it. A canceled blocker still counts, because it never clears. Remove the link or reopen the ticket.

## How they're ordered

Epics nobody holds come first, then those with something to start, then those that can finish on their own, then those that unblock the most elsewhere. The first one that's free and unlikely to park is marked **Best next**, with the reason.

**Likely to park** lists epics where nothing can start, or where most tickets wait on work outside the epic. Each says why.

Select a column heading to sort by it. Select it again to reverse the order, and a third time to go back to the best-fit order.

## On the epic itself

Epic cards and the epic page say **No outside dependencies**, or **Waits on 2 epics** with their names.
