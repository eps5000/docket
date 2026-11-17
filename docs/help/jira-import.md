---
title: Jira import
summary: Bring a Jira project into Task Lite in three steps, with a dry run first that shows exactly what will and won't come across.
group: Planning
order: 4
anchors:
  - jira.import
related:
  - blockers-and-dependencies
  - backups-restore-export
---

You can copy a Jira Cloud project into Task Lite once, to start from your existing work. It's a one-time import, not a sync: later changes in Jira don't come across.

## 1. Connect

In **Settings → Projects**, click *Import from Jira…* at the bottom. Fill in:

- **Jira site**, like `https://yoursite.atlassian.net`;
- **Email** and **API token** for a Jira account that can see the project. The token is used for this import only and never saved;
- **Jira project key**;
- **Import into:** a new project (give it a key and a name) or an existing project that's still empty.

Click *Run dry run*. It reads every issue but changes nothing. You can *Cancel* while it runs.

## 2. Review the report

The dry run shows:

- how many issues it found, would import, would skip, and would import with something lost;
- **Mapping:** how Jira's types and statuses become Task Lite's;
- **Lossy items:** issues that lose something on the way, and why;
- **Cycles found:** blocking loops in Jira's links. They're imported as they are and show under Problems, so you can fix them afterwards;
- **Fields used:** which Jira fields it read story points and dates from.

*Download report (JSON)* saves it. Click *Back* to change the settings, or *Import n items* to go ahead.

## 3. Import

The import shows its progress, then the result. Attachments are downloaded too, and any that fail are listed. A copy of the report is saved in the project's documents. Click *Open project* to switch to it and go to Work.

Imported items show an **Imported from Jira** chip, and searching for the Jira key finds them.
