---
title: Decision records
summary: Record the choices and conventions agents must follow, confirm or withdraw what agents record, and how scope works.
group: Planning
order: 3
anchors:
  - decisions.section
related:
  - questions-and-notes
  - blockers-and-dependencies
---

A **decision** is a short record of something agents must respect, like "Nutrition is per serving" or "Use the v2 design tokens". Agents get every decision that applies when they start work on an item, so you don't have to repeat yourself.

## Scope

Each decision applies to a project, an epic, a label or a single item. An item gets everything in its scope: its project's decisions, its epic's, its labels' and its own.

You find them in the **Decisions** section where they apply: a ticket's or epic's **Details** tab, a label page, and the "n decisions" link on each project in **Settings → Projects**.

## Yours and agents'

- **Owner** decisions are yours. They're authoritative: agents can't replace or withdraw them. An agent that disagrees has to ask you.
- **Agent** decisions are recorded by agents as they work. Another agent may replace one with a newer decision.

Agents' decisions never show up in Needs you. You see them where they apply, and in the item's **Activity**.

## Reading a decision

Each decision shows its title, who recorded it and when, and the first two lines of its text.

- *Show all* expands a decision whose text is longer than two lines; *Show less* folds it again.
- *Show reasoning* shows why the decision was made, when whoever recorded it gave a reason. *Hide reasoning* folds it again.
- The chip next to the title is its scope (project, epic, label or item), and the badge says whether it's yours (**Owner**) or an agent's.

## What you can do

- *+ Record a decision*: fill in the title, the decision and (optionally) why, and pick the scope. What you record is an owner decision.
- *Confirm* on an agent's decision makes it yours, so agents can no longer change it.
- *Supersede* writes a new decision that replaces an old one. Both stay readable.
- *Withdraw…* retires a decision, with an optional reason. It stops going to agents but stays in history. A toast offers *Undo*.

*Show withdrawn and superseded* brings back the ones that no longer apply, greyed out.
