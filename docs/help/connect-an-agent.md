---
title: Connect an agent
summary: Install the agent files into a repo, approve Docket once in Claude Code or Codex, then check they show up. No token by default.
group: Getting started
order: 1
anchors:
  - settings.clients
  - settings.client-setup
related:
  - agent-files
  - security-and-protected-mode
  - first-look-around
---

Agents talk to Docket over MCP at `http://127.0.0.1:7420/mcp`. By default Docket uses **local trust**: anything on this computer can connect, so there's no token to copy and nothing to type. (Websites and other computers still can't reach it. For a token and an unlock step, see [Security and protected mode](/help/security-and-protected-mode).)

## 1. Install the agent files into the repo

Open **Agent files**, pick the project in the project switcher, and click the project's *Install into … repo* button, then pick **Claude Code** or **Codex**. Run the command it gives you in the repo folder, or let Docket write the files itself if you've set up one-click install.

Besides the skills and the AGENTS.md block, this writes the repo's **connection file**:

- Claude Code: `.mcp.json`, with a `docket` server;
- Codex: `.codex/config.toml`, with a `[mcp_servers.docket]` table.

Only the `docket` entry is added or updated. Other servers and settings in the file stay as they are, and the file never holds a token, so you can commit it. If the file isn't valid JSON or TOML, the install stops and writes nothing; fix the file and install again.

## 2. Approve Docket in the client, once

Open the client in the repo:

- **Claude Code** finds the new `docket` server in `.mcp.json` and asks whether to use it. Approve it. `/mcp` then shows `docket` connected.
- **Codex** asks whether to trust the folder. Trust it, and it reads `.codex/config.toml`.
- **Orca workers** start the Claude Code or Codex you installed, in the repo, so they pick up the same files.

Headless runs: `claude -p` uses the project's servers without asking; `codex exec` reads the project's file only once the folder is trusted, so open Codex there once first.

## 3. Check it

Ask the agent to call the `whoami` tool. Then look at the **Client compatibility** table in Settings → Connections: the client appears with *Last seen* just now.

The **Status** column says *Not verified* until someone runs the smoke test (claim, plan, log, read back). An unverified client still works. The **Results** column says whether the client reads structured results or text only.

## Every repo at once (optional)

To connect a client for all your repos instead, use **Client setup** in Settings → Connections: pick **Codex** or **Claude Code** and click *Copy*.

- **Codex:** paste it into `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`).
- **Claude Code:** run the command in a terminal.

Set up before the rename? Rename your MCP server entry from tasklite to docket. The URL is unchanged, so the old entry keeps working until you do.

## In protected mode

Agents need the agent token. In **Client setup**, click *Reveal token*, then *Copy token* (it hides again after 30 seconds), and set it as `DOCKET_TOKEN` where your agents start (macOS or Linux: `export DOCKET_TOKEN="<token>"` in your shell profile; Windows: `setx DOCKET_TOKEN "<token>"`; then open a new terminal). Install the agent files again: the connection files then read `DOCKET_TOKEN` from the environment, never the token itself.

## Next

- Give your agents the skills and the AGENTS.md block: [Agent files](/help/agent-files).
- See what to look at once they start: [Your first look around](/help/first-look-around).
