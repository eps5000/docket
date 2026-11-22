# Smoke checklist: Installed Codex CLI

Follow [README.md](README.md) "Before you start" first. Commands run from the repository root.

## Set up

1. [ ] Connected one of two ways (decision 32: local trust needs no token): from a trusted repo where
       Agent files → _Install_ wrote `.codex/config.toml`, or with `~/.codex/config.toml`
       (Windows: `%USERPROFILE%\.codex\config.toml`) holding:
   ```toml
   [mcp_servers.docket]
   url = "http://127.0.0.1:7420/mcp"
   ```
2. [ ] Protected mode only: the table also has `bearer_token_env_var = "DOCKET_TOKEN"`, and
       `DOCKET_TOKEN` is set in the terminal you start Codex from (Windows: `setx`, then a new terminal).
3. [ ] Start `codex` in any folder. `/mcp` lists `docket` with its tools.

## Run

1. [ ] `node docker/smoke/smoke.mjs prepare codex`, which prints a ticket ID and a prompt.
2. [ ] Paste the prompt into the client. It should call `whoami`, `claim_lead`, `set_plan`,
       `update_step` and `get_item`, and report the plan with the first step done.
3. [ ] `node docker/smoke/smoke.mjs check codex <ID>`: every line says PASS.
4. [ ] In the browser (unlock with `docker compose -p docket-smoke -f docker/compose.yaml -f docker/smoke/compose.smoke.yaml exec docket docket owner-key`):
   - [ ] **Agents** shows the client name and label on the ticket, with its run state.
   - [ ] **Settings → Connections** shows this surface last seen just now.
5. [ ] Tell the client to call `release_lead` on the ticket.

## Record

- [ ] PASS or FAIL for each `check` line, and the run state you saw (live or reported).
- [ ] Anything you had to change from the README to make it connect.
- [x] V6: measured in B48 on Codex 0.171.0: it shows the model `structuredContent` when there is one, so Docket sends it text-only results.
- [ ] V7: does Codex load skills from `~/.codex/skills/`?
