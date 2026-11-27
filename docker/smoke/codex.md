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
       override set to `http://127.0.0.2:7421/mcp`. Verify the task-only route and
       disposable preflight; make the client's actual `whoami` call after `prepare` below.
       Stop if routing is uncertain.

## Run and record

1. [ ] Run `node docker/smoke/smoke.mjs prepare codex` in the task process and retain its
       new item ID and prompt.
2. [ ] Give the prompt to that isolated Codex invocation. Capture the actual connection and
       `whoami`, `claim_lead`, a two-step plan, first step done, and `get_item` with client
       identity and run ID. **Keep this sample lead open.**
3. [ ] While the sample lead is still open and its run is live or reported, run
       `node docker/smoke/smoke.mjs check codex <item-id>` against the same disposable URL.
       Record each PASS/FAIL line honestly, including any FAIL. Read Agents and Settings
       only if the owner performs those checks on the disposable instance.
4. [ ] After `check`, call `release_lead` only for this exact sample lead if it is still
       yours; retain the release receipt. Do not release another lead after a FAIL.
5. [ ] Compare the default config/auth and project-file hashes/presence with step 1, then
       follow the README's post-resource identity checks. **Stop** if any default
       config/auth hash changed; preserve both states for owner review rather than
       overwriting them.

The DKT-10 pilot observed the six connection/claim/plan/step/check/release receipts for an
installed Codex CLI on a separate disposable instance. That receipt does not settle
interactive V1, V6, V7, Settings verification, or owner acceptance; write **Not verified**
until directly checked.
