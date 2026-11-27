# Smoke checklist: installed Codex CLI

Follow the [safe disposable route](README.md#safe-disposable-route) first. Run from the
repository root only after `DOCKET_URL=http://127.0.0.2:7421` and the exact disposable
instance have passed identity, health, and MCP readback checks.

## Invocation-scoped setup

1. [ ] Record presence and SHA-256 hashes, without contents or copies, of the default
       `~/.codex/config.toml`, `~/.codex/auth.json`, and any project `.codex/config.toml`.
2. [ ] Use a task-only `CODEX_HOME` with its own already authorized auth. **Stop if isolated
       auth is absent.** Do not copy default auth or config into it and do not install an MCP
       entry in user or project config.
3. [ ] Start Codex from that task process with an invocation-only `mcp_servers.docket.url`
       override set to `http://127.0.0.2:7421/mcp`. Verify `/mcp` and an actual `whoami`
       call reach the disposable instance before counting a connection. Stop if routing is
       uncertain.

## Run and record

1. [ ] Run `node docker/smoke/smoke.mjs prepare codex` in the task process and retain its
       new item ID and prompt.
2. [ ] Give the prompt to that isolated Codex invocation. Capture `whoami`, `claim_lead`, a
       two-step plan, first step done, `get_item`, and `release_lead` receipts with client
       identity and run ID.
3. [ ] Run `node docker/smoke/smoke.mjs check codex <item-id>` against the same disposable
       URL; record each PASS/FAIL line. Read Agents and Settings only if the owner performs
       those checks on the disposable instance.
4. [ ] Compare the default config/auth and project-file hashes/presence with step 1. **Stop**
       if any default config/auth hash changed; preserve both states for owner review rather
       than overwriting them.

The DKT-10 pilot observed the six connection/claim/plan/step/check/release receipts for an
installed Codex CLI on a separate disposable instance. That receipt does not settle
interactive V1, V6, V7, Settings verification, or owner acceptance; write **Not verified**
until directly checked.
