# Smoke checklist: Orca Codex worker

Follow the [safe disposable route](README.md#safe-disposable-route). A normal Orca worker
may read default user settings; do not infer a safe MCP route from its launch alone.

## Supervised route

1. [ ] Pin an Orca Dispatch to this surface and record the worker's identity. Record
       presence and SHA-256 hashes of default Codex config/auth and project MCP files,
       without copying or printing their contents.
2. [ ] Give **that worker process** an explicit invocation-scoped MCP SDK endpoint,
       `http://127.0.0.2:7421/mcp`, or prove a task-only Codex startup with isolated auth.
       **Stop if isolated auth is absent** on the latter route. Never rely on inherited user
       config or a user/project MCP edit.
3. [ ] Have the worker call `whoami` and read the disposable item through the actual
       connection before counting this surface. Stop if it could have reached live Docket.

## Run and record

1. [ ] Run `node docker/smoke/smoke.mjs prepare orca-codex` with task-only
       `DOCKET_URL=http://127.0.0.2:7421` and retain the new item ID and prompt.
2. [ ] Give the prompt to the supervised worker. Capture `whoami`, `claim_lead`, a two-step
       plan, first step done, `get_item`, and `release_lead` with client identity, label,
       Orca Dispatch, and Docket run ID.
3. [ ] Run `node docker/smoke/smoke.mjs check orca-codex <item-id>` against the disposable
       URL and record each PASS/FAIL line.
4. [ ] Compare default hashes/presence with step 1. Stop on a change and preserve evidence
       for owner review; do not overwrite user or project files.

The DKT-10 Orca Codex worker pilot used a direct MCP SDK route in its own process and
observed connection/claim/plan/step/check/release on a disposable item. This is bounded
runtime evidence, not interactive V1–V3/V6/V7 or Settings acceptance. Those remain
**Not verified** without direct observation.
