# Smoke checklist: An Orca worker running Codex

Follow [README.md](README.md) "Before you start" first. Commands run from the repository root.

## Set up

1. [ ] The Codex setup in [codex.md](codex.md) works on the host first.
2. [ ] Start an Orca worker running Codex, in any worktree, from the same user account.
3. [ ] Give the worker the prompt from `prepare`. Its label starts with `orca` so Settings counts it as an Orca worker.

## Run

1. [ ] `node docker/smoke/smoke.mjs prepare orca-codex`, which prints a ticket ID and a prompt.
2. [ ] Paste the prompt into the client. It should call `whoami`, `claim_lead`, `set_plan`,
       `update_step` and `get_item`, and report the plan with the first step done.
3. [ ] `node docker/smoke/smoke.mjs check orca-codex <ID>`: every line says PASS.
4. [ ] In the browser (unlock with `docker compose -p docket-smoke -f docker/compose.yaml -f docker/smoke/compose.smoke.yaml exec docket docket owner-key`):
   - [ ] **Agents** shows the client name and label on the ticket, with its run state.
   - [ ] **Settings → Connections** shows this surface last seen just now.
5. [ ] Tell the client to call `release_lead` on the ticket.

## Record

- [ ] PASS or FAIL for each `check` line, and the run state you saw (live or reported).
- [ ] Anything you had to change from the README to make it connect.
- [ ] The worker saw `DOCKET_TOKEN` and the user config without extra setup (verified in discovery; confirm).
- [ ] V7: does the worker see user-wide skills?
