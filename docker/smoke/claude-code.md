# Smoke checklist: Installed Claude Code

Follow [README.md](README.md) "Before you start" first. Commands run from the repository root.

## Set up

1. [ ] Added at user scope, with your shell expanding the token (PowerShell: `$env:DOCKET_TOKEN`):
   ```bash
   claude mcp add --transport http --scope user tasklite http://127.0.0.1:7420/mcp \
     --header "Authorization: Bearer $DOCKET_TOKEN"
   ```
2. [ ] `claude mcp list` shows `tasklite … ✔ Connected`.
3. [ ] Start `claude` in any folder. `/mcp` shows `tasklite` connected.

## Run

1. [ ] `node docker/smoke/smoke.mjs prepare claude`, which prints a ticket ID and a prompt.
2. [ ] Paste the prompt into the client. It should call `whoami`, `claim_lead`, `set_plan`,
       `update_step` and `get_item`, and report the plan with the first step done.
3. [ ] `node docker/smoke/smoke.mjs check claude <ID>`: every line says PASS.
4. [ ] In the browser (unlock with `docker compose -p tasklite-smoke -f docker/compose.yaml -f docker/smoke/compose.smoke.yaml exec tasklite tasklite owner-key`):
   - [ ] **Agents** shows the client name and label on the ticket, with its run state.
   - [ ] **Settings → Connections** shows this surface last seen just now.
5. [ ] Tell the client to call `release_lead` on the ticket.

## Record

- [ ] PASS or FAIL for each `check` line, and the run state you saw (live or reported).
- [ ] Anything you had to change from the README to make it connect.
- [ ] V3: in a repo with a project `.mcp.json` using `${DOCKET_TOKEN}`, does it connect after you approve it? (User scope stores the expanded token; note that.)
- [ ] V6: B18 found (headless, 2.1.318) that the model gets `structuredContent` as JSON, not the text block. Confirm it's the same interactively: ask "Paste exactly what the last tool result gave you".
- [ ] V7: does Claude Code load skills from `~/.claude/skills/`?
