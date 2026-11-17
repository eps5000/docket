# Real-client smoke kit (O07)

Run this by hand, once per client surface, to fill in the Settings compatibility matrix
(BUILD_SPEC §10 "Smoke test with real clients", §12 V1–V3, V6, V7; tasks.md T146).
Until a person has done it, every surface stays **Not verified** in Settings.

**Start with [OWNER-CHECKLIST.md](OWNER-CHECKLIST.md):** one pass of about 20 minutes over all
four surfaces, plus the PDF preview and an NVDA spot check. It lists what B18 already verified
unattended, so you only do the rest.

| Surface | Checklist |
|---|---|
| Installed Codex CLI | [codex.md](codex.md) |
| Installed Claude Code | [claude-code.md](claude-code.md) |
| An Orca worker running Codex | [orca-codex.md](orca-codex.md) |
| An Orca worker running Claude | [orca-claude.md](orca-claude.md) |

## What's here
- `smoke.mjs`: Node 22, no dependencies. `preflight` checks the service and your token;
  `prepare <surface>` makes a disposable ticket and prints the prompt to give the client;
  `check <surface> <ID>` reads the ticket back and prints PASS or FAIL for each step. It
  never prints the token.
- `compose.smoke.yaml`: a disposable instance with the sample data on its own volume,
  using your existing `TASKLITE_TOKEN`.
- One checklist per surface. Each one ends with what to record.
- `smoke.mjs pdf`: puts a one-page PDF on RCP-14, for the PDF preview check in Chrome.
- `eval/eval.mjs`: the skills eval (T148). It runs the US1 and US11 scenarios with installed
  Claude Code headless (`claude -p`), with and without the core skills, against a disposable
  instance, and prints calls, tokens and mistakes per run. It uses a temporary `--mcp-config`
  with `--strict-mcp-config` and `--setting-sources project`, so your client configuration is
  never read or changed. It resets the instance's data before each run, so point it only at a
  disposable one (TASKLITE_EVAL_CONTAINER, default `tasklite`).

## Before you start (once)
1. Set up each client as the [README quick start](../../README.md#quick-start) says
   (the snippets match Settings → Connections and MCP_SPEC §11).
2. Start the disposable instance, from the `docker/` folder. It uses the same port, so
   stop your real one first; its data stays in its own volume.
   ```bash
   docker compose stop tasklite
   docker compose -p tasklite-smoke -f compose.yaml -f smoke/compose.smoke.yaml up -d --build --wait
   ```
3. From the repository root: `node docker/smoke/smoke.mjs preflight`.

Surface names for the script: `codex`, `claude`, `orca-codex`, `orca-claude`.

## When you're done
```bash
docker compose -p tasklite-smoke -f compose.yaml -f smoke/compose.smoke.yaml down --volumes
docker compose start tasklite
```

## Recording the results
In one PR (T146):
- `server/src/domain/compat.ts`: for each surface that passed, set `verified` to the day and
  a short note (for example `{ on: 'Nov 20', notes: 'claim, plan, log, read back; run live' }`).
  A surface that can't connect stays unverified, with a note saying why. Settings shows
  "✓ Verified" only from this file.
- `docs/BUILD_SPEC.md` §12: what you saw for V1 (live or reported), V2 (Orca Claude worker
  inherits the config), V3 (Claude's user-scope `${}`), V6 (which result part reaches the
  model) and V7 (where each client loads skills).
