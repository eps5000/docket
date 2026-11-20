---
title: Your first look around
summary: What Needs you, Work and Agents show, where to look first each day, and how Work's filters work.
group: Getting started
order: 2
anchors:
  - needs-you.page
  - needs-you.welcome
related:
  - review-a-packet
  - questions-and-notes
  - run-states
---

Docket doesn't start agents. You (or Orca) start them, and they report here: what they claimed, what they're doing, and what they need from you. The sidebar has three places to look.

## First run: the Welcome page

Until you have a project, **Needs you** is the Welcome page. Work, Agents and Agent files point back to it. It offers three ways to start:

- **Create a project:** a key (2–5 letters, like `GF`) and a name. Then Docket shows what to do next: *Import from Jira*, *Onboard it with an agent*, or *Install agent files*.
- **Import from Jira:** copies a Jira Cloud project into a new Docket project, after a dry run. See [Jira import](/help/jira-import).
- **Onboard a repo with an agent:** give a connected agent the line "Onboard this repo into Docket as project KEY, using onboard_project" in the repo's folder, or run the `onboard` prompt. The agent sets the project up in Planning, and you review it on Needs you. [Connect the agent](/help/connect-an-agent) first.

Later you can make another project from the project switcher (*+ New project* at the bottom), from the header (the caret next to *+ New item*), or in **Settings → Projects**.

## Needs you

Start here. It shows only what's waiting on you:

- **Agents** (the line at the top): how many runs are live, reported, needs input, parked, stale or failed. Each count opens Agents filtered to that state. "n workspaces at risk" appears when an agent's worktree holds work that isn't safe yet.
- **For you now:** handoff packets to review (*Open packet*) and agents' questions (*Answer*).
- **Problems:** stale or failed runs, dependency cycles, date conflicts and recovery warnings, each with a button that takes you to the fix.
- **Deferred, not verified:** checks you deferred during a review that nobody has verified yet.
- **Your Planning queue:** items in Planning. Planning is yours: click *Move to Ready* when an item is ready for an agent.

The red number next to **Needs you** in the sidebar counts what's for you.

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

Every open run, what it's doing and when it last signalled, then **Workspaces** (the worktrees agents reported) and **Recent** (runs that ended in the last 24 hours). The gray number next to **Agents** in the sidebar counts open runs.

## The project switcher

The **Project** menu at the top of the sidebar scopes every page except Settings. It goes back to *All projects* each time you open Docket, so you never miss something because of a filter you forgot.

## Search

Press `Ctrl K` or `/` to search items, IDs, labels, views and these help articles.
