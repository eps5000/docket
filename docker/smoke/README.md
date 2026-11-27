# Real-client smoke kit (O07)

Use this kit for one supervised pass per client surface. The owner checklist remains the
onboarding and acceptance record: [OWNER-CHECKLIST.md](OWNER-CHECKLIST.md). A smoke receipt
alone does not verify the Settings compatibility matrix or BUILD_SPEC §12 V1–V3/V6/V7.

| Surface | Checklist | Pilot evidence |
| --- | --- | --- |
| Installed Codex CLI | [codex.md](codex.md) | RCP-32: connection, claim, plan, step, six-PASS check, release |
| Installed Claude Code | [claude-code.md](claude-code.md) | RCP-33: the same receipts on a separate disposable ticket |
| Orca Codex worker | [orca-codex.md](orca-codex.md) | RCP-32 on another instance: the same receipts through the worker's direct MCP SDK route |
| Orca Claude worker | [orca-claude.md](orca-claude.md) | Not verified; requires its own supervised Claude Dispatch |

These are bounded DKT-10 pilot observations, not a four-surface pass. The historical
installed-client and Orca Codex runs used separate disposable instances; repeated RCP-32
identifies different disposable tickets. DKT-10 holds the separate installed-client
phase-one document and later Orca Codex worker evidence. Interactive
V1–V3/V6/V7 remain **Not verified** without direct observation. Record item and run IDs,
client identity, and each actual receipt for any new attempt.

## Safe disposable route

`smoke.mjs` defaults to `127.0.0.1:7420`, which may be the live Docket. The checked-in
`compose.smoke.yaml` also assumes that port. **Do not run the compose file or an older
checklist unchanged.** On this host, `127.0.0.1:7420` is live and `127.0.0.1:7421` is an
unrelated dev instance. Neither is a pilot destination or a cleanup target.

1. Read the identity, bindings, mounts, and health of both existing containers. Confirm
   exact `127.0.0.2:7421` is free and reachable on loopback. Choose a unique disposable
   container name and a unique named volume that do not already exist. Stop if any identity,
   port, or volume is uncertain. Do not substitute another address or port.
2. Run only a reviewed disposable image, with its own named volume mounted at `/data`,
   sample seed, **no host-code bind**, and only the exact host bind below. For example,
   replace all angle-bracket values with names and an image ID verified for this attempt:

   ```text
   docker volume create <unique-smoke-volume>
   docker run -d --name <unique-smoke-container> --mount type=volume,source=<unique-smoke-volume>,target=/data --publish 127.0.0.2:7421:7420 --env DOCKET_SEED=sample --env DOCKET_ALLOWED_HOSTS=127.0.0.2:7421,127.0.0.1:7420 <reviewed-image-id>
   ```

3. Inspect the new container ID, image, mount, exact published bind, and health. Read back
   only `http://127.0.0.2:7421`, then set `DOCKET_URL=http://127.0.0.2:7421` **in the task
   process only**. Confirm the smoke script's `preflight` reaches that instance before
   `prepare`; stop on a mismatch. Supply each client an invocation-scoped MCP route to
   `http://127.0.0.2:7421/mcp`. A config file alone is not proof of connection.
4. Record the existing container identities again afterward. Release only the disposable
   container and volume whose exact IDs and names you created and verified. Remove the
   container first, then its volume; stop if custody or identity has changed. Never use a
   broad compose `down`, host cleanup, or a cleanup command against the live or dev instance.

From the repository root, with the task process's `DOCKET_URL` set, use:

```text
node docker/smoke/smoke.mjs preflight
node docker/smoke/smoke.mjs prepare <surface>
node docker/smoke/smoke.mjs check <surface> <item-id>
```

`prepare` creates a new sample Ready item and prints a client prompt. `check` reads it back
and prints six PASS/FAIL lines. Surface names are `codex`, `claude`, `orca-codex`, and
`orca-claude`. The script does not print a token. Do not run `prepare`, `check`, or `pdf`
without proving the route is disposable first.

## Client configuration boundary

Before and after each attempt, record **hashes and presence only** for default user Codex
config/auth and Claude config/auth, plus relevant project MCP files. Do not copy, display,
edit, or restore credential or config files as part of this pilot. Stop and preserve evidence
for owner recovery if a default hash changes; do not overwrite a concurrent client's state.
Use only a task-specific profile with already available isolated auth and a task-only MCP
route. If isolated auth is absent, stop. See the surface checklists for the Codex and Claude
startup gates. A standard Orca worker launch has no per-worker environment flag and does not
automatically isolate Claude.

## Recording results

Keep connection, identity, claim, plan, first-step completion, readback, and release
receipts separate for each surface. Record V1–V3/V6/V7 only when actually observed; otherwise
write **Not verified**. Changes to `server/src/domain/compat.ts`, `docs/BUILD_SPEC.md`, or
T146 require their own pinned source scope, review, tests, PR/CI/queue/main gates, and owner
acceptance. This kit does not make those changes.
