---
title: Connect an agent
summary: Give Claude Code, Codex or Orca workers the agent token and the MCP address, then check they show up.
group: Getting started
order: 1
anchors:
  - settings.clients
  - settings.client-setup
related:
  - agent-files
  - first-look-around
---

Agents talk to Task Lite over MCP at `http://127.0.0.1:7420/mcp`. They sign in with the **agent token**, which is different from the owner key you unlock this page with. Agents never get the owner key.

## 1. Put the token where your agents start

1. Open **Settings**. Under **Connections**, find the **Client setup** card.
2. Click *Reveal token*, then *Copy token*. The token hides again after 30 seconds.
3. Set it as `DOCKET_TOKEN` in the environment your agents start from:
   - macOS or Linux: add `export DOCKET_TOKEN="<token>"` to your shell profile, then open a new terminal.
   - Windows: run `setx DOCKET_TOKEN "<token>"`, then open a new terminal.

Don't add a trailing space or newline: it breaks sign-in.

## 2. Add Task Lite to the client

In **Client setup**, pick **Codex** or **Claude Code** and click *Copy*. The snippet uses `$DOCKET_TOKEN`, never the token itself.

- **Codex:** paste it into `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`). Codex reads the token from the environment each time it connects.
- **Claude Code:** run the command in a terminal. Your shell fills in the token, so Claude Code stores it; run the command again if you ever rotate the token.
- **Orca workers** start the Claude Code or Codex you installed, so they use the same setup as long as they inherit your user config and environment.

## 3. Check it

Ask the agent to call the `whoami` tool. Then look at the **Client compatibility** table in Settings → Connections: the client appears with *Last seen* just now.

The **Status** column says *Not verified* until someone runs the smoke test (claim, plan, log, read back). An unverified client still works. The **Results** column says whether the client reads structured results or text only.

## Next

- Give your agents the skills and the AGENTS.md block: [Agent files](/help/agent-files).
- See what to look at once they start: [Your first look around](/help/first-look-around).
