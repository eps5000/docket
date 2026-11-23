---
title: Your first look around
summary: What Overview, Work and Agents show, where to look first each day, and how Work's filters work.
group: Getting started
order: 2
anchors:
  - needs-you.page
  - needs-you.welcome
  - overview.brief
related:
  - review-a-packet
  - questions-and-notes
  - run-states
---

Docket doesn't start agents. You (or Orca) start them, and they report here: what they claimed, what they're doing, and what they need from you. The sidebar has three places to look.

## First run: the Welcome page

Until you have a project, **Overview** is the Welcome page. Work, Agents and Agent files point back to it. It offers three ways to start:

- **Create a project:** a key (2–5 letters, like `GF`) and a name. Then Docket shows what to do next: *Import from Jira*, *Onboard it with an agent*, or *Install agent files*.
- **Import from Jira:** copies a Jira Cloud project into a new Docket project, after a dry run. See [Jira import](/help/jira-import).
- **Onboard a repo with an agent:** give a connected agent the line "Onboard this repo into Docket as project KEY, using onboard_project" in the repo's folder, or run the `onboard` prompt. The agent sets the project up in Planning, and you review it on Overview, under Needs you. [Connect the agent](/help/connect-an-agent) first.

Later you can make another project from the project switcher (*+ New project* at the bottom), from the header (the caret next to *+ New item*), or in **Settings → Projects**.

## Overview

Start here. In about ten seconds it tells you whether agents are making progress, whether anything is stuck, and whether you need to do anything. Choose **24h**, **7d** or **30d** at the top; Docket remembers your choice in this browser.

**The four numbers.** Each one opens the list behind it.

- **Completed:** tickets that reached Done in this period and are still Done, compared with the period before. Epics, canceled tickets and items imported as Done don't count, and a reopened ticket drops out.
- **Tickets with agents:** tickets being worked now, and tickets whose agent is parked or waiting on something named. A ticket counts once, however many workers or child runs it has. This counts tickets in Docket, not agent sessions. Orca can show more sessions, because coordinators and helpers don't each hold a ticket.
- **In flight:** open tickets in In progress or Review, and how many open tickets are blocked.
- **Needs you:** how many things are waiting on you.

**Needs you** lists every one of those things. When there are none, it says "Nothing needs you":

- **For you now:** handoff packets to review (*Open packet*) and agents' questions (*Answer*).
- **Decisions:** overlaps, held hand-offs, design changes, proposed resolutions, onboarding reviews and agents' project-wide decisions.
- **Problems:** stale or failed runs, dependency cycles, date conflicts and recovery warnings, each with a button that takes you to the fix.

**Health** shows the problems agents are handling on one line (open it to see them), your last backup, any worktrees holding unsaved work and whether they need you, and proposed agent file changes.

**Below that:** completed per day (hover over or tab to a bar to see which tickets finished), **flow** (below), open work per epic, **Your Planning queue** (click *Move to Ready* when an item is ready for an agent) and **Deferred, not verified** (checks you deferred that nobody has verified yet).

The red number next to **Overview** in the sidebar is the number of things under Needs you. Docket doesn't show token use, because clients don't report it.

### Flow

**Flow** shows three things per day (per hour for 24h), each on its own scale. Hover over or tab to a day to read all three.

- **Finished:** the same tickets as Completed.
- **Merged:** PRs an agent recorded as merged in Docket, on the day it was recorded. Docket doesn't watch GitHub, so this can be lower than the real number, and the chart says when finished tickets have no merge recorded. It's never an estimate.
- **Parked:** how many times an agent parked a ticket to wait for something. Epics don't count.

When these move in opposite directions, one sentence says so, such as "Parking is up while finished tickets are down". That usually means work is waiting on coordination rather than being built. It's only a note, and it never adds to Needs you.

### Daily brief

**Daily brief** at the top of Overview answers four questions in about a minute, for the day you choose and the current project:

- **What finished** that day.
- **What's stuck:** tickets parked longest, blockers nobody owns, and work held by one of your decisions, which is listed separately because nothing is wrong with it.
- **What needs you:** the same list as Needs you.
- **What changed in decisions** that day.

What's stuck and what needs you always show the situation now, even for an earlier day, because Docket doesn't keep a daily record of them. Every line opens its ticket. The brief only reads: it changes nothing and sends nothing.

## Work

Every ticket and epic, as a board, a list, a map of dependencies, or a timeline. Use the filters to narrow it, and click a card to open the item. An item's tabs show its details, its checklist, what it waits on, and its activity.

### Filters on the Work page

- **Quick filters:** **Active** (everything not done or canceled; what Work shows by default), **Blocked** and **In progress**. Pick one; each shows how many items it holds.
- **Filters** (the menu button next to them): tick any of *For you*, *Human review later*, *Deferred review*, *Live run* and *Has a problem* to narrow the view further. Ticking two shows only the items that match both.
- **Shows done** and **Shows canceled**, at the bottom of the menu, add finished items back on top of the quick filter. *Active* with both ticked shows everything.
- Each ticked filter appears as a pill next to the chips: click its **×** to remove it, or click **Clear** to go back to Active.
- The epic and label boxes narrow everything, counts included.

The filter is part of the page address, so you can share a link and use Back. Work also remembers your last choice for each project and uses it the next time you open Work without one. Old links (from before these filters) still open the same items.

**Done epics** are hidden from the Epics strip at the top, so you see what's still moving. Click **Show N done** at the end of the strip to see them, and **Hide done** to tuck them away. Epics with no tickets yet, and the epic you've filtered to, always show. On the board, the Done column says how many done items the filter hides, with a **Show N done** button.

## Agents

Every open run, what it's doing and when it last signalled, then **Workspaces** (the worktrees agents reported) and **Recent** (runs that ended in the last 24 hours). The gray number next to **Agents** in the sidebar is the number of stories being worked on in the current project, the same as *working* on Overview. Stories that are waiting aren't in it. The lists on this page show individual runs, so a story with a lead and two child runs is three rows.

## The project switcher

The **Project** menu at the top of the sidebar scopes every page except Settings. It goes back to *All projects* each time you open Docket, so you never miss something because of a filter you forgot.

## Search

Press `Ctrl K` or `/` to search items, IDs, labels, views and these help articles.
