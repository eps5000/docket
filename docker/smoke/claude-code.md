# Smoke checklist: installed Claude Code

Follow the [safe disposable route](README.md#safe-disposable-route) first. Run from the
repository root only after `DOCKET_URL=http://127.0.0.2:7421` and the exact disposable
instance have passed identity, health, and MCP readback checks.

## Invocation-scoped setup

1. [ ] Record presence and SHA-256 hashes, without contents or copies, of the default
       `~/.claude.json`, relevant user Claude auth/config files, and project `.mcp.json`.
2. [ ] A task-only `CLAUDE_CONFIG_DIR` with strict task-only MCP configuration is a
       **candidate**, not a proven isolation guarantee. It must be set at Claude process
       startup, with an MCP file containing only the disposable
       `http://127.0.0.2:7421/mcp` route and strict MCP loading enabled. **Stop if isolated
       auth is absent.** Never copy the default auth/config or add a user/project MCP entry.
3. [ ] Verify the task-only startup route and disposable preflight. Make the running
       client's actual `whoami` and item readback after `prepare` below; a config file or
       `mcp list` entry by itself is not a connection receipt. Stop if routing or startup
       isolation cannot be proven.

## Run and record

1. [ ] Run `node docker/smoke/smoke.mjs prepare claude` in the task process and retain its
       new item ID and prompt.
2. [ ] Give the prompt to the isolated Claude invocation. Capture the actual connection and
       `whoami`, `claim_lead`, a two-step plan, first step done, and `get_item` with client
       identity and run ID. **Keep this sample lead open.**
3. [ ] While the sample lead is still open and its run is live or reported, run
       `node docker/smoke/smoke.mjs check claude <item-id>` against the same disposable URL.
       Record each PASS/FAIL line honestly, including any FAIL. Read Agents and Settings
       only if the owner performs those checks on the disposable instance.
4. [ ] After `check`, call `release_lead` only for this exact sample lead if it is still
       yours; retain the release receipt. Do not release another lead after a FAIL.
5. [ ] Compare default and project config/auth hashes/presence with step 1, then follow the
       README's post-resource identity checks. **Stop if the default `.claude.json` hash
       changes.** Preserve both states for owner review rather than restoring or
       overwriting them.

The DKT-10 pilot observed the six connection/claim/plan/step/check/release receipts for
installed Claude Code on a separate disposable instance. Its default `.claude.json` changed
during that attempt and remains an owner-review concern. The receipt does not settle
interactive V1, user-scope V3, V6, V7, Settings verification, or owner acceptance; write
**Not verified** until directly checked.
