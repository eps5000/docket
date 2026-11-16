# Quickstart: run Task Lite V1 and validate each user story

For builders and reviewers. It assumes milestone M0 or later exists. The commands are the target
interface; the integration agent makes them true.

## 1. Start
```bash
cp docker/.env.example docker/.env            # optional: set TASKLITE_TOKEN; otherwise one is generated
docker compose -f docker/compose.yaml up -d
docker compose -f docker/compose.yaml exec tasklite tasklite seed sample   # disposable sample data (O09)
docker compose -f docker/compose.yaml exec tasklite tasklite owner-key     # paste into the browser's unlock screen
docker compose -f docker/compose.yaml exec tasklite tasklite agent-token   # for agent clients
```
Open `http://127.0.0.1:7420`, unlock, and you should land on **Needs you**, showing "3 for you".

## 2. Connect an agent
Set `TASKLITE_TOKEN` in your environment, then follow [MCP_SPEC §11](../../docs/MCP_SPEC.md):
- **Codex:** add the TOML block.
- **Claude Code:** run `claude mcp add --transport http --scope user tasklite http://127.0.0.1:7420/mcp --header "Authorization: Bearer $TASKLITE_TOKEN"`.

To check it worked, ask the agent to "call tasklite whoami". The client name should come back, and
Settings → Connections shows "Last seen: just now".

## 3. Run the tests
```bash
pnpm install
pnpm -r lint && pnpm -r typecheck
pnpm --filter server test              # unit + integration + MCP contract (incl. token budgets)
pnpm --filter web e2e                  # Playwright against a seeded container (+ axe)
```
CI runs the same on GitHub Actions (`.github/workflows/ci.yml`).

## 4. Validate each user story (manual, about 20 minutes)

| Story | Do this | Expect |
|---|---|---|
| **US1** coordinate | Agent: `search_items {filter:"ready_to_start"}` → `claim_lead` the top item → `get_context` → `set_plan` with 2 steps → `update_step` done ×2 → `report_commit` → `set_status done` | The item goes Ready → In progress → Done. A second client's `claim_lead` gets `conflict` naming the first. |
| **US1** leases | Claim an item, then stop calling for 30 min (or set `TASKLITE_STALE_AFTER=1m`, `TASKLITE_LEASE=2m`) | The run shows *stale*, then the item is back in Ready with its plan kept. Restarting the container turns open runs into *interrupted*. |
| **US2** visibility | Open Needs you, Work (Board, List, Map, Timeline), RCP-14 (all four tabs), Agents | "3 for you". Run states are in words. Provenance badges are distinct. The tab title shows `(3) Task Lite`. |
| **US2** notifications | Settings → This browser → turn notifications on; background the tab; have an agent `ask_owner` | One desktop notification. Clicking it opens the question. |
| **US3** review | Open RCP-12's packet: Needs changes on item 1 (note → checklist), Defer item 2 (follow-up ticket) → Send back | RCP-12 goes back to In progress with a new checklist step. A "Verify: …" task appears in Inbox. Undo restores everything. |
| **US4** dependencies | Settings → Recipe App → "Blockers clear when: PR merged" | Items behind done-but-unmerged blockers show "(needs merge)". `link_artifact {kind:"pr", state:"merged"}` clears it. Linking a cycle is refused with its path. |
| **US5** context and decisions | Agent: `get_context RCP-14`; `publish_decision` on epic RCP-1; owner *Confirm* in RCP-14 → Details → Decisions | The bundle stays within budget and includes `dec_1`. The new record shows "Agent", then "Owner" after confirming. An agent `withdraw_decision` on it gets `forbidden`. |
| **US6** steering | Answer DOC-4's question; leave a note on RCP-14; release RCP-15's stale claim | "Waiting for codex to read it" until `get_item`. The note is delivered once. The release dialog focuses Cancel, and RCP-15 goes back to Ready. |
| **US7** planning | + New "Low-stock alerts" in the Pantry epic; edit its outcome inline; move it to Ready; archive a Done card; cancel a junk Inbox item with ⋯ → Cancel item… | Inline save shows Undo, and agents see the new text in `get_context`. The archived item leaves the board but is found by search. The canceled item shows as Canceled in search, and Undo brings it back. |
| **US11** recovery | Two agents claim with `workspace` and `brief`; one `park_run {waiting_on:{items:["RCP-12"]}}`; the other declares a dev server with `heartbeat resources_started` and reports a commit without `pushed`; restart the container (or set `TASKLITE_ORPHAN_AFTER=1m`) | `recovery_report` lists one interrupted run (brief and workspace exact) and one parked run (still claimed, `resume_ready` once RCP-12 is done). Needs you shows *Orphaned resources* and *Unpushed work may be lost*. Agents → Workspaces never marks either *safe to prune*. |
| **US8** dates | Work → Timeline | Planned and actual bars, the date risk on RCP-16, and "No forecast yet: needs 8 completed items with effort (have 2)". |
| **US9** Jira | Settings → Import from Jira… against a test project | The dry-run report writes nothing. Import creates the items. The token isn't found anywhere (`grep -r` on `/data` and the logs). |
| **US10** operate | `docker compose down && up`; `tasklite backup now` (optionally with the extra backup folder mounted); restore into a scratch volume; delete a test project | Nothing is lost. The restore is identical. The deleted project's records and documents are gone, and the others are untouched. |

## 5. Done for V1
- Every user story row above passes.
- CI is green, including the token budgets and axe.
- The real-client smoke matrix (BUILD_SPEC §10) is filled in.
- `/speckit-analyze` reports no CRITICAL issues.
