---
description: "Dependency-ordered task list for Task Lite V1 (contracts first, then slices)"
---

# Tasks: Task Lite V1

**Input**: Design documents in `specs/001-task-lite-v1/`: plan.md, spec.md, research.md, data-model.md, contracts/ and quickstart.md. The authoritative detail is in `docs/BUILD_SPEC.md`, `docs/MCP_SPEC.md` and `docs/UI_SPEC.md`.

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: REQUIRED (constitution Principle VII; BUILD_SPEC §10). Within each phase, write the test tasks first and make sure they fail before implementing.

**Organization: contracts first, then slices** (constitution, Development Workflow).
1. **Phases 1–3 build everything cross-cutting:** setup, the platform (write path, auth, events), and the whole contract surface:
   - every MCP tool's schema, description and renderer, with all 38 tools registered as stubs (36 from 3a, plus `park_run` and `recovery_report` from 3r);
   - every API route with schema validation and a placeholder handler;
   - domain service signatures;
   - the typed client;
   - the UI kit, and every screen as a shell;
   - the test harnesses.
2. **Phases 4–13 (with 6r) are user-story slices.** A slice only fills in its own handlers, services and screen content.
3. **A slice MUST NOT change a shared contract file** (see Slice rules). If it needs one, a separate contract PR goes first.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story it serves (US1–US11)
- Paths follow plan.md: `shared/src/`, `server/src/`, `server/tests/`, `web/src/`, `web/e2e/`, `docker/`

## Slice rules

These are the shared contract files. Slices must not edit them:
- `shared/src/enums.ts`, `shared/src/errors.ts`
- `shared/src/mcp/**`: tool schemas and shared types
- `shared/src/mcp-copy.ts`: instructions, descriptions, summaries
- `shared/src/compact.ts`: renderers
- `shared/src/api/**`: route schemas
- `server/src/db/schema.ts` and existing migrations
- `server/src/domain/contracts.ts`: service signatures
- `web/src/lib/api.ts`: the typed client and query keys
- `web/src/components/kit/**`: the UI kit

A slice **fills in** stubs in its own files: `server/src/mcp/tools/<group>.ts`, `server/src/api/routes/<group>.ts`, `server/src/domain/<service>.ts`, `web/src/routes/**`, and its own tests.

**If a slice needs a contract change:**
1. Stop the slice.
2. Open a small "contract:" PR that updates the governing document (MCP_SPEC, BUILD_SPEC or UI_SPEC), the shared files, a migration if needed, and the snapshot tests.
3. Merge it, then resume the slice.

---

## Phase 1: Setup (workspace, tooling, container, CI) · M0

