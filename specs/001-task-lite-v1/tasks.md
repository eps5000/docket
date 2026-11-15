---
description: "Dependency-ordered task list for Task Lite V1"
---

# Tasks: Task Lite V1

**Input**: Design documents in `specs/001-task-lite-v1/`: plan.md, spec.md, research.md, data-model.md, contracts/ and quickstart.md. The authoritative detail is in `docs/BUILD_SPEC.md`, `docs/MCP_SPEC.md` and `docs/UI_SPEC.md`.

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: REQUIRED (constitution Principle VII; BUILD_SPEC §10). Within each story, write the test tasks first and make sure they fail before implementing.

**Organization**: one phase per user story, in spec priority order. Each story phase is an independently testable increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story it serves (US1–US10)
- Paths follow plan.md: `shared/src/`, `server/src/`, `server/tests/`, `web/src/`, `web/e2e/`, `docker/`

## Phases and milestones

One PR per milestone, through the Mergify queue (constitution, Development Workflow):

| Phase | Story | Milestone (BUILD_SPEC §11) |
|---|---|---|
| 1 Setup | — | M0 |
| 2 Foundational | — | M1 (schema, events) + M2/M3 skeletons |
| 3 | US1 Agents coordinate (P1) 🎯 MVP | M1–M2 |
| 4 | US2 Owner visibility (P1) | M3–M4 |
| 5 | US3 Human review (P1) | M5 |
| 6 | US4 Dependencies (P2) | M6 |
| 7 | US5 Context and decisions (P2) | M2 + M4 |
| 8 | US6 Steering (P2) | M5 |
| 9 | US7 Planning and tidy-up (P2) | M5–M6 |
| 10 | US10 Operate safely (P2) | M7 + M8 |
| 11 | US8 Dates and forecast (P3) | M6–M7 |
| 12 | US9 Jira import (P3) | M7 |
| 13 Polish | — | M8 |

---

## Phase 1: Setup (shared infrastructure) · M0

**Purpose**: the workspace, tooling, container and CI.

