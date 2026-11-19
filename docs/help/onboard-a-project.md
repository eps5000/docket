---
title: Onboard a project
summary: Create a project, import its Jira tickets if it has any, then let an agent turn the repo's specs, plans and tasks into items you review from one card.
group: Getting started
order: 4
anchors:
  - settings.new-project
  - needs-you.onboarding
related:
  - jira-import
  - agent-files
  - connect-an-agent
---

An agent can set a project up for you from what's already in the repo: Spec Kit specs, plans and tasks, the constitution, ADRs, READMEs and TODOs. It needs no agent files installed first. Nothing it creates is made Ready, and you review all of it from one card.

## 1. Create the project

In **Settings → Projects**, click *New project*. Pick a key of 2–5 letters (item IDs start with it, like `GF-12`), a name, a colour, and when blockers clear. An agent can also create the project itself; it then shows **created by claude · review** in Settings and the project switcher until you review it.

## 2. Import from Jira first, if the work is there

If the project has Jira tickets, click *Import from Jira…* in the dialog after creating it. Import before onboarding: the agent then finds each ticket by its Jira key or title and adds to it, instead of creating a duplicate. See [Jira import](/help/jira-import).

## 3. Ask an agent to onboard it

The dialog shows the line to give any connected agent, from the repo's folder:

> Onboard this repo into Docket as project GF, using onboard_project.

Clients that support MCP prompts can run the `onboard` prompt instead; in Claude Code it's `/mcp__docket__onboard GF`.

The agent gets the onboarding guide from Docket, then:
- reads the repo's planning sources;
- matches each task to an existing item by Jira key, source path or title, and enriches it;
- creates the rest in Planning: epics from specs, items from tasks, dependencies, labels and decisions;
- attaches specs and plans as planning documents;
- proposes the project's Workflow notes;
- asks you what the repo can't answer, and finishes with a summary.

Running it again later is safe: each item records its source path, so a second run matches what the first created.

## 4. Review it from Needs you

When the agent finishes, **Needs you** shows one card, like "Gameflow was set up by claude · review", and it counts toward the tab title. It has:
- **the counts:** created, enriched, documents, decisions and proposals. *Created* and *Enriched* open Work showing just those items, with a chip you can remove;
- **the agent's summary and questions;**
- **the proposed Workflow notes,** to approve or decline;
- ***Install agent files***, so the next agents in that repo know how to work with Docket;
- ***Mark reviewed***, which clears the card and the "created by" chip.

Edit or reject anything as usual: the items are in Planning, and nothing moves to Ready until you move it.

## Change the guide

The guide is an agent file, **Onboarding guide**. Edit it in **Agent files**, for every project or just one, like the skills.