- [X] T001 Create the pnpm workspace with `shared/`, `server/` and `web/`, root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` (strict) and `.nvmrc` (22), per the plan.md structure. Add `.dockerignore`.
- [X] T002 [P] Configure ESLint and Prettier, with lint and typecheck scripts at the root, in `eslint.config.js` and `.prettierrc`
- [X] T003 [P] Set up Vitest in `server/vitest.config.ts` and `shared/vitest.config.ts`
- [X] T004 [P] Set up Vite, React 19, React Router and TanStack Query in `web/`, with a placeholder route that renders "Task Lite is running"
- [X] T005 [P] Copy the prototype's `.tl` token block (light, dark, `prefers-color-scheme`) unchanged into `web/src/styles/tokens.css` (UI_SPEC §3)
- [X] T006 Write a multi-stage `docker/Dockerfile` (`node:22-bookworm-slim`, non-root user `tasklite`, uid 10001) and `docker/compose.yaml`: publish `127.0.0.1:7420:7420`, named volume `tasklite-data:/data`, a commented-out opt-in extra-backup bind mount, `restart: unless-stopped`, healthcheck on `/healthz`. Add `docker/.env.example` with every variable in BUILD_SPEC §2 Configuration.
- [X] T007 Create the server entry point `server/src/index.ts` serving `/healthz`, `/readyz` (database and docs dir writable, migrations current) and the web build, with SPA fallback
- [X] T008 Create `.github/workflows/ci.yml` on `ubuntu-latest`. One job runs pnpm cache → lint → typecheck → Vitest → `docker build`. A second job starts the image and runs Playwright end to end, uploading the report and traces on failure. Name the jobs so the Mergify queue can require them.
- [X] T009 [P] Set up Playwright in `web/playwright.config.ts`, with `@axe-core/playwright` and a fixture that starts the seeded container. Include one smoke spec ("Task Lite is running") in `web/e2e/smoke.spec.ts`.

**Checkpoint**: `docker compose up` serves "Task Lite is running", and both CI jobs are green.

---

## Phase 2: Platform foundation (runtime plumbing every slice relies on) · M1

### Tests first
- [X] T010 [P] Unit tests for event appending, `version` conflicts and idempotency replay (same key and arguments → `replayed: true`; same key, different arguments → `validation`) in `server/tests/unit/write-path.test.ts`
- [X] T011 [P] Unit tests for secret detection: Bearer values, PEM keys, and the `sk-`, `ghp_`, `github_pat_`, `xox` and `AKIA` prefixes, plus the service's own tokens. A rejected write is not stored and not logged (MCP_SPEC §3.4). In `shared/tests/secrets.test.ts`.
- [X] T012 [P] Integration tests for the Host allowlist (421), Origin allowlist (403) and missing or wrong bearer token on `/mcp` (401), in `server/tests/integration/guards.test.ts`
- [X] T013 [P] Integration tests for unlock and lock, CSRF required on mutations, key rotation ending sessions, and agents' token rejected on `/api`, in `server/tests/integration/session.test.ts`
- [X] T014 [P] Unit tests for undo: within 60 s it applies the `inverse`; after a later event on the same objects it returns `conflict`; it records an `undo` event. In `server/tests/unit/undo.test.ts`.

### Implementation
- [X] T015 [P] Define the shared enums, exactly as in BUILD_SPEC §13 and MCP_SPEC §3, in `shared/src/enums.ts`: status, type, priority, run state, provenance, `satisfied_when`, decision authority and status, every event type (contracts/events.md), and the filters with their agent-query strings (including `resumable`)
- [X] T016 [P] Define the error codes and `ToolError` in `shared/src/errors.ts`: `validation`, `conflict`, `not_found`, `forbidden`, `unavailable` and `internal`
- [X] T017 [P] Implement the secret detector in `shared/src/secrets.ts` (makes the secret tests pass)
- [X] T018 Write the Drizzle schema for **every** table in BUILD_SPEC §4 in `server/src/db/schema.ts`, including `review_decisions` and `decision_records`, `links.satisfied_when` and `projects.default_satisfied_when`. Quote the limits from data-model.md: title ≤ 200; Markdown fields ≤ 20,000; step, check and human review text ≤ 500; priority 1–3; effort ≥ 0; project key 2–5 uppercase letters; label name `a-z0-9-` ≤ 40; decision title ≤ 120 and decision ≤ 4,000.
- [X] T019 Generate the first migration and the FTS5 `search_fts` table with sync triggers in `server/src/db/migrations/`
- [X] T020 Open the database (WAL, `foreign_keys=ON`, `busy_timeout` 5 s) and a transaction helper using `BEGIN IMMEDIATE`, in `server/src/db/client.ts`
- [X] T021 Implement the write path in `server/src/domain/write.ts`: one transaction per mutation, version checks returning `conflict` with `current`, event append with actor, mutation ID and `inverse`, idempotency store (24 h), and secret check on every text field (makes the write-path tests pass)
- [X] T022 [P] Implement ID allocation (`<KEY>-<n>` through `projects.next_seq` inside the transaction) and ULID-prefixed IDs (`wst_`, `chk_`, `hr_`, `run_`, `q_`, `lnk_`, `doc_`, `dv_`, `pkt_`, `dec_`) in `server/src/domain/ids.ts`
- [X] T023 Implement the config loader (every BUILD_SPEC §2 variable with its default) and secret bootstrap (generate `/data/secrets/agent-token` and `owner-key`, mode 0600) in `server/src/config.ts`
- [X] T024 Implement the Host and Origin guards and bearer auth middleware in `server/src/api/guards.ts` (makes the guard tests pass)
- [X] T025 Create the API app in `server/src/api/app.ts`: Hono, zod validation, CSRF double-submit, error mapping to the shared error codes
- [X] T026 Implement owner sessions in `server/src/api/session.ts` (makes the session tests pass; constitution Principle VI):
  - `/api/session/unlock` and `/lock`;
  - HttpOnly SameSite=Strict cookie with a 30-day sliding expiry;
  - key rotation;
  - every `/api` route requires a session from day one.
- [X] T027 Implement owner undo in `server/src/domain/undo.ts` and `POST /api/mutations/:id/undo` in `server/src/api/routes/undo.ts` (FR-062; makes the undo tests pass)
- [X] T028 Implement the SSE stream at `/api/stream` in `server/src/api/stream.ts`: `event: change`, `id: <seq>`, `data: {seq, type, objects, for_you}`, `Last-Event-ID` resume, a keep-alive comment every 25 s (contracts/events.md)
- [X] T029 Create the MCP server in `server/src/mcp/server.ts`: Streamable HTTP at `/mcp` with stateful sessions; identity from `clientInfo` normalised (contains codex → `codex`; contains claude → `claude`); the session ID recorded for run binding
- [X] T030 [P] Implement the diagnostic call-log writer (`/data/logs/calls-YYYYMMDD.jsonl`: time, tool, client, label, run, duration, result code, never arguments; rotated daily, kept 7 days) in `server/src/jobs/logs.ts`
- [X] T031 Implement the seed loader in `server/src/db/seed/loader.ts`. It maps `design/sample-data.json` per BUILD_SPEC §8: time shift, decision records `dec_1` to `dec_3`, and the `RCP-19 → RCP-16` link set to `merged`. Add the `tasklite seed sample` command and `TASKLITE_SEED=sample`. **Note from B1:** `.dockerignore` currently excludes `design/`. Re-include `design/sample-data.json` (for example with `!design/sample-data.json`) and copy it into the image, otherwise seeding fails inside the container.

**Checkpoint**: the seed loads deterministically. `/mcp` and `/api` answer behind their guards. Undo and the live stream work. Every `/api` route requires an unlocked owner session.

---

## Phase 3a: Contracts, the MCP surface · M2 (contract half)

**Purpose**: make the whole agent contract real before any behaviour exists. Every tool is listed with its exact description and schemas, so agents and tests see the final interface.

- [X] T032 [P] Define the MCP shared types from MCP_SPEC §4 (`ItemSummary`, `Item`, `LinkRef`, `WorkStep`, `Check`, `HumanReviewItem`, `Run`, `Question`, `DecisionRecord`, `ContextBundle`, `EventRow`, `ToolError`) as zod schemas in `shared/src/mcp/types.ts`
- [X] T033 [P] Define the input and output zod schemas for the orientation and finding tools (`whoami`, `list_projects`, `search_items`, `get_item`, `get_context`, `dependency_subgraph`, `deferred_reviews`, `get_changes`; MCP_SPEC §5.1–5.2) in `shared/src/mcp/read.ts`
- [X] T034 [P] Define the input and output schemas for creating and editing (`create_item`, `update_item`, `set_status`, `link_items`, `unlink_items`, `upsert_label`; MCP_SPEC §5.3) in `shared/src/mcp/items.ts`
- [X] T035 [P] Define the input and output schemas for claims and runs (`claim_lead`, `release_lead`, `start_run`, `heartbeat`, `finish_run`; MCP_SPEC §5.4) in `shared/src/mcp/runs.ts`
- [X] T036 [P] Define the input and output schemas for the checklist (`set_plan` with `mode`/`remove`/`after`, `update_step`, `log_subagent`, `set_checks`, `update_check`, `declare_human_review`, `update_human_review`; MCP_SPEC §5.5) in `shared/src/mcp/checklist.ts`
- [X] T037 [P] Define the input and output schemas for evidence, review and decisions (`add_note`, `put_document`, `link_artifact`, `report_commit`, `submit_packet`, `get_review`, `ask_owner`, `publish_decision`, `list_decisions`, `withdraw_decision`; MCP_SPEC §5.6–5.8) in `shared/src/mcp/review.ts`
- [X] T038 Write `shared/src/mcp-copy.ts`: the server instructions (verbatim MCP_SPEC §2), all 36 tool descriptions (verbatim MCP_SPEC §5), and one result-summary template per tool
- [X] T039 Implement every compact renderer (item in each view, list rows, checklist markers, runs, context bundle, change feed, review rounds, decisions, mutation one-liners, errors, `!` warnings) per MCP_SPEC §3.1 in `shared/src/compact.ts`. Write snapshot tests against fixture objects built from the seed shapes in `shared/tests/compact.test.ts`. The MCP_SPEC §3.1 RCP-14 example must render identically.
- [X] T040 Implement the tool-registration helper in `server/src/mcp/register.ts`:
  - zod → JSON Schema for `inputSchema` and `outputSchema`;
  - annotations per MCP_SPEC §3;
  - `structuredContent` plus the compact text block;
  - structured errors as `isError`;
  - idempotency-key and `run_id` signal hooks;
  - a call-log line per call.
- [X] T041 Register **all 36 tools** with stub handlers that return `unavailable` ("Not implemented yet: <tool>"), one file per group (`server/src/mcp/tools/{read,items,runs,checklist,evidence,review,decisions}.ts`). Slices replace the stubs in place.
- [X] T042 [P] Contract snapshot test: `initialize` returns the instructions verbatim, and `tools/list` matches MCP_SPEC exactly (names, descriptions, schemas, annotations), in `server/tests/contract/snapshot.test.ts`. It goes green in this phase and guards every later PR.
- [X] T043 [P] Build the contract test harness in `server/tests/contract/harness.ts`: an in-process server with a fresh seeded database per test, two MCP SDK clients with different `clientInfo`, a helper that measures the text block in tokens (characters ÷ 4), and assertion helpers for each `ToolError` code

**Checkpoint**: the snapshot test is green, every tool is listed with its final description, and every stub answers `unavailable`.

---

## Phase 3b: Contracts, the UI API and domain signatures · M3 (contract half)

- [X] T044 [P] Define request and response zod schemas for **every** route in BUILD_SPEC §7, including the clarification routes (`PATCH /api/items/:id` text fields, `POST /api/items/:id/cancel`, `GET /api/diagnostics/calls`, `PATCH /api/projects/:key`), in `shared/src/api/*.ts`, grouped as contracts/ui-api.md groups them
- [X] T045 Register **every** API route with session, CSRF and schema validation, and placeholder handlers returning `501 {code:"unavailable"}`, one file per group in `server/src/api/routes/{read,review,deps,decisions,steer,planning,timeline,import,settings,diagnostics}.ts`
- [X] T046 [P] API contract test: every BUILD_SPEC §7 route exists, rejects missing session (401) and missing CSRF on mutations (403), and validates its body (400 → `validation`), in `server/tests/integration/routes.test.ts`
- [X] T047 Declare the domain service signatures in `server/src/domain/contracts.ts`: items, runs, checklist, evidence, search and views, human review, packets and review decisions, links and subgraph, decisions and context, messages, documents, archive and cancel, projects, backup, forecast, and Jira import. Each method takes a `WriteContext` or `ReadContext` and returns typed results or a `ToolError`. Add stub implementations that throw not-implemented.
- [X] T048 Wire the MCP stubs and API placeholders to call through `contracts.ts`, so a slice only implements the service and removes the stub
- [X] T049 [P] Generate the typed web API client from `shared/src/api` (fetch, CSRF header, `mutation_id` capture for undo, `409` conflict shape), the TanStack Query key factory, and the event → query-key invalidation map from contracts/events.md, in `web/src/lib/api.ts`

**Checkpoint**: typecheck passes across all packages. Every route answers 501 behind its guards. Adapters call only `contracts.ts`.

---

## Phase 3r: Contracts, crash recovery · M2/M3 (contract half, owner decision 26)

**Purpose**: add the recovery contract (MCP_SPEC §2, §3 "Workspaces, briefs and resources", §4, §5.4, §5.6, §5.9, §7.12–7.13, §8; BUILD_SPEC §4, §5.16, §7) before the UI kit, so the kit and the screen shells can show parked runs and workspaces. This batch ships in the same PR as the spec changes on `eps5000/contract-recovery`, because the snapshot test reads MCP_SPEC.

- [X] T050 [P] Add a migration (never edit an existing one) and update `server/src/db/schema.ts`. `runs` gets `end_reason`, `parked_reason`, `waiting_on`, `parked_at`, `workspace` (JSON), `orchestrator` (JSON), `brief_document_version_id`, `external` and `unpushed_handled_at`. Add `brief` to the `documents.kind` values. Add the `run_resources` table. `commits` gets `run_id` and `pushed`. Extend `shared/src/enums.ts` with `parked` in the run state, `end_reason`, `workspace_state` and the resource kinds. Add the config keys `TASKLITE_PARK_MAX`, `TASKLITE_RESUME_UNATTENDED` and `TASKLITE_ORPHAN_AFTER` to `server/src/config.ts` and `docker/.env.example`. Extend the migration test.
- [X] T051 [P] Extend the MCP shared types in `shared/src/mcp/types.ts`: `Run` (`end_reason`, `parked`, `workspace`, `orchestrator`, `brief_document_version_id`, `resources`, `external`), the new `Workspace`, `WaitingOn` and `Resource` types, `Item.resume`, and the new EventTypes (`run.parked`, `run.resumed`, `run.unpushed_handled`, `resource.declared`, `resource.released`)
- [X] T052 Update the tool schemas in `shared/src/mcp/runs.ts` and `shared/src/mcp/review.ts`:
  - `claim_lead` and `start_run` accept `workspace`, `orchestrator`, `brief` or `brief_document_version_id`, and `external`;
  - `heartbeat` accepts the workspace patch, `resources_started` and `resources_released`, and returns `resources`;
  - `finish_run` gains its warnings;
  - `report_commit` accepts `pushed`;
  - the new `park_run`.

  Add the new `recovery_report` (MCP_SPEC §5.9) in `shared/src/mcp/recovery.ts`. All of them stay strict, with the limits from MCP_SPEC.
- [X] T053 Update `shared/src/mcp-copy.ts`: the server instructions (the three new MCP_SPEC §2 bullets, verbatim), the changed descriptions (`claim_lead`, `start_run`, `heartbeat`, `finish_run`, `report_commit`), the new descriptions (`park_run`, `recovery_report`), and their summary templates. Add compact renderers in `shared/src/compact.ts` for a parked run, the workspace line, resources and the `recovery_report` sections, with snapshot tests in `shared/tests/compact.test.ts`.
- [X] T054 Register `park_run` (in `server/src/mcp/tools/runs.ts`) and `recovery_report` (new `server/src/mcp/tools/recovery.ts`) as `unavailable` stubs through `contracts.ts`. Update the contract snapshot test from 36 to **38** tools. It must stay green against the edited MCP_SPEC, including the instructions.
- [X] T055 Add the recovery UI API in `shared/src/api/` (`GET /api/workspaces`, `POST /api/resources/:id/release` `{note?}`, `POST /api/runs/:runId/unpushed-handled`) and register them as 501 placeholders in `server/src/api/routes/recovery.ts`. Add the recovery service signatures and stubs to `server/src/domain/contracts.ts` (park, resources, workspace state, recovery report, owner release and handled). Extend `server/tests/integration/routes.test.ts`.
- [X] T056 [P] Extend `web/src/lib/api.ts`: the client methods, `queryKeys.workspaces`, and the invalidation entries for the five new event types (contracts/events.md). Extend the client tests.

**Checkpoint**: the snapshot test lists 38 tools and matches the edited MCP_SPEC. The migration applies on a fresh database and on a B2-era database. Every new route answers 501 behind its guards. All existing suites stay green.

---

## Phase 3c: Contracts, UI kit, shell and screens · M4 (contract half)

- [X] T057 [P] Build the UI kit per UI_SPEC §4–§5 in `web/src/components/kit/`: Button, IconButton, Chip (all variants), TypeBadge/TypeIcon, RunState (including `parked`, UI_SPEC §5), Provenance, Priority, Label, EpicLink, Card, Section (collapsible, per-type persistence), ViewTabs (counts, dots, ARIA tabs), TicketCard, EpicCard, DecisionRow shell, Toast, Dialog (focus trap; destructive dialogs focus Cancel), CommandPalette shell, EmptyState, and the inline editor primitive. Light and dark.
- [X] T058 [P] Add a dev-only kit gallery at `/dev/kit` in `web/src/routes/dev/kit.tsx`, with axe checks in `web/e2e/kit.spec.ts`
- [X] T059 Build the app shell in `web/src/app/`:
  - 220 px sidebar (Needs you, Work, Agents, Settings), collapsing to a 64 px rail at ≤ 1180 px;
  - header with breadcrumb, + New, search (`Ctrl K` and `/`) and theme;
  - open-item tab strip, 8 maximum, remembering each tab's view;
  - `sessionStorage`/`localStorage` persistence per UI_SPEC §2;
  - an SSE hook using the invalidation map;
  - the Unlock route.
- [X] T060 Build the toast-with-undo plumbing (3.2 s, or 6 s with Undo; `role=status`; calls the undo route) and the conflict-toast handling in `web/src/lib/undo.ts`
- [X] T061 Build **every screen as a shell**, routed and using the typed client, rendering the UI_SPEC empty, loading (skeleton after 200 ms) and error states. Slices fill in the content. The shells:
  - Needs you;
  - Work: Board, List, Map and Timeline layouts, filters and the Epics row;
  - the item page: header, banners, the four view tabs, and the sections per tab;
  - the packet screen layout, including the narrow grid;
  - the item page's "Where the work lives" block (an empty shell);
  - the label page, Agents (including the Workspaces card), and Settings (Projects, Connections, This browser);
  - the dialogs: Quick capture, Document viewer, Checklist history, Delete project, Jira import.

  In `web/src/routes/**`.
- [X] T062 [P] Build the end-to-end harness in `web/e2e/fixtures/`: a seeded container reset per test file, an unlock helper, an axe helper (both themes), an MCP client helper for driving agent actions from browser tests, and a notification-permission helper
- [X] T063 [P] Shell navigation E2E: every route reachable from the sidebar, palette and tabs; the 8-tab cap; scope resetting to All projects in a new context; axe-clean empty states. In `web/e2e/shell.spec.ts`.

**Checkpoint**: every screen is navigable with correct empty and error states, and the kit and shell pass axe. **The contract surface is complete; slices can now run in any dependency-respecting order.**

---

## Phase 4: User Story 1 · Agents find, claim and complete work (P1) 🎯 MVP

**Goal**: agents coordinate the full no-review loop through MCP, with server-enforced claims and leases.

**Independent Test**: spec US1. A scripted MCP client claims, plans, checks, commits and closes, and a second client's claim gets `conflict`.

**Fills**: `server/src/mcp/tools/{read,items,runs,checklist,evidence}.ts` (the US1 tools), `server/src/domain/{items,runs,checklist,evidence,search}.ts`, `server/src/jobs/sweeper.ts`

### Tests for US1
- [X] T064 [P] [US1] Unit tests for the status transitions in BUILD_SPEC §5.1, including the resume claim, the Done gate with no review items, and "an epic reaches Done only when every child is Done or Canceled" (FR-005), in `server/tests/unit/status.test.ts`
- [X] T065 [P] [US1] Unit tests for claims and leases in `server/tests/unit/claims.test.ts`: 100 concurrent claims → exactly 1 wins; lease expiry → run `interrupted` and item back to `ready` with the plan kept; restart sweep → all open runs `interrupted`
- [X] T066 [P] [US1] Unit tests for displayed run state at the window edges (live 2 m, stale 30 m, signal kinds `session`, `report`, `relayed`) in `server/tests/unit/run-state.test.ts`
- [X] T067 [P] [US1] Unit tests for plan and check patching in `server/tests/unit/checklist.test.ts`: patch never removes unlisted entries, replace removes agent entries only, owner entries are kept; maximum 30 steps and 30 checks
- [X] T068 [P] [US1] MCP contract tests for flows §7.1, §7.2, §7.6 and §7.7; `get_changes` paging in order with no gaps, and an empty cursor returning the latest (FR-023); every error code reachable (FR-026); in `server/tests/contract/us1-coordinate.test.ts`
- [X] T069 [P] [US1] Token-budget contract test (`get_item` standard ≤ 1,200, summary ≤ 300, `search_items` 25 results ≤ 1,000, mutations ≤ 60; fail above 120%), plus SC-001 (`whoami` → `search_items` → `claim_lead` → `get_context` in ≤ 4 calls and ≤ 3,500 tokens in total; `get_context` is measured once US5 lands, and the test is marked pending until then), in `server/tests/contract/budgets.test.ts`

### Implementation for US1
- [X] T070 [US1] Implement the item service (create, update with patch semantics, `add_labels`/`remove_labels`, `set_status` with guards and allowed-transition errors, dates with `dates_set_by`) in `server/src/domain/items.ts`
- [X] T071 [US1] Implement claims and runs (`claim_lead` from ready or unclaimed progress, `release_lead`, `start_run`, `heartbeat`, `finish_run`, lease renewal on any `run_id` call, signal kinds by session match) in `server/src/domain/runs.ts`
- [X] T072 [US1] Implement the sweeper (displayed-state re-derivation, lease expiry → interrupted and Ready, a ping every 60 s to sessions of open runs, the restart sweep at boot) in `server/src/jobs/sweeper.ts`. **Note from B2:** the MCP server answers POSTs with JSON responses and opens no `GET` stream, so server→client pings need the Streamable HTTP `GET` SSE stream per session. Add it here, and treat a session without one as unable to show *live* (BUILD_SPEC §5.4, verification V1).
- [X] T073 [US1] Implement the checklist service (`set_plan` patch and replace with versions and reasons, `update_step`, `log_subagent`, `set_checks`, `update_check`) in `server/src/domain/checklist.ts`
- [X] T074 [P] [US1] Implement notes, artifacts and commits (`add_note`, `link_artifact`, `report_commit`, with repeat-SHA no-op) in `server/src/domain/evidence.ts`
- [X] T075 [US1] Implement search and filters (`ready_to_start` sorted by priority then by how many items it unblocks; `resumable`, `blocked`, `waiting_for_review`, `mine`; `fields`, cursor pagination) and the change feed, in `server/src/domain/search.ts`
- [X] T076 [US1] Replace the stubs for `whoami`, `list_projects`, `search_items`, `get_item` (`view`/`fields`), `get_changes`, `create_item`, `update_item`, `set_status`, `claim_lead`, `release_lead`, `start_run`, `heartbeat`, `finish_run`, `set_plan`, `update_step`, `log_subagent`, `set_checks`, `update_check`, `add_note`, `link_artifact` and `report_commit` with calls into the services above

**Checkpoint**: the US1 independent test passes with no UI. This is the MVP.

---

## Phase 5: User Story 2 · The owner sees what agents did and are doing (P1)

**Fills**: `server/src/domain/views.ts`, `server/src/api/routes/read.ts`, `web/src/routes/{needs-you,work,items,agents}`, `web/src/lib/{notifications,live}.ts`

### Tests for US2
- [X] T077 [P] [US2] API contract tests for `bootstrap`, `needs-you`, `work`, `items/:id`, `agents`, `search` and `stream` against the seed, in `server/tests/integration/us2-api.test.ts`
- [X] T078 [P] [US2] E2E: Needs you ("3 for you", only action cards, Problems actions), the four item tabs with counts and dots, live update without moving focus; in `web/e2e/us2-visibility.spec.ts`
- [X] T079 [P] [US2] E2E: notifications (one per new packet or question, a click opens the target, already-pending items don't notify, the tab title reads `(N) Task Lite`, with permission denied the status reads "Blocked by the browser"), in `web/e2e/us2-notifications.spec.ts`

### Implementation for US2
- [X] T080 [US2] Implement the read models for needs-you (for-you, problems, deferred, planning queue, agent counts), work (board, list), item detail and agents in `server/src/domain/views.ts`, and fill the `read` route handlers
- [X] T081 [US2] Fill the Needs you screen (Agents strip, For you now, Problems with their actions, the Deferred and Planning queue cards; one screen at 1440×900) per UI_SPEC §6.1
- [X] T082 [US2] Fill Work → Board and List (filters with agent-query tooltips, Epics row, Ready split, Review cards opening packets) per UI_SPEC §6.2.1–2
- [X] T083 [US2] Fill the item page's read views (header, banners, tab counts and dots, Details sections, the Checklist read view, Activity) per UI_SPEC §6.3
- [X] T084 [P] [US2] Fill Agents (UI_SPEC §6.6) and the command palette results (items including archived and Jira keys, labels, views)
- [X] T085 [US2] Implement desktop notifications and the tab title (opt-in callout, the This browser switch, one claiming tab per browser, dedupe by `seq`, click routing) per UI_SPEC §6.7a in `web/src/lib/notifications.ts`
- [X] T086 [US2] Implement focus preservation across live updates and the reconnecting and unreachable banners per UI_SPEC §7 in `web/src/lib/live.ts`

---

## Phase 6: User Story 3 · The owner verifies finished work (P1)

**Fills**: `server/src/domain/{human-review,packets,review-decisions}.ts`, `server/src/mcp/tools/{checklist,review}.ts` (review tools), `server/src/api/routes/review.ts`, `web/src/routes/review/`, the human review section of the Checklist tab

### Tests for US3
- [ ] T087 [P] [US3] Unit tests for the `submit_packet` guards (blocked, packet already open, nothing declared, a failing check without a gap) and the decision outcomes (approve all; any changes; defer with or without follow-up; mixed; approvals carry forward) in `server/tests/unit/review.test.ts`
- [ ] T088 [P] [US3] Unit tests for stale packets (ticket-level and epic-level), fresh-packet requests and deferred-list membership in `server/tests/unit/review-stale.test.ts`
- [ ] T089 [P] [US3] MCP contract tests for flows §7.3, §7.4 and §7.9 in `server/tests/contract/us3-review.test.ts`
- [ ] T090 [P] [US3] E2E for the packet screen (SC-006: deciding a two-item packet takes at most 4 clicks beyond verification; round selector, disabled submit, the note required for changes, outcome-named button, undo, past-round styling, attachments, 1024 px layout) in `web/e2e/us3-review.spec.ts`

### Implementation for US3
- [ ] T091 [US3] Implement the human review service (declare, update or remove the author's own items; locked while `ready`; agents get `forbidden` on owner-added items) in `server/src/domain/human-review.ts`
- [ ] T092 [US3] Implement the packet service (`submit_packet` with guards, content hash, snapshots, attachments; stale derivation; `get_review`; `deferred_reviews`) in `server/src/domain/packets.ts`
- [ ] T093 [US3] Implement owner decisions in `server/src/domain/review-decisions.ts`:
  - atomic verdicts;
  - changes → a checklist step with `from_review`, or a Bug in Ready with the parent's project, epic and priority, a title of up to 70 characters, and a `relates` link;
  - defer → a follow-up Task in Inbox titled "Verify: …" (60 characters);
  - the outcome, with an undo inverse.
- [ ] T094 [US3] Replace the stubs for `declare_human_review`, `update_human_review`, `submit_packet`, `get_review` and `deferred_reviews`, and fill the `review` route handlers
- [ ] T095 [US3] Fill the packet screen (queue, packet, decision panel, Viewing group) per UI_SPEC §6.4, and the human review section of the Checklist tab per UI_SPEC §6.3.1

**Checkpoint**: the US1–US3 tests pass. The P1 product is complete.

---

## Phase 6r: User Story 11 · Interrupted work restarts cleanly (P1)

**Goal**: coordinators can re-dispatch every interrupted run from Task Lite alone, parked workers are never mistaken for finished ones, and nothing is left running unnoticed (owner decision 26; FR-110 to FR-117).

**Independent Test**: spec US11 and SC-014. Dispatch three workers (active; parked on an item; with a dev server and an unpushed commit), restart the service, then re-dispatch from `recovery_report` alone.

**Fills**: `server/src/domain/{runs,recovery}.ts`, `server/src/jobs/sweeper.ts`, `server/src/mcp/tools/{runs,evidence,recovery}.ts`, `server/src/api/routes/recovery.ts`, the Problems rows, the item page's "Where the work lives" block, and Agents → Workspaces

### Tests for US11
- [ ] T096 [P] [US11] Unit tests in `server/tests/unit/recovery.test.ts`:
  - parking suspends the lease, and any call with the `run_id` resumes it;
  - `resume_ready` once every `waiting_on` item clears; "unattended" after `TASKLITE_RESUME_UNATTENDED`; a Problem after `TASKLITE_PARK_MAX`;
  - `end_reason` set on every terminal path;
  - unreleased resources orphaned after `TASKLITE_ORPHAN_AFTER`;
  - unpushed at-risk detection (`head_sha` ≠ `pushed_sha`, or `dirty`) and clearing it (a later push, or owner handled);
  - workspace state derivation for every case, including `unknown` when nothing was reported.
- [ ] T097 [P] [US11] MCP contract tests for flows §7.12 and §7.13 and MCP_SPEC §10 tests 17–20, in `server/tests/contract/us11-recovery.test.ts`: the brief comes back byte-identical; `finish_run` warns on unreleased resources and unpushed commits; `recovery_report` paging and `include_briefs`; SC-014's crash simulation (three runs, restart, re-dispatch from the report alone)
- [ ] T098 [P] [US11] E2E in `web/e2e/us11-recovery.spec.ts`: the Problems rows (orphaned resources, unpushed work may be lost, parked 24 h, ready to resume unattended) with *Mark released* and *Handled* plus undo; the "Where the work lives" block and *Copy resume note*; Agents → Workspaces states; axe in both themes

### Implementation for US11
- [ ] T099 [US11] Implement the recovery behaviour in the runs service (`server/src/domain/runs.ts`):
  - workspace, orchestrator, brief (stored as a `brief` document version) and `external` on claim and start;
  - heartbeat workspace patches, `resources_started` and `resources_released` (with events);
  - `park_run`, and resuming on any call;
  - `end_reason` on every end;
  - the `finish_run` warnings;
  - `report_commit` `pushed` → `pushed_sha`.

  Extend the sweeper: suspend leases while parked, and flag ready-to-resume, unattended, parked-too-long and orphaned.
- [ ] T100 [US11] Implement `recovery_report`, workspace-state derivation and `Item.resume` in `server/src/domain/recovery.ts`. Replace the `park_run` and `recovery_report` stubs, add the recovery fields to the `claim_lead`, `start_run`, `heartbeat`, `finish_run`, `report_commit` and `get_item` handlers, and fill the `recovery` route handlers.
- [ ] T101 [US11] Fill the UI per UI_SPEC: the recovery Problems rows and their actions on Needs you, the "Where the work lives" block with *Copy resume note* in the Lead and runs section, and the Agents → Workspaces card

**Checkpoint**: the US11 independent test passes, and the `tasklite-coordinator` skill matches the behaviour.

---

## Phase 7: User Story 4 · Dependencies decide what's ready (P2)

**Fills**: `server/src/domain/{links,subgraph}.ts`, the dependency tools in `server/src/mcp/tools/items.ts` and `read.ts`, `server/src/api/routes/deps.ts`, `web/src/components/ProgressMap/` (slice-owned), the Dependencies and Map tabs, Work → Map, the Settings blocker rule

### Tests for US4
- [ ] T102 [P] [US4] Unit tests for `satisfied_when`: done, merged and verified; the project default against a link override; verified on a blocker without review items → `validation`; verified with a deferred check → stays blocked plus a Problem; canceled blockers; an archived blocker is not cleared by archiving; re-evaluation and the event. In `server/tests/unit/dependencies.test.ts`.
- [ ] T103 [P] [US4] Unit tests for cycle rejection with the path, strongly connected components on imported data, and cross-project blocking in `server/tests/unit/cycles.test.ts`
- [ ] T104 [P] [US4] MCP contract test for flow §7.11 and `dependency_subgraph` with `delay_days` in `server/tests/contract/us4-deps.test.ts`
- [ ] T105 [P] [US4] E2E: the map (waves, outside column, arrows kept on resize and zoom, hover tracing, pan, Fit), the blocked chip "(needs merge)", the project rule select with undo, cycle fix from the Dependencies tab; in `web/e2e/us4-deps.spec.ts`

### Implementation for US4
- [ ] T106 [US4] Implement the link service (`link_items` that creates or updates `satisfied_when`, `unlink_items`, cycle DFS, strongly connected components, the cleared-blocker evaluation per data-model.md) in `server/src/domain/links.ts`, and `dependency_subgraph` (depth 1–5, direction, `date_source`, `at_risk` with `delay_days`) in `server/src/domain/subgraph.ts`. Also add the item-reference write check (MCP_SPEC §3.4): item IDs mentioned in any text field that don't exist are accepted with a `! RCP-99 doesn't exist` warning. Apply it once in the write path so every text-writing tool gets it, and test it (left unassigned by B7).
- [ ] T107 [US4] Replace the stubs for `link_items`, `unlink_items` and `dependency_subgraph`, and fill the `deps` route handlers
- [ ] T108 [US4] Build the ProgressMap (waves = longest blocks path; 200 px columns, 76 px gap, 16 px rows; canvas at most 540 px tall; zoom steps 50/67/80/100/125, Fit down to 40%; More pills; SVG arrows) per UI_SPEC §6.3.4 in `web/src/components/ProgressMap/`
- [ ] T109 [US4] Fill the Dependencies tab (1-hop view with "waiting for merge/verification", cycle callout), the epic Map tab, Work → Map, and the Settings "Blockers clear when" select

---

## Phase 8: User Story 5 · Context in one call, and shared decisions (P2)

**Fills**: `server/src/domain/{decisions,context}.ts`, `server/src/mcp/tools/decisions.ts`, `get_context` in `read.ts`, `server/src/api/routes/decisions.ts`, the Decisions sections

### Tests for US5
- [ ] T110 [P] [US5] Unit tests for the context bundle (section order, budgets of 1k/3k/8k, truncation markers, essentials and decisions never cut first, notes counted but not marked read) in `server/tests/unit/context.test.ts`
- [ ] T111 [P] [US5] Unit tests for decisions (scope inheritance from project to epic to label to item; agents forbidden on owner records; supersede and withdraw states; confirm) in `server/tests/unit/decisions.test.ts`
- [ ] T112 [P] [US5] MCP contract test for flow §7.10 and the `get_context` budget (RCP-14 medium ≤ 3,000). Also turn on the pending SC-001 step in the budget test. In `server/tests/contract/us5-context.test.ts`.
- [ ] T113 [P] [US5] E2E: the Decisions section on a ticket (inherited scope chips, Confirm → "Owner", Withdraw with undo, Record form), on an epic and on a label, in `web/e2e/us5-decisions.spec.ts`

### Implementation for US5
- [ ] T114 [US5] Implement the decision service (publish, list with `in_scope_of`, withdraw, confirm, supersede, authority rules) in `server/src/domain/decisions.ts`, and the context assembler per BUILD_SPEC §5.15 in `server/src/domain/context.ts`
- [ ] T115 [US5] Replace the stubs for `get_context`, `publish_decision`, `list_decisions` and `withdraw_decision`, and fill the `decisions` route handlers
- [ ] T116 [US5] Fill the Decisions sections (ticket, epic, label, the Settings project dialog) using the kit's DecisionRow, per UI_SPEC §6.3.5

---

## Phase 9: User Story 6 · The owner steers without a review round (P2)

**Fills**: `server/src/domain/messages.ts`, `ask_owner` and delivery in `get_item`, `server/src/api/routes/steer.ts`, Lead and runs, the History note box, checklist add rows, the inline answer

### Tests for US6
- [ ] T117 [P] [US6] Unit tests for exactly-once delivery of answers and notes, one open question per item, and the run going to `needs_input` and back, in `server/tests/unit/messages.test.ts`
- [ ] T118 [P] [US6] MCP contract test for flow §7.5 and an old `run_id` after release returning `conflict`, in `server/tests/contract/us6-steer.test.ts`
- [ ] T119 [P] [US6] E2E: inline answer, note logged, the release dialog focusing Cancel with undo, Return to Ready, owner adds and removes a work step and a check, in `web/e2e/us6-steer.spec.ts`

### Implementation for US6
- [ ] T120 [US6] Implement questions and owner notes (`ask_owner`, answer, delivery marking only in `get_item` standard and full views) in `server/src/domain/messages.ts`. Replace the `ask_owner` stub and fill the `steer` route handlers (answer, notes, release, return-to-ready, and the owner work, check and human-review entries).
- [ ] T121 [US6] Fill Lead and runs (conflict callout, error output, release dialog, Return to Ready), the History note box, the checklist add rows, the inline answer in Needs you, and the question banner, per UI_SPEC §6.3.1–2

---

## Phase 10: User Story 7 · Planning and keeping things tidy (P2)

**Fills**: `server/src/domain/{documents,archive}.ts`, cancel and text edits in `items.ts`, `put_document` and `upsert_label`, `server/src/api/routes/{planning,upload}.ts`, quick capture, inline editing, cancel, archive, the label page, viewers

### Tests for US7
- [ ] T122 [P] [US7] Unit tests in `server/tests/unit/planning.test.ts` covering:
  - owner cancel (FR-064b): any open item, optional reason; an epic with open children is refused naming them; an active lead run ends `interrupted` and its claim is released; an open packet is withdrawn; undo restores the status but not the run;
  - the archive guards (done only), and archived items excluded from owner views but included in agent queries;
  - owner text edits (limits, secret check, version conflict, undo).
- [ ] T123 [P] [US7] E2E in `web/e2e/us7-planning.spec.ts`:
  - Cancel item… (inline confirm focusing *Keep item*, the lead warning, the open-children list, Undo, still found in search);
  - quick capture (title required, lands in Inbox; from an epic you stay on the epic);
  - label page Move N to Ready with undo;
  - Archive and Archive all with undo, the Archived filter, the "+ N archived" fold;
  - the document viewer;
  - inline edit with the conflict callout.

### Implementation for US7
- [ ] T124 [US7] Implement the documents service (immutable versions, sha256, 25 MB through MCP, the `/agent-upload` multipart endpoint up to 500 MB, preview MIME handling, `Content-Disposition` and `nosniff`) in `server/src/domain/documents.ts` and `server/src/api/routes/upload.ts`. Replace the `put_document` and `upsert_label` stubs.
- [ ] T125 [US7] Implement owner cancel, archive and unarchive, and owner text edits in `server/src/domain/{items,archive}.ts`, and fill the `planning` route handlers (quick capture, `PATCH` fields, cancel, archive, labels and move-to-ready, document content)
- [ ] T126 [US7] Fill quick capture and + New item in this epic; inline editing (title, description, outcome, acceptance; Preview; `Ctrl+Enter`/`Esc`; conflict callout; counters); and the item header's "⋯" Cancel item… flow, per UI_SPEC §6.3 and §6.9
- [ ] T127 [US7] Fill the Done column Archive and Archive all actions, the Archived filter, the epic fold-up, the Label page (UI_SPEC §6.5), and the document viewer and Checklist history dialogs

---

## Phase 11: User Story 10 · Running Task Lite safely (P2)

**Fills**: `server/src/jobs/backup.ts`, `server/src/domain/projects.ts`, `server/src/cli/index.ts`, the `settings` and `diagnostics` route handlers, the Settings and Unlock content, the README, `docker/smoke/`

### Tests for US10
- [ ] T128 [P] [US10] Integration tests in `server/tests/integration/us10-ops.test.ts`:
  - **extra backup location:** with it set, the archive appears in both places and the extra copy restores after the data dir is removed; an unwritable extra dir still lets the default backup succeed and raises a Problem;
  - **restore:** a backup restored into a temporary data dir is identical (item, event and document checksums);
  - **project delete:** rows and the docs dir are removed, and the tombstone is retried at startup;
  - **logs:** the call log contains no arguments, and no log contains an `Authorization` value;
  - **deleted IDs:** a deleted project's IDs return `not_found` to agents;
  - **container replacement** (`docker compose down && up` in the CI Docker job) keeps every item, event and document (SC-008).
- [ ] T129 [P] [US10] E2E: Settings (projects, connections, snippets showing `$TASKLITE_TOKEN`, Reveal token auto-hiding after 30 s, the delete dialog with typed key and focus on Cancel, the backup locations, *Download diagnostic log*), in `web/e2e/us10-settings.spec.ts`

### Implementation for US10
- [ ] T130 [US10] Implement the nightly backup in `server/src/jobs/backup.ts` and the CLI in `server/src/cli/index.ts`:
  - `VACUUM INTO` plus a docs tar.gz, with `BACKUP_KEEP` retention;
  - the opt-in copy to `TASKLITE_BACKUP_EXTRA_DIR` (a failed extra copy never fails the default backup, and raises a Problem);
  - the CLI commands `backup now`, `restore <file>` (refuses while running; verifies first), `owner-key` and `agent-token`.
- [ ] T131 [US10] Implement project delete (transaction plus tombstone, docs removal after commit, retry at startup) in `server/src/domain/projects.ts`, and fill the `settings` and `diagnostics` route handlers
- [ ] T132 [US10] Fill Settings (Projects, Connections with the compatibility matrix and snippets, Endpoint, Service health with backup locations, This browser) and the Unlock screen per UI_SPEC §6.7–6.8
- [ ] T133 [US10] Write the README quick start (clean machine to connected agent in ≤ 10 minutes, plus the optional extra-backup bind mount) and `docker/smoke/` (a script and checklist per client surface, O07)

---

## Phase 12: User Story 8 · Dates, effort and a forecast (P3)

**Fills**: `server/src/domain/forecast.ts`, the `timeline` route handlers, Work → Timeline, the burn-down card

- [ ] T134 [P] [US8] Unit tests in `server/tests/unit/forecast.test.ts`: date risk; burn-down replay from events, with scope additions and the unestimated count; forecast thresholds (≥ 8 estimated items done in the last 4 weeks, across ≥ 2 weeks); Monte Carlo P50/P85 deterministic with a seeded RNG; planned dates unchanged
- [ ] T135 [P] [US8] E2E: Timeline (planned and actual bars, set-by only on hover, blocker ticks, risk text, undated list, forecast lane), and the burn-down card with *Show as table*, in `web/e2e/us8-timeline.spec.ts`
- [ ] T136 [US8] Implement the timeline query, burn-down and forecast in `server/src/domain/forecast.ts`, and fill the `timeline` route handlers
- [ ] T137 [US8] Fill the Timeline layout and the burn-down card per UI_SPEC §6.2.4 and §9.1

---

## Phase 13: User Story 9 · Jira import with a dry run (P3)

**Fills**: `server/src/import/jira/`, the `import` route handlers, the Import dialog

- [ ] T138 [P] [US9] Unit tests for every mapping row in BUILD_SPEC §9 (types, status categories, priorities, links, ADF to Markdown losses, sub-tasks as work steps, field detection), using recorded responses in `server/tests/fixtures/jira/`, in `server/tests/unit/jira-map.test.ts`
- [ ] T139 [P] [US9] Integration test: the dry run writes nothing; the commit is atomic; the token appears nowhere (grep the data dir and logs); a recorded 500-issue fixture dry-runs in under 2 minutes and accounts for 100% of issues (SC-011); in `server/tests/integration/us9-jira.test.ts`
- [ ] T140 [US9] Implement the Jira client (REST v3 search and pagination, links, comments, attachment metadata and download, honouring `Retry-After`; the token held in memory, expiring after 1 h or on cancel), the mapper and the report builder, in `server/src/import/jira/{client,mapper,report}.ts`
- [ ] T141 [US9] Implement the commit (one transaction, `jira_key`, `imported`, post-commit attachment download, the report stored as an `import_report` document), and fill the `import` route handlers and the three-step Import dialog per UI_SPEC §9.2

---

## Phase 14: Polish and cross-cutting · M8

- [ ] T142 [P] Accessibility pass: run the axe suite on every route in both themes; keyboard paths (skip link, tabs pattern, map canvas arrows, dialogs); NVDA spot check of the packet flow. In `web/e2e/a11y.spec.ts`.
- [ ] T143 [P] Performance check at scale (generate 20 projects, 5,000 items and 100,000 events): owner views under 1 s, agent calls p95 under 500 ms (SC-013), in `server/tests/perf/scale.test.ts` (run on demand)
- [ ] T144 [P] Reduced-motion and 1024×900 layout checks (the packet decision panel under the queue) in `web/e2e/layout.spec.ts`
- [ ] T145 [P] FR-106 guard: run the contract and e2e suites with the container on an internal network with no egress, and assert no outbound connection attempts (only the Jira fixture may reach out), in `.github/workflows/ci.yml` and `server/tests/integration/no-egress.test.ts`
- [ ] T146 Run the real-client smoke test (installed Codex, installed Claude Code, an Orca worker running Codex, an Orca worker running Claude), fill in the Settings compatibility matrix, and record the BUILD_SPEC §12 verifications V1–V3 and V6
- [ ] T147 Stretch: add `tasklite export` (full JSON plus documents) in `server/src/cli/export.ts`. It is required before the pilot (ROADMAP §1).
- [ ] T148 [P] Skills (owner decision 27):
  - **Lint:** `server/tests/contract/skills-lint.test.ts` parses every `skills/*/SKILL.md` and fails if a backticked snake_case name isn't a registered tool, a top-level input field, or an enum value from `shared/`. It also checks that each file has `name` and `description` frontmatter.
  - **Eval:** script the US1 and US11 scenarios against the seeded server with a real client, with and without `tasklite-worker` and `tasklite-coordinator`, and record calls, tokens and mistakes in the PR. The skills must do at least as well as without them, and meet the SC-001 budget.
  - **Fix and verify:** fix any skill text the eval shows is wrong, and record V7 (where each client loads skills).
- [ ] T149 Run the quickstart.md validation end to end, and run `/speckit-analyze` until there are no CRITICAL findings

---

## How to run the build

**One batch = one fresh agent session = one branch = one PR.** Never run `/speckit-implement` across the whole list. `tasks.md` holds the state: each run ticks off its tasks, so the next run starts where the last stopped.

| Batch | Phase | Tasks | Notes |
|---|---|---|---|
| B1 | 1 Setup | T001–T009 | Trial run: watch how the agent handles the skill and the PR flow, and tune the prompt |
| B2 | 2 Platform foundation | T010–T031 | Ask for the checkpoint demo: seed, guards, session, undo, stream |
| B3 | 3a MCP contracts | T032–T043 | The snapshot test must be green |
| B4 | 3b UI API and domain signatures | T044–T049 | |
| B5 | 3r Recovery contracts | T050–T056 | Builds on branch `eps5000/contract-recovery` (the spec commits); the snapshot test lists 38 tools |
| B6 | 3c UI kit, shell and screens | T057–T063 | Review `/dev/kit` in both themes |
| B7 | 4 US1 🎯 MVP | T064–T076 | Try it with a real agent client (quickstart §2) |
| B8 | 5 US2 | T077–T086 | |
| B9 | 6 US3 | T087–T095 | |
| B10 | 6r US11 | T096–T101 | P1 complete. Run the crash drill in the `tasklite-coordinator` skill by hand |
| B11 | 7 US4 | T102–T109 | |
| B12 | 8 US5 | T110–T116 | |
| B13 | 9 US6 | T117–T121 | |
| B14 | 10 US7 | T122–T127 | Split in two if the diff gets large: server, then UI |
| B15 | 11 US10 | T128–T133 | |
| B16 | 12 US8 | T134–T137 | |
| B17 | 13 US9 | T138–T141 | |
| B18 | 14 Polish | T142–T149 | |

**Slices after B6 may run in any order that respects** the dependency table below. Don't run two slices at once: they share route and screen groups.

**Prompt for each run** (a Claude worker, which has the Spec Kit skills):
```text
/speckit-implement Batch <Bn>: implement ONLY tasks <Txxx>–<Tyyy> in specs/001-task-lite-v1/tasks.md.
Read .specify/memory/constitution.md and the "Slice rules" section first. Tests first.
Do not edit shared contract files; if you need a contract change, stop and say so.
Stop at the phase checkpoint. Tick off finished tasks in tasks.md.
Open a PR titled "<Bn>: <phase name>" with the checkpoint evidence. Do not queue it.
```

**Gate before merging each batch** (the owner reviews, then queues with `@Mergifyio queue`):
- [ ] CI is green: lint, types, unit, contract (including the description snapshot and token budgets), end to end, and axe.
- [ ] The phase checkpoint is met, with evidence in the PR (test output, screenshots for UI).
- [ ] Only that batch's tasks are ticked, and no shared contract file changed (B1–B6 excepted).
- [ ] For slices: that story's quickstart §4 row passes when done by hand.
- [ ] `/speckit-analyze` shows no CRITICAL findings.

---

## Dependencies and execution order

| Phase | Depends on |
|---|---|
| 1 Setup | — |
| 2 Platform | 1 |
| 3a MCP contracts | 2 |
| 3b API and signatures | 3a (shared types) |
| 3r Recovery contracts | 3a, 3b |
| 3c UI kit and screens | 3b (typed client), 3r |
| 4 US1 | 3a, 3b |
| 5 US2 | US1 (data to show), 3c |
| 6 US3 | US1, US2 (item page) |
| 6r US11 | US1, US2 (Problems, item page, Agents) |
| 7 US4 | US1, 3c |
| 8 US5 | US1, 3c |
| 9 US6 | US1, US2 |
| 10 US7 | US1, US2 |
| 11 US10 | 2, 3c |
| 12 US8 | US1, US4 |
| 13 US9 | US1, US4, US7 (documents) |
| 14 Polish | the stories being shipped |

**Within a phase:** tests (failing) → services → replace stubs or fill handlers → fill screens → checkpoint.

## Implementation strategy

1. **Contracts first (B1–B6).** After B6, the whole interface (38 tools, every route, every screen) exists and is enforced by snapshot and route tests. Slices only add behaviour.
2. **MVP (B7).** Agents coordinate end to end. Validate with a real client.
3. **P1 complete (B8–B10):** the first owner-usable release, including crash recovery.
4. **P2 then P3 (B11–B17),** each behind green CI and the gate.
5. **Polish (B18), then the pilot checklist** (ROADMAP §1). From B8 on, track the remaining batches in Task Lite itself.
