# Smoke checklist: Orca Claude worker

Follow the [safe disposable route](README.md#safe-disposable-route). This fourth surface
is **Not verified** by the DKT-10 pilot.

## Separate supervised Dispatch gate

1. [ ] The DKT-1 producer starts a separate supervised Claude Dispatch, after proving a
       task-only Claude process startup route. A standard Orca worker launch has no
       per-worker environment flag; it does not automatically isolate Claude or supply
       `CLAUDE_CONFIG_DIR`.
2. [ ] Record presence and SHA-256 hashes, without copies or contents, of default
       `~/.claude.json`, relevant user Claude auth/config, and project `.mcp.json`.
3. [ ] A task-only `CLAUDE_CONFIG_DIR` plus strict task-only MCP config pointing only to
       `http://127.0.0.2:7421/mcp` is a **candidate** that must be injected at process
       startup and verified on that Dispatch. **Stop if isolated auth is absent** or if
       invocation-scoped startup cannot be proven. Do not copy credentials or edit user or
       project MCP config.
4. [ ] Prove `whoami` and disposable item readback from the actual Claude worker process.
       A configured endpoint or inherited host setting is insufficient.

## Run and record, only after the gate

1. [ ] Run `node docker/smoke/smoke.mjs prepare orca-claude` with task-only
       `DOCKET_URL=http://127.0.0.2:7421` and retain the new item ID and prompt.
2. [ ] Give the prompt to that separately supervised worker. Capture `whoami`,
       `claim_lead`, a two-step plan, first step done, `get_item`, and `release_lead` with
       client identity, label, Orca Dispatch, and Docket run ID.
3. [ ] Run `node docker/smoke/smoke.mjs check orca-claude <item-id>` against the disposable
       URL and record each PASS/FAIL line.
4. [ ] Compare default hashes/presence with step 2. **Stop if `.claude.json` changes**;
       preserve both states for owner recovery instead of overwriting them.

Keep V1–V3/V6/V7 and Settings verification **Not verified** unless separately observed.
