---
title: Decision records
summary: Record the choices and conventions agents must follow, confirm or withdraw what agents record, and how scope works.
group: Planning
order: 3
anchors:
  - decisions.section
  - decisions.project-page
  - needs-you.project-decisions
related:
  - questions-and-notes
  - blockers-and-dependencies
---

A **decision** is a short record of something agents must respect, like "Nutrition is per serving" or "Use the v2 design tokens". Agents get every decision that applies when they start work on an item, so you don't have to repeat yourself.

## Scope

Each decision applies to a project, an epic, a label or a single item. An item gets everything in its scope: its project's decisions, its epic's, its labels' and its own.

You find them in the **Decisions** section where they apply:

- a ticket's **Details** tab lists the decisions made for it: its own, its epic's and its labels'. An epic's lists its own and its labels';
- a label page lists the label's;
- **project-wide decisions have their own page**, so they don't repeat on every ticket. A ticket or epic shows one line instead, "3 project decisions also apply · View", and *View* opens the page.

Agents still get every decision that applies, project-wide ones included.

## The project Decisions page

Each project has a **Project decisions** page that lists every project-wide decision, where you confirm, supersede and withdraw them, and *+ Record a decision* (its scope is the project). Open it from:

- the "also apply" line on a ticket or epic;
- **Project decisions** in the project switcher (with a project chosen);
- the "n decisions" link on each project in **Settings → Projects**;
- a Needs you card's *Open*.

*Needs your review* shows only agents' decisions you haven't confirmed yet; *All* shows everything.

## Yours and agents'

- **Owner** decisions are yours. They're authoritative: agents can't replace or withdraw them. An agent that disagrees has to ask you.
- **Agent** decisions are recorded by agents as they work. Another agent may replace one with a newer decision.

## Agents' project-wide decisions reach you

When an agent records a **project-wide** decision, it applies to every item, so it comes to **Needs you** as a card: "New project-wide decision by claude: …", with the text and the reason. On the card:

- *Confirm* makes it yours;
- *Withdraw…* retires it, with an optional reason;
- *Acknowledge* keeps it as the agent's decision without confirming it;
- *Open* shows it on the project Decisions page.

The card leaves Needs you once you confirm, withdraw, supersede or acknowledge the decision. Each action has *Undo*. Agents' project-wide decisions recorded before Docket asked for your review share one card per project, "3 project-wide decisions by agents to review", with *Review* (the page, filtered to *Needs your review*) and *Acknowledge all*.

Agents' decisions for an item, an epic or a label don't come to Needs you. You see them where they apply, and in the item's **Activity**.

## Reading a decision

Each decision shows its title, who recorded it and when, and the first two lines of its text.

- *Show all* expands a decision whose text is longer than two lines; *Show less* folds it again.
- *Show reasoning* shows why the decision was made, when whoever recorded it gave a reason. *Hide reasoning* folds it again.
- The chip next to the title is its scope (epic, label, this item, or this epic), and the badge says whether it's yours (**Owner**) or an agent's.

## What you can do

- *+ Record a decision*: fill in the title, the decision and (optionally) why, and pick the scope. What you record is an owner decision.
- *Confirm* on an agent's decision makes it yours, so agents can no longer change it.
- *Supersede* writes a new decision that replaces an old one. Both stay readable.
- *Withdraw…* retires a decision, with an optional reason. It stops going to agents but stays in history. A toast offers *Undo*.

*Show withdrawn and superseded* brings back the ones that no longer apply, greyed out.
