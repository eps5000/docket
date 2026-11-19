---
title: Jira import
summary: Bring a Jira project into Docket in three steps, with a dry run first that shows exactly what will and won't come across.
group: Planning
order: 4
anchors:
  - jira.import
related:
  - the-checklist
  - blockers-and-dependencies
  - backups-restore-export
---

You can copy a Jira Cloud project into Docket once, to start from your existing work. It's a one-time import, not a sync: later changes in Jira don't come across.

## 1. Connect

Open the import from the Welcome page (before you have a project), from *What next* after creating a project, or with *Import from Jira…* at the bottom of **Settings → Projects**. Fill in:

- **Jira site:** just the site, like `https://yoursite.atlassian.net`, with no `/jira` and no path. If you paste a longer address (a board or an issue link), Docket keeps only the site and adds `https://` if it's missing;
- **Email** and **API token** for a Jira account that can see the project. The token is used for this import only and never saved. See "Getting the right token" below;
- **Jira project key**;
- **Import into:** a new project (give it a key and a name) or an existing project that's still empty.

Click *Run dry run*. It reads every issue but changes nothing. You can *Cancel* while it runs.

## Getting the right token

Atlassian has three kinds of credential. Only personal API tokens can read Jira:

- **Use a personal API token.** Go to id.atlassian.com → *Security* → *API tokens* (`https://id.atlassian.com/manage-profile/security/api-tokens`) and choose *Create API token*. The token must belong to the email you enter.
- **Tokens with scopes work too** (*Create API token with scopes*). Give them `read:jira-work` and `read:jira-user`. Atlassian only accepts these through its gateway, `api.atlassian.com`, so Docket finds your site's ID and goes through the gateway for the whole import. You don't need to do anything different.
- **Organization API keys don't work.** The keys from admin.atlassian.com (your organization → *API keys*) are for Atlassian's admin APIs only, such as managing users and policies. They can't read Jira projects or work items.

If signing in fails, the dialog says why:

- **"Site not found: check the URL"**: the address didn't answer as an Atlassian site. Check it's `https://yoursite.atlassian.net`.
- **"That looks like an organization API key"**: create a personal API token instead.
- **"Wrong email or API token"**: the token is wrong, revoked, or belongs to another Atlassian account than the email.
- **"Signed in, but this account can't browse that project"**: the account can't see the project, or a scoped token doesn't have the read scopes above.

Docket only ever contacts the site you enter and, for scoped tokens, `api.atlassian.com`.

## 2. Review the report

The report starts with a legend. Every issue is one of:

- **Imported as is:** comes across unchanged;
- **Imported with changes:** comes across, but something changes on the way;
- **Skipped:** not imported, with the reason.

Then:

- how many issues it found, and how many are imported as is, imported with changes, or skipped. The line under that says what the import creates: for example, "Imports 328 items and 57 checklist steps. Sub-tasks become checklist steps on their parent.";
- **Imported with changes**, grouped by reason. Each reason has a count and says what is kept and what isn't. For example:

  > **42 sub-tasks → checklist steps on their parent.** Kept: title, done or not done, description and dates (in the step’s details), comments (in a note on the parent). Not kept: attachments, labels and links on sub-tasks (each one lists what it had).

  Open a reason to see its issues, each with its own details;
- **Skipped**, grouped by reason. For example, a sub-task whose parent isn't in the import is skipped and listed here;
- **Mapping:** how Jira's types and statuses become Docket's;
- **Cycles found:** blocking loops in Jira's links. They're imported as they are and show under Problems, so you can fix them afterwards;
- **Fields used:** which Jira fields it read story points and dates from.

Fields Docket doesn't have (assignee, reporter, sprint, fix versions, components and other custom fields) aren't imported as fields. A sub-task's assignee is kept in its step's details. *By field* counts them.

*Download report (JSON)* saves it. Click *Back* to change the settings, or *Import n items and m checklist steps* to go ahead.

## 3. Import

The import shows its progress, then the result. Attachments are downloaded too, and any that fail are listed. A copy of the report is saved in the project's documents. Click *Open project* to switch to it and go to Work.

Imported items show an **Imported from Jira** chip, and searching for the Jira key finds them.

## What happens to sub-tasks

Each sub-task becomes a checklist step on its parent, in the parent's Work section:

- the step's text is the sub-task's title, and it's done, current or to do from the sub-task's status;
- its **source** is the sub-task's Jira key. In the step dialog the key links to the issue in Jira;
- its **details** start with a header line, for example `Jira GF-123 · assignee Sam Lee · start Nov 2, 2026 · due Dec 4, 2026 · 3 pts` (parts the sub-task didn't have are left out), then its description as Markdown. If the conversion simplified something, such as a panel, a last line says so. Descriptions follow the same rules as an item's: one that looks like a secret is left out, a very long one is shortened, and the report lists both.

Open a step's details from its title or its document icon (see [The checklist and step details](/help/the-checklist)).

The sub-tasks' **comments** are collected on the parent, in a note called **Comments from Jira sub-tasks**: one section per sub-task (`GF-123 Title`), each comment with its author and date. If they don't fit in one note, they continue in numbered notes ("(1 of 2)", "(2 of 2)"). You'll find the notes in the parent's Activity → History, and the agent that next reads the parent receives them, like any note you leave. Comments follow the same rules as the parent's own: ones that look like secrets are left out and listed in the report.

A sub-task's attachments, labels and links aren't imported; each sub-task in the report lists what it had. An import always goes into a new or empty project, so importing again never adds the notes twice.
