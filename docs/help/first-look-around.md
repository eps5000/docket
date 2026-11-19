---
title: Your first look around
summary: What Needs you, Work and Agents show, and where to look first each day.
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

## Agents

Every open run, what it's doing and when it last signalled, then **Workspaces** (the worktrees agents reported) and **Recent** (runs that ended in the last 24 hours). The gray number next to **Agents** in the sidebar counts open runs.

## The project switcher

The **Project** menu at the top of the sidebar scopes every page except Settings. It goes back to *All projects* each time you open Docket, so you never miss something because of a filter you forgot.

## Search

Press `Ctrl K` or `/` to search items, IDs, labels, views and these help articles.
