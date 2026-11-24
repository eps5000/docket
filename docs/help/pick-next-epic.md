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

**Not ready to start** lists epics that haven't started and still have tickets in Inbox or Planning. Each says **Not ready to start: 2 unshaped tickets** and links them. These are never **Best next**.

Select a column heading to sort by it. Select it again to reverse the order, and a third time to go back to the best-fit order.

## On the epic itself

Epic cards and the epic page say **No outside dependencies**, or **Waits on 2 epics** with their names.

While bugs in an epic are open, its row, card and page also say **Finish line GF-12 · Waiting on 2 bugs**, or **No finish line** when nobody has marked its release ticket yet. That doesn't change which epic is the best pick: the bugs hold its release, not its start. See *Blocker rules and dependencies* for how bugs hold the release.

## An epic starts only when its tickets are ready

**Inbox** is an idea nobody is ready to plan. **Planning** means a ticket still has gaps in its shape or its definition of done. So an agent can't start an epic while any of its tickets is in Inbox or Planning. Tickets that are Ready, Queued, In progress, in Review or Done all count. Canceled tickets don't matter.

When an agent tries to start such an epic, Docket refuses and tells it which tickets, and the four ways forward:

- finish shaping the ticket and move it to Ready;
- name its **known gaps** and ask for your approval (below);
- move it to the epic it belongs in;
- take it out of the epic.

An epic that's already **In progress** keeps going. It shows **Started with 2 unshaped tickets** on its card and page, and the producer sees the same in its digest.

## New work after an epic starts

Bugs turn up while an epic runs, and new ideas too. A ticket added to an epic after it started still lands in **Inbox**, so nothing joins a running epic as Ready without someone looking at it first. The epic's producer triages:

- **A bug:** it starts a short, read-only check that confirms the bug happens and whether this epic's work caused it, and leaves the steps to reproduce it or a failing test. That check fixes nothing. If the bug is real and belongs here, the producer sets how serious it is and moves it to Ready in this epic. If it belongs somewhere else, such as a flaky test that goes to your test-reliability epic, it moves it there. If it can't be reproduced, the producer asks you whether to close it.
- **A story** adds scope, so it's your call. The producer asks you one question: add it to this epic, defer it to a follow-up, or drop it.

You can see it as it happens. The epic's card and page say **Added since it started: 3 tickets · 2 untriaged**, with each ticket linked on the page, and the map marks each of those cards **added mid-flight**. The producer's digest lists the untriaged ones first. An epic can't be closed while any of them is still untriaged: Docket says which ones.

## Ready with known gaps

Sometimes a ticket is shaped except for a few things that are best settled while building it. The agent names those as **known gaps**. A ticket with known gaps needs your approval to move to Ready:

- Docket asks you: **Approve moving GF-1 to Ready with these gaps?** Choose **Approve with these gaps** and it moves to Ready, or **Keep it in Planning**.
- Or, on the ticket itself, select **Approve gaps and move to Ready**.

Either way your approval is recorded as your decision on the ticket, and you can undo it for a short while. The ticket's **Known gaps** section lists each gap. Once the work starts it's called **Known gaps to shape**, and the agent writes how it settled each one.

A ticket with no open gaps moves to Ready as usual, with nothing to approve.
