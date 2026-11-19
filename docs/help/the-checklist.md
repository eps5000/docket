---
title: The checklist and step details
summary: What the agent's plan, its checks and your review items show, and how to read or edit one step's details in the step dialog.
group: Working with agents
order: 4
anchors:
  - item.work
related:
  - review-a-packet
  - questions-and-notes
  - jira-import
---

Every ticket and epic has a **Checklist** tab with three sections:

- **Work:** the agent's plan, one line per step. Each step shows its state (done ✓, current, to do, blocked), who moved it and when. A step the agent reworded shows the old text struck through and "Changed: …" with its reason. Subagent contributions sit under the step they helped with.
- **Agent review:** the checks the agent runs, with their evidence.
- **Human review:** what you'll verify yourself when the agent hands the work over.

You can add a step of your own at the end of Work (type it and press Enter). The agent keeps your steps when it revises its plan, and you can remove them while they aren't done.

## Step details

A step is one line, but it can carry **details**: as much Markdown as the work needs (up to 10,000 characters), and a **source**, such as the Jira key it came from. Steps with details show a small document icon next to their title. Rows never expand in place: the details open in the step dialog.

Agents write details when they plan, and read a step's details before they work on it. A Jira import puts each sub-task's description in its step's details, with a header line for its assignee, dates and story points.

## The step dialog

Click a step's title, or its document icon, to open it. The dialog shows:

- the title, its state, and its source. A Jira key links to the issue when the project was imported from Jira;
- the details, rendered as Markdown;
- the history: wording changes with their reasons, state changes with who made them and when, and every edit to the details;
- subagent notes, each with how it's known (seen by Docket, or relayed by the agent).

*Previous* and *Next* move through the steps; so do ← and → when you aren't typing. Esc closes the dialog and puts you back on the step's row.

## Editing details

Click *Edit details*, change the text, then *Save* or press Ctrl+Enter. *Preview* shows how it will look. Esc cancels, and asks first if you changed something. Each save is a new version, and agents see it on their next read. You can edit any step's details, the agent's steps included, and undo a save from the toast.

If the agent changed the details after you opened the editor, Docket doesn't overwrite them. A callout says who changed them and when, shows their version, and keeps your text: choose *Use mine anyway* or *Keep theirs*.
