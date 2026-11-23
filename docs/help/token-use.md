---
title: Token use
summary: What Docket measures from your local agent logs, what it never keeps, how tokens reach a ticket, and how to read the cost estimate.
group: Operations
order: 3
anchors:
  - settings.token-use
  - overview.token-use
  - item.token-use
related:
  - security-and-protected-mode
  - first-look-around
---

Docket can show how many tokens each ticket and epic used. It's **off** until you turn it on.

## Turning it on

Go to **Settings → Connections → Measure token use from local agent logs**. The note beside the switch says:

> Turn this on for more accurate token use per ticket and epic. To do this, a helper on this computer needs access to your local Codex and Claude Code session logs, which include your conversations with those agents. Docket doesn't use that content. The helper keeps only token counts, model, session ID, time and working folder, and nothing else is stored or sent. Turn this off at any time to stop reading the logs.

The status beside the switch is one of:

- **Off:** nothing is read. The helper doesn't open the log files at all.
- **On, but the helper isn't running:** the setting is on, and nothing is reading the logs. The helper is the `docket-sync` program on this computer.
- **On. Last read…:** the last time the helper checked in.

**Turning it off** stops reading on the helper's next cycle and does nothing else. Counts already collected stay in Docket, hidden, until you turn it back on or delete their project.

## What the helper keeps

Only token counts, model, session ID, time and working folder. It doesn't keep your messages, the agents' replies, tool output or file contents.

It sends nothing for a session whose working folder isn't a known workspace of a Docket project. A workspace is known when a run recorded it, or when you added it as a coordinator folder.

## How tokens reach a ticket

Docket never guesses.

- **Linked to a ticket:** the turn ran in a run's recorded workspace, during that run, and exactly one ticket matches.
- **Project overhead:** the session ran in a **coordinator folder**, which you list under the switch. Add the folders where your coordinator or heartbeat sessions run.
- **Not linked to a ticket:** the turn ran in a known workspace, but no single ticket matches. For example, it ran before the agent claimed the ticket, or two tickets shared the folder at that moment.

Overview shows what percentage of tokens is linked.

## Reading the numbers

Tokens come in four kinds, and Docket keeps them apart because their prices differ a lot:

- **New input:** what the model read at the full price.
- **Cache reads:** input reused from the cache, at a low price. This is usually most of the tokens.
- **Cache writes:** input stored in the cache for reuse.
- **Output:** what the model wrote.

**Tokens are measured. Dollars are an API-equivalent estimate:** what the same tokens would cost at the provider's published list price, from a dated price table in Docket. A subscription plan may cost less.

If a model has no sourced price, Docket shows its tokens and **Cost not available**. It never makes up a price. OpenAI lists two cache write prices and Codex logs don't say which applied, so Codex cache writes are left out of the estimate, and the page says how many tokens that covers.

You'll find token use on **Overview**, on a ticket or epic under **Details**, and in the **daily brief** under *What it cost*.
