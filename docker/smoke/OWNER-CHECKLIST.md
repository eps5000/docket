# Owner checklist: real clients, PDF preview and NVDA (about 20 minutes)

The checks that need you at the keyboard: your installed clients, your Orca workers, Chrome's
PDF viewer and a screen reader. B18 ran everything that could run unattended; its results are in
the first table, so you only do the rest. Tick each box, fill in the **Your result** column, and
then hand this file to an agent (or edit it yourself) to record the results (step 8).

All of this runs on a **disposable** instance with the sample data (its own container and volume).
Your real Task Lite and its data are never touched, and nothing here changes your client
configuration except the steps that say so (the README's own setup, which you'd do anyway).

## What B18 already verified (no action)

| Check                                                     | How                                                                                                                                                    | Result                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code connects and works the smoke ticket           | Installed Claude Code 2.1.318, **headless** (`claude -p`), with a temporary `--mcp-config` file (`--strict-mcp-config`), against a disposable instance | `smoke.mjs check claude`: all 6 PASS (open lead run, client `claude`, label `smoke-claude`, two-step plan, first step done, run `live`)                                                                                      |
| V3, part: `${TASKLITE_TOKEN}` expansion                   | The same temporary config used `"Authorization": "Bearer ${TASKLITE_TOKEN}"`; Claude Code expanded it from the environment                             | Works in an `--mcp-config` file (the `.mcp.json` format). User-scope expansion is still yours to check (step 2)                                                                                                              |
| V6 for Claude Code: what reaches the model                | The eval transcripts (stream-json)                                                                                                                     | **Claude Code gives the model `structuredContent` as JSON, not the text block.** About 3.5× the tokens of the compact text on typical reads (a 25-item search: 2,045 vs 325). Recorded in BUILD_SPEC §12; a decision for you |
| V7 for Claude Code, project path                          | The skills eval put the skills in the run folder's `.claude/skills/`                                                                                   | Claude Code loaded and invoked `tasklite-worker` and `tasklite-coordinator` headless                                                                                                                                         |
| V5: SQLite WAL on a Docker Desktop named volume (Windows) | A write loop against a disposable container                                                                                                            | Every write tool p50 ≈ 1 ms, p95 ≤ 5 ms in the container's call log                                                                                                                                                          |
| PDF preview                                               | Not possible headless                                                                                                                                  | **Yours: step 6**                                                                                                                                                                                                            |
| NVDA                                                      | Not possible headless                                                                                                                                  | **Yours: step 7**                                                                                                                                                                                                            |

## 0. Start the disposable instance (2 min)

From the repository root, in a terminal where `TASKLITE_TOKEN` is set (README step 3):

```bash
cd docker
docker compose stop tasklite        # your real instance, if it runs; its data stays put
docker compose -p tasklite-smoke -f compose.yaml -f smoke/compose.smoke.yaml up -d --build --wait
cd ..
node docker/smoke/smoke.mjs preflight
docker compose -p tasklite-smoke -f docker/compose.yaml -f docker/smoke/compose.smoke.yaml exec tasklite tasklite owner-key
```

- [ ] Preflight passed. Open <http://127.0.0.1:7420> in **Chrome** and unlock with the key.

## 1. Installed Codex CLI (4 min): V1, V6, V7

Follow [codex.md](codex.md): the TOML block from the README, then `prepare codex`, paste the
prompt into `codex`, and `check codex <ID>`.