- [ ] T001 Create the pnpm workspace with `shared/`, `server/` and `web/`, root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` (strict) and `.nvmrc` (22), per the plan.md structure
- [ ] T002 [P] Configure ESLint and Prettier, with lint and typecheck scripts at the root, in `eslint.config.js` and `.prettierrc`
- [ ] T003 [P] Set up Vitest in `server/vitest.config.ts` and `shared/vitest.config.ts`
- [ ] T004 [P] Set up Vite, React 19, React Router and TanStack Query in `web/`, with a placeholder route that renders "Task Lite is running"
- [ ] T005 [P] Copy the prototype's `.tl` token block (light, dark, `prefers-color-scheme`) unchanged into `web/src/styles/tokens.css` (UI_SPEC §3)
- [ ] T006 Write a multi-stage `docker/Dockerfile` (`node:22-bookworm-slim`, non-root user `tasklite`, uid 10001) and `docker/compose.yaml`: publish `127.0.0.1:7420:7420`, named volume `tasklite-data:/data`, `restart: unless-stopped`, healthcheck on `/healthz`. Add `docker/.env.example` with every variable in BUILD_SPEC §2 Configuration.
- [ ] T007 Create the server entry point `server/src/index.ts` serving `/healthz`, `/readyz` (database and docs dir writable, migrations current) and the web build, with SPA fallback
- [ ] T008 Create `.github/workflows/ci.yml` on `ubuntu-latest`: pnpm cache → lint → typecheck → Vitest → `docker build`. Name the job so the Mergify queue can require it.
- [ ] T009 [P] Set up Playwright in `web/playwright.config.ts`, with `@axe-core/playwright` and a fixture that starts the seeded container (wired into CI in T133)

**Checkpoint**: `docker compose up` serves "Task Lite is running", and CI is green.

---

## Phase 2: Foundational (blocking prerequisites) · M1 + adapter skeletons

**Purpose**: the schema, the single write path, events, identity and both adapters' skeletons. ⚠️ No story work starts until this phase is done.

### Tests first

- [ ] T010 [P] Unit tests for event appending, `version` conflicts and idempotency replay (same key and arguments → `replayed: true`; same key, different arguments → `validation`) in `server/tests/unit/write-path.test.ts`
- [ ] T011 [P] Unit tests for secret detection: Bearer values, PEM keys, and the `sk-`, `ghp_`, `github_pat_`, `xox` and `AKIA` prefixes, plus the service's own tokens. A rejected write is not stored and not logged (MCP_SPEC §3.4). In `shared/tests/secrets.test.ts`.
- [ ] T012 [P] Integration tests for the Host allowlist (421), Origin allowlist (403) and missing or wrong bearer token on `/mcp` (401), in `server/tests/integration/guards.test.ts`

### Implementation

- [ ] T013 [P] Define the shared enums, exactly as in BUILD_SPEC §13 and MCP_SPEC §3, in `shared/src/enums.ts`: status, type, priority, run state, provenance, `satisfied_when`, decision authority and status, event types, and the filters with their agent-query strings
- [ ] T014 [P] Define the error codes and `ToolError` in `shared/src/errors.ts`: `validation`, `conflict`, `not_found`, `forbidden`, `unavailable` and `internal`
- [ ] T015 [P] Implement the secret detector in `shared/src/secrets.ts` (makes T011 pass)
- [ ] T016 Write the Drizzle schema for every table in BUILD_SPEC §4 in `server/src/db/schema.ts`, including `review_decisions` and `decision_records`, `links.satisfied_when` and `projects.default_satisfied_when`. Quote the limits from data-model.md: title ≤ 200; Markdown fields ≤ 20,000; step, check and human review text ≤ 500; priority 1–3; effort ≥ 0; project key 2–5 uppercase letters; label name `a-z0-9-` ≤ 40; decision title ≤ 120 and decision ≤ 4,000.
- [ ] T017 Generate the first migration and the FTS5 `search_fts` table with sync triggers in `server/src/db/migrations/`
- [ ] T018 Open the database (WAL, `foreign_keys=ON`, `busy_timeout` 5 s) and a transaction helper using `BEGIN IMMEDIATE`, in `server/src/db/client.ts`
- [ ] T019 Implement the write path in `server/src/domain/write.ts`: one transaction per mutation, version checks returning `conflict` with `current`, event append with actor, mutation ID and `inverse`, idempotency store (24 h), and secret check on every text field (makes T010 pass)
- [ ] T020 [P] Implement ID allocation (`<KEY>-<n>` through `projects.next_seq` inside the transaction) and ULID-prefixed IDs (`wst_`, `chk_`, `hr_`, `run_`, `q_`, `lnk_`, `doc_`, `dv_`, `pkt_`, `dec_`) in `server/src/domain/ids.ts`
- [ ] T021 Implement the seed loader in `server/src/db/seed/loader.ts`. It maps `design/sample-data.json` per BUILD_SPEC §8: time shift, decision records `dec_1` to `dec_3`, and the `RCP-19 → RCP-16` link set to `merged`. Add the `tasklite seed sample` command and `TASKLITE_SEED=sample`.
- [ ] T022 Implement the config loader (every BUILD_SPEC §2 variable with its default) and secret bootstrap (generate `/data/secrets/agent-token` and `owner-key`, mode 0600) in `server/src/config.ts`
- [ ] T023 Implement the Host and Origin guards and bearer auth middleware in `server/src/api/guards.ts` (makes T012 pass)
- [ ] T024 Create the MCP server skeleton in `server/src/mcp/server.ts`: Streamable HTTP at `/mcp` with stateful sessions, server instructions loaded from `shared/src/mcp-copy.ts` (verbatim MCP_SPEC §2), and identity from `clientInfo` normalised (contains codex → `codex`; contains claude → `claude`)
- [ ] T025 Implement tool-registration helpers in `server/src/mcp/register.ts`: zod → JSON Schema; annotations per MCP_SPEC §3; structured errors as `isError` with `structuredContent`; every result carries `structuredContent` plus the compact text from `shared/src/compact.ts`; the one-line diagnostic call log (T21)
- [ ] T026 [P] Write the compact renderer framework and the item, list and mutation renderers per MCP_SPEC §3.1 in `shared/src/compact.ts`, with snapshot tests against the seed in `shared/tests/compact.test.ts`
- [ ] T027 Create the API skeleton in `server/src/api/app.ts`: Hono, zod validation, owner session middleware (stub until US10), CSRF double-submit, error mapping
- [ ] T028 Implement the SSE stream at `/api/stream` in `server/src/api/stream.ts`: `event: change`, `id: <seq>`, `data: {seq, type, objects, for_you}`, `Last-Event-ID` resume, a keep-alive comment every 25 s (contracts/events.md)
- [ ] T029 Implement owner undo in `server/src/domain/undo.ts` and the route `POST /api/mutations/:id/undo` in `server/src/api/routes/undo.ts`. Accept within 60 s if no later event touched the same objects (otherwise `conflict`); apply the stored `inverse`; record an `undo` event (FR-062, BUILD_SPEC §5.11). Unit tests in `server/tests/unit/undo.test.ts`.
- [ ] T030 Build the shared Toast-with-Undo plumbing (3.2 s, or 6 s with Undo; `role=status`; calls the undo route with the `mutation_id` from any owner mutation response) in `web/src/lib/undo.ts`
- [ ] T031 Build the web shell in `web/src/app/`: 220 px sidebar (Needs you, Work, Agents, Settings), header (breadcrumb, + New, search, theme), open-item tab strip (8 maximum), the routes from UI_SPEC §2, `sessionStorage` and `localStorage` persistence per UI_SPEC §2, the API client with CSRF, and an SSE hook that invalidates queries

**Checkpoint**: the seed loads deterministically, both adapters answer, and the shell renders.

---

## Phase 3: User Story 1 · Agents find, claim and complete work (P1) 🎯 MVP · M1–M2

**Goal**: agents coordinate the full no-review loop through MCP, with server-enforced claims and leases.

**Independent Test**: spec US1. A scripted MCP client claims, plans, checks, commits and closes, and a second client's claim gets `conflict`.

### Tests for US1

- [ ] T032 [P] [US1] Unit tests for the status transitions in BUILD_SPEC §5.1, including the resume claim, the Done gate with no review items, and "an epic reaches Done only when every child is Done or Canceled" (FR-005), in `server/tests/unit/status.test.ts`
- [ ] T033 [P] [US1] Unit tests for claims and leases in `server/tests/unit/claims.test.ts`: 100 concurrent claims → exactly 1 wins; lease expiry → run `interrupted` and item back to `ready` with the plan kept; restart sweep → all open runs `interrupted`
- [ ] T034 [P] [US1] Unit tests for displayed run state at the window edges (live 2 m, stale 30 m, signal kinds `session`, `report`, `relayed`) in `server/tests/unit/run-state.test.ts`
- [ ] T035 [P] [US1] Unit tests for plan and check patching in `server/tests/unit/checklist.test.ts`: patch never removes unlisted entries, replace removes agent entries only, owner entries are kept; maximum 30 steps and 30 checks
- [ ] T036 [P] [US1] MCP contract tests for flows §7.1, §7.2, §7.6 and §7.7; `get_changes` paging in order with no gaps, and an empty cursor returning the latest (FR-023); every error code reachable and well-formed (FR-026, MCP_SPEC §10 items 4 and 10); in `server/tests/contract/us1-coordinate.test.ts`
- [ ] T037 [P] [US1] MCP contract test: the `initialize` instructions and the snapshot of the tool names, descriptions and schemas match MCP_SPEC, in `server/tests/contract/snapshot.test.ts`
- [ ] T038 [P] [US1] Token-budget contract test (`get_item` standard ≤ 1,200, summary ≤ 300, `search_items` 25 results ≤ 1,000, mutations ≤ 60; fail above 120%), plus SC-001: `whoami` → `search_items ready_to_start` → `claim_lead` → `get_context` in ≤ 4 calls and ≤ 3,500 tokens of results in total, in `server/tests/contract/budgets.test.ts`

### Implementation for US1

- [ ] T039 [US1] Implement the item service (create, update with patch semantics, `add_labels`/`remove_labels`, `set_status` with guards and allowed-transition errors, dates with `dates_set_by`) in `server/src/domain/items.ts`
- [ ] T040 [US1] Implement claims and runs (`claim_lead` from ready or unclaimed progress, `release_lead`, `start_run`, `heartbeat`, `finish_run`, lease renewal on any `run_id` call, signal kinds by session match) in `server/src/domain/runs.ts`
- [ ] T041 [US1] Implement the sweeper (displayed-state re-derivation, lease expiry → interrupted and Ready, a ping every 60 s to sessions of open runs, the restart sweep at boot) in `server/src/jobs/sweeper.ts`
- [ ] T042 [US1] Implement the checklist service (`set_plan` patch and replace with versions and reasons, `update_step`, `log_subagent`, `set_checks`, `update_check`) in `server/src/domain/checklist.ts`
- [ ] T043 [P] [US1] Implement notes, artifacts and commits (`add_note`, `link_artifact`, `report_commit`, with repeat-SHA no-op) in `server/src/domain/evidence.ts`
- [ ] T044 [US1] Implement search and filters (`ready_to_start` sorted by priority then by how many items it unblocks; `resumable`, `blocked`, `waiting_for_review`, `mine`; `fields`, cursor pagination) in `server/src/domain/search.ts`
- [ ] T045 [US1] Register the MCP tools `whoami`, `list_projects`, `search_items`, `get_item` (`view`/`fields`), `create_item`, `update_item`, `set_status`, `claim_lead`, `release_lead`, `start_run`, `heartbeat`, `finish_run`, `set_plan`, `update_step`, `log_subagent`, `set_checks`, `update_check`, `add_note`, `link_artifact`, `report_commit` and `get_changes` in `server/src/mcp/tools/core.ts`, with descriptions from `shared/src/mcp-copy.ts`
- [ ] T046 [US1] Add the compact renderers for runs, checklist, search results and the change feed in `shared/src/compact.ts` (makes T038 pass)

**Checkpoint**: the US1 independent test passes with no UI. This is the MVP.

---

## Phase 4: User Story 2 · The owner sees what agents did and are doing (P1) · M3–M4

**Goal**: the supervision views, live updates and notifications.

**Independent Test**: spec US2. The questions in quickstart §4 for US2 can be answered from the UI alone, against the seed.

### Tests for US2

- [ ] T047 [P] [US2] API contract tests for `bootstrap`, `needs-you`, `work`, `items/:id`, `agents`, `search` and `stream` in `server/tests/integration/us2-api.test.ts`
- [ ] T048 [P] [US2] E2E: Needs you ("3 for you", only action cards, Problems actions), the four item tabs with counts and dots, scope reset to All projects, live update without moving focus; in `web/e2e/us2-visibility.spec.ts`
- [ ] T049 [P] [US2] E2E: notifications with permission granted in the context (one per new packet or question, a click opens the target, already-pending items don't notify, the tab title reads `(N) Task Lite`, and with permission denied the UI shows the "Blocked by the browser" status with no errors) in `web/e2e/us2-notifications.spec.ts`

### Implementation for US2

- [ ] T050 [US2] Implement the read-model queries for needs-you (for-you, problems, deferred, planning queue, agent counts), work (board, list), item detail and agents in `server/src/domain/views.ts`
- [ ] T051 [US2] Add the routes `GET /api/bootstrap`, `/api/needs-you`, `/api/work`, `/api/items/:id`, `/api/agents` and `/api/search` in `server/src/api/routes/read.ts`
- [ ] T052 [P] [US2] Build the shared components (Chip, TypeBadge/TypeIcon, RunState, Provenance, Priority, Label, EpicLink, Card, Section, ViewTabs, Toast, Dialog, EmptyState) per UI_SPEC §4–§5 in `web/src/components/`
- [ ] T053 [US2] Build the Needs you route (Agents strip, For you now, Problems, Deferred and Planning queue cards; empty states; one-screen at 1440×900) per UI_SPEC §6.1 in `web/src/routes/needs-you.tsx`
- [ ] T054 [US2] Build the Work route (filters with agent-query tooltips, Epics row, Board with Ready split and Review cards that open packets, List) per UI_SPEC §6.2.1–2 in `web/src/routes/work/`
- [ ] T055 [US2] Build the item page (header, banners, four tabs with counts and dots, Details sections, the Checklist tab read view, the Activity tab) per UI_SPEC §6.3 in `web/src/routes/items/`
- [ ] T056 [P] [US2] Build the Agents route per UI_SPEC §6.6 in `web/src/routes/agents.tsx`
- [ ] T057 [P] [US2] Build the command palette (items including archived and Jira keys, labels, views) in `web/src/components/CommandPalette.tsx`
- [ ] T058 [US2] Implement desktop notifications and the tab title (opt-in callout, Settings switch, one claiming tab per browser via `navigator.locks` or BroadcastChannel, dedupe by `seq` in `localStorage`, click routing) per UI_SPEC §6.7a in `web/src/lib/notifications.ts`
- [ ] T059 [US2] Implement focus preservation across live updates and the reconnecting and unreachable banners per UI_SPEC §7 in `web/src/lib/live.ts`

**Checkpoint**: the US2 independent test passes, and the US1 tests still pass.

---

## Phase 5: User Story 3 · The owner verifies finished work (P1) · M5

**Goal**: human review items, packets, owner decisions, staleness and deferrals.

**Independent Test**: spec US3. Approve one packet, send one back (a checklist step and a bug), defer with a follow-up, check every resulting state.

### Tests for US3

- [ ] T060 [P] [US3] Unit tests for the `submit_packet` guards (blocked, packet already open, nothing declared, a failing check without a gap) and the decision outcomes (approve all; any changes; defer with or without follow-up; mixed; approvals carry forward) in `server/tests/unit/review.test.ts`
- [ ] T061 [P] [US3] Unit tests for stale packets (ticket-level and epic-level), fresh-packet requests and deferred-list membership in `server/tests/unit/review-stale.test.ts`
- [ ] T062 [P] [US3] MCP contract tests for flows §7.3, §7.4 and §7.9 in `server/tests/contract/us3-review.test.ts`
- [ ] T063 [P] [US3] E2E for the packet screen (round selector, disabled submit, the note required for changes, outcome-named button, undo, past-round styling, attachments, 1024 px layout) in `web/e2e/us3-review.spec.ts`

### Implementation for US3

- [ ] T064 [US3] Implement the human review service (declare, update or remove the author's own items; locked while `ready`; agents get `forbidden` on owner-added items) in `server/src/domain/human-review.ts`
- [ ] T065 [US3] Implement the packet service (`submit_packet` with guards, content hash, snapshots, attachments; stale derivation; `get_review`; `deferred_reviews`) in `server/src/domain/packets.ts`
- [ ] T066 [US3] Implement owner decisions (atomic verdicts; changes → a checklist step with `from_review`, or a Bug in Ready with the parent's project, epic and priority, a title of up to 70 characters, and a `relates` link; defer → a follow-up Task in Inbox titled "Verify: …" (60 characters); the outcome; undo inverse) in `server/src/domain/review-decisions.ts`
- [ ] T067 [US3] Register the MCP tools `declare_human_review`, `update_human_review`, `submit_packet`, `get_review` and `deferred_reviews` in `server/src/mcp/tools/review.ts`
- [ ] T068 [US3] Add the routes `GET /api/review/:id`, `POST …/decisions`, `POST …/refresh` and `POST /api/deferred/:hrId/follow-up` in `server/src/api/routes/review.ts`
- [ ] T069 [US3] Build the packet screen (queue, packet, decision panel, Viewing group, narrow layout) per UI_SPEC §6.4 in `web/src/routes/review/`
- [ ] T070 [US3] Build the human review section in the Checklist tab (edit, remove and lock states, notes, *Open packet*) per UI_SPEC §6.3.1 in `web/src/routes/items/checklist/HumanReview.tsx`

**Checkpoint**: the US1–US3 tests pass. The P1 product is complete.

---

## Phase 6: User Story 4 · Dependencies decide what's ready (P2) · M6

**Goal**: links, blocker rules, cycles and the progress map.

**Independent Test**: spec US4. Link A → B → C, set the "PR merged" rule, report the merge, try a cycle.

### Tests for US4

- [ ] T071 [P] [US4] Unit tests for `satisfied_when`: done, merged and verified; the project default against a link override; verified on a blocker without review items → `validation`; verified with a deferred check → stays blocked plus a Problem; canceled blockers; an archived blocker is not cleared by archiving; re-evaluation and the event. In `server/tests/unit/dependencies.test.ts`.
- [ ] T072 [P] [US4] Unit tests for cycle rejection with the path, strongly connected components on imported data, and cross-project blocking in `server/tests/unit/cycles.test.ts`
- [ ] T073 [P] [US4] MCP contract test for flow §7.11 and `dependency_subgraph` with `delay_days` in `server/tests/contract/us4-deps.test.ts`
- [ ] T074 [P] [US4] E2E: the map (waves, outside column, arrows kept on resize and zoom, hover tracing, pan, Fit), the blocked chip "(needs merge)", the project rule select with undo, cycle fix from the Dependencies tab; in `web/e2e/us4-deps.spec.ts`

### Implementation for US4

- [ ] T075 [US4] Implement the link service (`link_items` that creates or updates `satisfied_when`, `unlink_items`, cycle DFS, strongly connected components, the cleared-blocker evaluation per data-model.md) in `server/src/domain/links.ts`
- [ ] T076 [US4] Implement `dependency_subgraph` (depth 1–5, direction, `date_source`, `at_risk` with `delay_days`) in `server/src/domain/subgraph.ts`
- [ ] T077 [US4] Register the MCP tools `link_items`, `unlink_items` and `dependency_subgraph` in `server/src/mcp/tools/deps.ts`
- [ ] T078 [US4] Add the routes `DELETE /api/links/:linkId` and `PATCH /api/projects/:key {default_satisfied_when}` in `server/src/api/routes/deps.ts`
- [ ] T079 [US4] Build the ProgressMap component (waves = longest blocks path; 200 px columns, 76 px gap, 16 px rows; canvas at most 540 px tall; zoom steps 50/67/80/100/125, Fit down to 40%; More pills; SVG arrows) per UI_SPEC §6.3.4 in `web/src/components/ProgressMap/`
- [ ] T080 [US4] Build the Dependencies tab (1-hop view with "waiting for merge/verification", cycle callout), the epic Map tab and Work → Map in `web/src/routes/items/deps/` and `web/src/routes/work/MapLayout.tsx`
- [ ] T081 [US4] Add the "Blockers clear when" select to Settings → Projects in `web/src/routes/settings/Projects.tsx`

---

## Phase 7: User Story 5 · Context in one call, and shared decisions (P2) · M2 + M4

**Goal**: `get_context` and decision records.

**Independent Test**: spec US5. Bundle contents and budget, decision scope inheritance, owner authority.

### Tests for US5

- [ ] T082 [P] [US5] Unit tests for the context bundle (section order, budgets of 1k/3k/8k, truncation markers, essentials and decisions never cut first, notes counted but not marked read) in `server/tests/unit/context.test.ts`
- [ ] T083 [P] [US5] Unit tests for decisions (scope inheritance from project to epic to label to item; agents forbidden on owner records; supersede and withdraw states; confirm) in `server/tests/unit/decisions.test.ts`
- [ ] T084 [P] [US5] MCP contract test for flow §7.10 and the `get_context` budget (RCP-14 medium ≤ 3,000) in `server/tests/contract/us5-context.test.ts`
- [ ] T085 [P] [US5] E2E: the Decisions section on a ticket (inherited scope chips, Confirm → "Owner", Withdraw with undo, Record form), on an epic and on a label, in `web/e2e/us5-decisions.spec.ts`

### Implementation for US5

- [ ] T086 [US5] Implement the decision service (publish, list with `in_scope_of`, withdraw, confirm, supersede, authority rules) in `server/src/domain/decisions.ts`
- [ ] T087 [US5] Implement the context bundle assembler per BUILD_SPEC §5.15 in `server/src/domain/context.ts`
- [ ] T088 [US5] Register the MCP tools `get_context`, `publish_decision`, `list_decisions` and `withdraw_decision`, with a compact bundle renderer, in `server/src/mcp/tools/context.ts`
- [ ] T089 [US5] Add the routes `GET/POST /api/decisions`, `POST …/:id/confirm` and `POST …/:id/withdraw` in `server/src/api/routes/decisions.ts`
- [ ] T090 [US5] Build the DecisionRow and Decisions section (authority badge, with no solid fill) per UI_SPEC §6.3.5 in `web/src/components/decisions/`

---

## Phase 8: User Story 6 · The owner steers without a review round (P2) · M5

**Goal**: questions, notes, releasing claims, Return to Ready, owner checklist entries.

**Independent Test**: spec US6.

### Tests for US6

- [ ] T091 [P] [US6] Unit tests for exactly-once delivery of answers and notes, one open question per item, and the run going to `needs_input` and back, in `server/tests/unit/messages.test.ts`
- [ ] T092 [P] [US6] MCP contract test for flow §7.5 and an old `run_id` after release returning `conflict`, in `server/tests/contract/us6-steer.test.ts`
- [ ] T093 [P] [US6] E2E: inline answer, note logged, the release dialog focusing Cancel with undo, Return to Ready, owner adds and removes a work step and a check, in `web/e2e/us6-steer.spec.ts`

### Implementation for US6

- [ ] T094 [US6] Implement questions and owner notes (`ask_owner`, answer, delivery marking in `get_item`) in `server/src/domain/messages.ts`
- [ ] T095 [US6] Register the MCP tool `ask_owner`, and wire delivery into `get_item` (standard and full views only), in `server/src/mcp/tools/messages.ts`
- [ ] T096 [US6] Add the routes `POST /api/items/:id/answer`, `/notes`, `/release`, `/return-to-ready` and the owner work, check and human-review endpoints in `server/src/api/routes/steer.ts`
- [ ] T097 [US6] Build the Lead and runs section (conflict callout, error output, release dialog, Return to Ready), the History note box, and the checklist add rows, per UI_SPEC §6.3.1–2, in `web/src/routes/items/activity/` and `web/src/routes/items/checklist/`
- [ ] T098 [US6] Build the inline answer in Needs you and the question banner on items in `web/src/components/QuestionReply.tsx`

---

## Phase 9: User Story 7 · Planning and keeping things tidy (P2) · M5–M6

**Goal**: quick capture, Planning to Ready, labels, archive, documents, inline text editing.

**Independent Test**: spec US7.

### Tests for US7

- [ ] T099 [P] [US7] Unit tests for the archive guards (done only), archived items excluded from owner views but included in agent queries, and owner text edits (limits, secret check, version conflict, undo) in `server/tests/unit/planning.test.ts`
- [ ] T100 [P] [US7] E2E: quick capture (title required, lands in Inbox; from an epic you stay on the epic), label page Move N to Ready with undo, Archive and Archive all with undo, the Archived filter, the "+ N archived" fold, the document viewer, inline edit with the conflict callout; in `web/e2e/us7-planning.spec.ts`

### Implementation for US7

- [ ] T101 [US7] Implement the documents service (put a version, immutable, sha256, 25 MB through MCP, the `/agent-upload` multipart endpoint up to 500 MB, preview MIME handling, `Content-Disposition` and `nosniff`) in `server/src/domain/documents.ts` and `server/src/api/routes/upload.ts`
- [ ] T102 [US7] Register the MCP tools `put_document` and `upsert_label` in `server/src/mcp/tools/planning.ts`
- [ ] T103 [US7] Add the routes `POST /api/items`, `PATCH /api/items/:id` (priority, status, and title, `description_md`, `outcome_md`, `acceptance[]` with `expected_version`), archive/unarchive/`archive {ids}`, labels and move-to-ready, and document content, in `server/src/api/routes/planning.ts`
- [ ] T104 [US7] Build quick capture and the + New item in this epic dialog per UI_SPEC §6.9 in `web/src/components/QuickCapture.tsx`
- [ ] T105 [US7] Build inline editing (title, description, outcome, acceptance; Preview; `Ctrl+Enter`/`Esc`; conflict callout; counters) per UI_SPEC §6.3 "Inline editing" in `web/src/routes/items/details/InlineEdit.tsx`
- [ ] T106 [US7] Build the Done column Archive and Archive all actions, the Archived filter, and the epic fold-up, in `web/src/routes/work/` and `web/src/routes/items/details/Tickets.tsx`
- [ ] T107 [P] [US7] Build the Label page per UI_SPEC §6.5 in `web/src/routes/labels.tsx`
- [ ] T108 [P] [US7] Build the document viewer and Checklist history dialogs per UI_SPEC §6.9 in `web/src/components/DocumentViewer.tsx` and `PlanHistory.tsx`

---

## Phase 10: User Story 10 · Running Task Lite safely (P2) · M7 + M8

**Goal**: owner session, backups and restore, project deletion, diagnostic log, the connection guide.

**Independent Test**: spec US10. Clean machine to connected agent, container replacement, restore drill, delete project.

### Tests for US10

- [ ] T109 [P] [US10] Integration tests for unlock and lock, CSRF required on mutations, key rotation ending sessions, and agents' token rejected on `/api`, in `server/tests/integration/us10-session.test.ts`
- [ ] T110 [P] [US10] Integration tests in `server/tests/integration/us10-ops.test.ts`: a backup restored into a temporary data directory is identical, with an item, event and document checksum comparison; a project delete removes its rows and docs directory, and the tombstone is retried at startup; the diagnostic log contains no arguments, and no log contains an `Authorization` value; a deleted project's item IDs return `not_found` to agents; and replacing the container (`docker compose down && up` in the CI Docker job) keeps every item, event and document (SC-008)
- [ ] T111 [P] [US10] E2E: unlock screen, Settings (projects, connections, snippets showing `$TASKLITE_TOKEN`, Reveal token auto-hiding after 30 s, the delete dialog with typed key and focus on Cancel, *Download diagnostic log*), in `web/e2e/us10-settings.spec.ts`

### Implementation for US10

- [ ] T112 [US10] Implement owner sessions (`/api/session/unlock` and `/lock`, HttpOnly SameSite=Strict cookie, 30-day sliding expiry, rotate key) in `server/src/api/session.ts`
- [ ] T113 [US10] Implement the nightly backup (`VACUUM INTO` plus a docs tar.gz, retention `BACKUP_KEEP`) and the CLI commands `backup now`, `restore <file>` (refuses while running; verifies first), `owner-key` and `agent-token`, in `server/src/jobs/backup.ts` and `server/src/cli/index.ts`
- [ ] T114 [US10] Implement project delete (transaction plus tombstone, docs removal after commit, retry at startup) in `server/src/domain/projects.ts`
- [ ] T115 [US10] Implement the call log (`/data/logs/calls-YYYYMMDD.jsonl`, rotated daily, kept 7 days) and `GET /api/diagnostics/calls` in `server/src/jobs/logs.ts` and `server/src/api/routes/diagnostics.ts`
- [ ] T116 [US10] Build the Unlock route and Settings (Projects, Connections with the compatibility matrix and snippets, Endpoint, Service health, This browser) per UI_SPEC §6.7–6.8 in `web/src/routes/settings/` and `web/src/routes/unlock.tsx`
- [ ] T117 [US10] Write the README quick start (clean machine to connected agent in ≤ 10 minutes) and `docker/smoke/` (a script and checklist per client surface, O07) in `README.md` and `docker/smoke/`

---

## Phase 11: User Story 8 · Dates, effort and a forecast (P3) · M6–M7

**Goal**: the Timeline layout, burn-down and forecast.

**Independent Test**: spec US8.

### Tests for US8

- [ ] T118 [P] [US8] Unit tests in `server/tests/unit/forecast.test.ts`: date risk; burn-down replay from events, with scope additions and the unestimated count; forecast thresholds (≥ 8 estimated items done in the last 4 weeks, across ≥ 2 weeks); Monte Carlo P50/P85 deterministic with a seeded RNG; planned dates unchanged
- [ ] T119 [P] [US8] E2E: Timeline (planned and actual bars, set-by only on hover, blocker ticks, risk text, undated list, forecast lane), the burn-down card with *Show as table*, in `web/e2e/us8-timeline.spec.ts`

### Implementation for US8

- [ ] T120 [US8] Implement the timeline query, burn-down and forecast in `server/src/domain/forecast.ts`, with `GET /api/work?layout=timeline` and `GET /api/burndown`
- [ ] T121 [US8] Build the Timeline layout and the burn-down card per UI_SPEC §6.2.4 and §9.1 in `web/src/routes/work/TimelineLayout.tsx` and `BurndownCard.tsx`

---

## Phase 12: User Story 9 · Jira import with a dry run (P3) · M7

**Goal**: import from Jira Cloud after reviewing a report.

**Independent Test**: spec US9, against a recorded fixture of a small Jira project.

### Tests for US9

- [ ] T122 [P] [US9] Unit tests for every mapping row in BUILD_SPEC §9 (types, status categories, priorities, links, ADF to Markdown losses, sub-tasks as work steps, field detection), using recorded Jira responses in `server/tests/fixtures/jira/`, in `server/tests/unit/jira-map.test.ts`
- [ ] T123 [P] [US9] Integration test: the dry run writes nothing; the commit is atomic; the token appears nowhere in the database, logs, report or events (grep the data dir); a recorded 500-issue fixture dry-runs in under 2 minutes and accounts for 100% of issues (SC-011); in `server/tests/integration/us9-jira.test.ts`

### Implementation for US9

- [ ] T124 [US9] Implement the Jira client (REST v3 search and pagination, links, comments, attachment metadata and download, honouring `Retry-After`; the token held in memory, expiring after 1 h or on cancel) in `server/src/import/jira/client.ts`
- [ ] T125 [US9] Implement the mapper and report builder in `server/src/import/jira/mapper.ts` and `report.ts`
- [ ] T126 [US9] Implement the commit (one transaction, `jira_key`, `imported`, post-commit attachment download, the report stored as an `import_report` document) and the routes, in `server/src/import/jira/commit.ts` and `server/src/api/routes/import.ts`
- [ ] T127 [US9] Build the three-step Import dialog per UI_SPEC §9.2 in `web/src/routes/settings/JiraImport.tsx`

---

## Phase 13: Polish and cross-cutting · M8

- [ ] T128 [P] Accessibility: run the axe suite on every route in both themes; keyboard paths (skip link, tabs pattern, map canvas arrows, dialogs); NVDA spot check of the packet flow. In `web/e2e/a11y.spec.ts`.
- [ ] T129 [P] Performance check at scale (generate 20 projects, 5,000 items and 100,000 events): owner views under 1 s, agent calls p95 under 500 ms (SC-013), in `server/tests/perf/scale.test.ts` (run on demand, not in every CI run)
- [ ] T130 [P] Write the reduced-motion and 1024×900 layout checks (the packet decision panel under the queue) in `web/e2e/layout.spec.ts`
- [ ] T131 Run the real-client smoke test (installed Codex, installed Claude Code, an Orca worker running Codex, an Orca worker running Claude), fill in the Settings compatibility matrix, and resolve the BUILD_SPEC §12 verifications V1–V3 and V6 (record findings in BUILD_SPEC §12)
- [ ] T132 Stretch: add `tasklite export` (full JSON plus documents) in `server/src/cli/export.ts`. It is required before the pilot (ROADMAP §1).
- [ ] T133 Wire the Playwright end-to-end tests into `.github/workflows/ci.yml` (from M4), uploading the report and traces as artifacts on failure
- [ ] T134 Run the quickstart.md validation end to end, and run `/speckit-analyze` until there are no CRITICAL findings

---

## Dependencies and execution order

### Phase dependencies
- **Setup (1)** comes first. **Foundational (2)** depends on Setup and blocks every story.
- **US1 (3)** depends only on Foundational. It's the MVP.
- **US2 (4)** depends on Foundational. It can be built alongside US1, but its tests use the seed, so it's best after US1 for realistic runs.
- **US3 (5)** depends on US1 (items, runs, commits). Its UI depends on US2 (item page shell).
- **US4 (6)** depends on US1. The map UI depends on US2.
- **US5 (7)** depends on US1 (items, epics, labels). Its UI depends on US2.
- **US6 (8)** depends on US1 and US2.
- **US7 (9)** depends on US2. Inline editing reuses the US1 item service.
- **US10 (10)** can start after Foundational. Its owner session (T112) replaces the stub in T027 and should land before US2's UI is used outside tests.
- **US8 (11)** depends on US1 and US4 (blocker dates).
- **US9 (12)** depends on US1, US4 and US7 (documents).
- **Polish (13)** comes after the stories being shipped.

### Within each story
Tests (failing) → domain services → MCP tool registration and API routes → UI → story checkpoint.

### Parallel opportunities
- **Setup:** T002–T005 and T009.
- **Foundational:** tests T010–T012; then T013–T015, T020 and T026 alongside the schema work.
- **After Foundational:** one developer on US1 (server), another on US2 (UI shell and components) and US10 (session, backup).
- **Within stories:** every task marked [P], especially the test files.

### Parallel example: User Story 1
```text
Together: T032 status tests · T033 claims tests · T034 run-state tests · T035 checklist tests · T036–T038 contract tests
Then:     T039 items → T040 runs → T041 sweeper; in parallel T042 checklist, T043 evidence
Then:     T044 search → T045 tool registration → T046 renderers (budgets green)
```

## Implementation strategy

1. **MVP first:** Setup → Foundational → US1. Stop, validate with a real agent client (quickstart §2 and the US1 row), and demo.
2. **P1 complete:** add US2 (visibility, notifications) and US3 (review). This is the first owner-usable release (M5).
3. **P2:** US4 dependencies → US5 context and decisions → US6 steering → US7 planning → US10 operations, in that order, each behind green CI.
4. **P3:** US8 forecast and US9 Jira import, needed before the pilot.
5. **Polish, then the pilot checklist** (ROADMAP §1). Track Task Lite's own remaining milestones in Task Lite from M4 onward.
