---
title: Security and protected mode
summary: What local trust allows, what still keeps Docket private, how owner actions by scripts show up, and how to turn on protected mode.
group: Operations
order: 2
anchors:
  - settings.security
related:
  - connect-an-agent
  - backups-restore-export
---

Docket runs on your computer, for you. By default it uses **local trust**: anything running on this computer can use it, so there is no unlock step and agents need no token. **Protected mode** adds both back, for when you want a hard line between your agents and your own actions.

Settings → Connections → **Security** says which mode is on.

## What keeps Docket private in both modes

- Docket listens on `127.0.0.1` only, so other computers on your network can't reach it.
- Every request must name an allowed host (`127.0.0.1:7420` or `localhost:7420`), which stops websites that try to reach it through a DNS trick.
- A request from a web page on any other site is refused, so a website you visit can't read or change anything.
- Agents use MCP, and no MCP tool records your review decisions, answers questions as you, archives or deletes. Those stay owner actions.

## What local trust allows

Any program on this computer, including an agent's terminal, can call the owner API, for example with `curl`. Docket records how every owner action was made:

- from the browser, it shows as you (**owner**);
- from anything else, Activity shows **owner (script: curl/8.4.0)**, with the first part of the program's user agent.

So if an agent ever acts as you through the API, you can see it in the item's Activity.

## Turn on protected mode

1. In `docker/.env`, set `DOCKET_PROTECTED_MODE=on`.
2. Restart Docket: `docker compose -f docker/compose.yaml up -d`.
3. The browser now asks for the owner key once (30 days per browser). Print it with `docker compose exec docket docket owner-key`.
4. Agents now need the agent token. In Settings → Connections → Client setup, click *Reveal token*, then set it as `DOCKET_TOKEN` where your agents start (see [Connect an agent](/help/connect-an-agent)). The connection files Docket installs already read `DOCKET_TOKEN` from the environment once you reinstall them, and never contain the token itself.

In protected mode, Settings also offers *Lock this browser* and *Rotate owner key*, and only the browser with the owner session can make owner changes. Scripts and agents get "Docket is locked".

Agents can't switch the mode: it's a setting in `docker/.env`, with no button, route or tool that changes it. To go back, set `DOCKET_PROTECTED_MODE=off` and restart.