| Check                                                                                                                                                                                               | Your result |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [ ] `check codex` lines all PASS                                                                                                                                                                    |             |
| [ ] **V1:** in Agents, the run state is _live_. Leave Codex idle for 3 minutes (the live window is 2), then reload: still _live_ (it keeps its session open and answers pings) or _reported_?       |             |
| [ ] **V6:** ask Codex "Paste exactly what the last tool result gave you." Does it show the plain text (lines like `RCP-31 · Ready · …`) or JSON (`{"item":…}`)?                                     |             |
| [ ] **V7:** copy `skills/tasklite-worker` to `~/.codex/skills/`, start a new `codex`, and ask "Which skills do you have?" Is `tasklite-worker` listed? (Remove it afterwards if you don't want it.) |             |

## 2. Installed Claude Code, interactive (4 min): V1, V3

Follow [claude-code.md](claude-code.md) with the README's **user-scope** `claude mcp add`
(this is your real setup step, not a test-only change).

| Check                                                                                                                                                                                                                                        | Your result |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [ ] `check claude` lines all PASS                                                                                                                                                                                                            |             |
| [ ] **V1:** as for Codex: idle 3 minutes in the open session, then reload Agents: _live_ or _reported_? (B18's headless run was _live_ only while it ran; an interactive session is what decides V1)                                         |             |
| [ ] **V3:** after `claude mcp add --scope user …`, does `~/.claude.json` hold the expanded token or `${TASKLITE_TOKEN}`? (Look, don't paste it anywhere.) The README tells you to re-run the command if you rotate the token; is that right? |             |

## 3. Orca worker running Claude (3 min): V2, V7

Follow [orca-claude.md](orca-claude.md): start a worker from the same user account, give it the
`prepare orca-claude` prompt, then `check orca-claude <ID>`.

| Check                                                                                                                            | Your result |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [ ] `check orca-claude` lines all PASS                                                                                           |             |
| [ ] **V2:** it connected with no extra setup (it inherited your user MCP config and `TASKLITE_TOKEN`)? If not, what did it need? |             |
| [ ] **V7:** with the skills in `~/.claude/skills/`, does the worker list `tasklite-worker`?                                      |             |

## 4. Orca worker running Codex (3 min)

Follow [orca-codex.md](orca-codex.md) the same way.

| Check                                                            | Your result |
| ---------------------------------------------------------------- | ----------- |
| [ ] `check orca-codex` lines all PASS                            |             |
| [ ] It inherited the user config and token (as discovery found)? |             |

## 5. The UI for the four runs (1 min)

- [ ] **Agents** shows each run with its client and label (`codex · smoke-codex`, `claude · smoke-claude`, `codex · orca-smoke-codex`, `claude · orca-smoke-claude`).
- [ ] **Settings → Connections** shows each surface as last seen just now (the matrix still says _Not verified_ until step 8 records it).

## 6. PDF preview in Chrome (1 min)

```bash
node docker/smoke/smoke.mjs pdf
```

- [ ] Open RCP-14 → Details → Documents → **pdf-preview-check.pdf**. The viewer shows one page
      reading "Task Lite PDF preview check" inside the dialog (Chrome's PDF viewer, sandboxed).
- [ ] **Download** saves the file.

## 7. NVDA spot check of the packet flow (4 min)

With NVDA running in Chrome:

- [ ] On **Needs you**, Tab to _Open packet_ on RCP-12. NVDA reads the card (title, round, "to verify").
- [ ] On the packet, NVDA reads the queue items, the heading "Your decision · round 2", and each
      decision control together with the item it decides (approve, needs changes, defer).
- [ ] Choose **Needs changes** on item 1: the note field is announced as required. Type a note.
- [ ] The submit button is announced as disabled until every item is decided, and its name says the outcome.
- [ ] Press Escape or go back; nothing is submitted. (No need to submit.)
- [ ] Anything NVDA read wrongly, or not at all: write it down.

## 8. Record the results

Hand this file, filled in, to an agent with "record the B18 owner checklist results", or edit:

- `server/src/domain/compat.ts`: for each surface whose `check` all passed, set
  `verified: { on: '<day>', notes: '<what passed; live or reported>' }`. Leave the others `null`
  with a note saying why. Settings shows "✓ Verified" only from this file.
- `docs/BUILD_SPEC.md` §12: the V1, V2, V3, V6 and V7 rows' results.
- `specs/001-task-lite-v1/tasks.md`: tick T146.

## 9. Clean up

```bash
cd docker
docker compose -p tasklite-smoke -f compose.yaml -f smoke/compose.smoke.yaml down --volumes
docker compose start tasklite        # your real instance
```
