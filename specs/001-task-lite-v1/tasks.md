---
description: "Dependency-ordered task list for Docket (formerly Task Lite) V1 (contracts first, then slices)"
---

# Tasks: Docket V1

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
- [X] T004 [P] Set up Vite, React 19, React Router and TanStack Query in `web/`, with a placeholder route that renders "Docket is running"
- [X] T005 [P] Copy the prototype's `.tl` token block (light, dark, `prefers-color-scheme`) unchanged into `web/src/styles/tokens.css` (UI_SPEC §3)
- [X] T006 Write a multi-stage `docker/Dockerfile` (`node:22-bookworm-slim`, non-root user `docket`, uid 10001) and `docker/compose.yaml`: publish `127.0.0.1:7420:7420`, named volume `docket-data:/data`, a commented-out opt-in extra-backup bind mount, `restart: unless-stopped`, healthcheck on `/healthz`. Add `docker/.env.example` with every variable in BUILD_SPEC §2 Configuration.
- [X] T007 Create the server entry point `server/src/index.ts` serving `/healthz`, `/readyz` (database and docs dir writable, migrations current) and the web build, with SPA fallback
- [X] T008 Create `.github/workflows/ci.yml` on `ubuntu-latest`. One job runs pnpm cache → lint → typecheck → Vitest → `docker build`. A second job starts the image and runs Playwright end to end, uploading the report and traces on failure. Name the jobs so the Mergify queue can require them.
- [X] T009 [P] Set up Playwright in `web/playwright.config.ts`, with `@axe-core/playwright` and a fixture that starts the seeded container. Include one smoke spec ("Docket is running") in `web/e2e/smoke.spec.ts`.

**Checkpoint**: `docker compose up` serves "Docket is running", and both CI jobs are green.

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
- [X] T031 Implement the seed loader in `server/src/db/seed/loader.ts`. It maps `design/sample-data.json` per BUILD_SPEC §8: time shift, decision records `dec_1` to `dec_3`, and the `RCP-19 → RCP-16` link set to `merged`. Add the `docket seed sample` command and `DOCKET_SEED=sample`. **Note from B1:** `.dockerignore` currently excludes `design/`. Re-include `design/sample-data.json` (for example with `!design/sample-data.json`) and copy it into the image, otherwise seeding fails inside the container.

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

- [X] T050 [P] Add a migration (never edit an existing one) and update `server/src/db/schema.ts`. `runs` gets `end_reason`, `parked_reason`, `waiting_on`, `parked_at`, `workspace` (JSON), `orchestrator` (JSON), `brief_document_version_id`, `external` and `unpushed_handled_at`. Add `brief` to the `documents.kind` values. Add the `run_resources` table. `commits` gets `run_id` and `pushed`. Extend `shared/src/enums.ts` with `parked` in the run state, `end_reason`, `workspace_state` and the resource kinds. Add the config keys `DOCKET_PARK_MAX`, `DOCKET_RESUME_UNATTENDED` and `DOCKET_ORPHAN_AFTER` to `server/src/config.ts` and `docker/.env.example`. Extend the migration test.
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
- [X] T079 [P] [US2] E2E: notifications (one per new packet or question, a click opens the target, already-pending items don't notify, the tab title reads `(N) Docket`, with permission denied the status reads "Blocked by the browser"), in `web/e2e/us2-notifications.spec.ts`

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
- [X] T087 [P] [US3] Unit tests for the `submit_packet` guards (blocked, packet already open, nothing declared, a failing check without a gap) and the decision outcomes (approve all; any changes; defer with or without follow-up; mixed; approvals carry forward) in `server/tests/unit/review.test.ts`
- [X] T088 [P] [US3] Unit tests for stale packets (ticket-level and epic-level), fresh-packet requests and deferred-list membership in `server/tests/unit/review-stale.test.ts`
- [X] T089 [P] [US3] MCP contract tests for flows §7.3, §7.4 and §7.9 in `server/tests/contract/us3-review.test.ts`
- [X] T090 [P] [US3] E2E for the packet screen (SC-006: deciding a two-item packet takes at most 4 clicks beyond verification; round selector, disabled submit, the note required for changes, outcome-named button, undo, past-round styling, attachments, 1024 px layout) in `web/e2e/us3-review.spec.ts`

### Implementation for US3
- [X] T091 [US3] Implement the human review service (declare, update or remove the author's own items; locked while `ready`; agents get `forbidden` on owner-added items) in `server/src/domain/human-review.ts`
- [X] T092 [US3] Implement the packet service (`submit_packet` with guards, content hash, snapshots, attachments; stale derivation; `get_review`; `deferred_reviews`) in `server/src/domain/packets.ts`
- [X] T093 [US3] Implement owner decisions in `server/src/domain/review-decisions.ts`:
  - atomic verdicts;
  - changes → a checklist step with `from_review`, or a Bug in Ready with the parent's project, epic and priority, a title of up to 70 characters, and a `relates` link;
  - defer → a follow-up Task in Inbox titled "Verify: …" (60 characters);
  - the outcome, with an undo inverse.
- [X] T094 [US3] Replace the stubs for `declare_human_review`, `update_human_review`, `submit_packet`, `get_review` and `deferred_reviews`, and fill the `review` route handlers
- [X] T095 [US3] Fill the packet screen (queue, packet, decision panel, Viewing group) per UI_SPEC §6.4, and the human review section of the Checklist tab per UI_SPEC §6.3.1

**Checkpoint**: the US1–US3 tests pass. The P1 product is complete.

---

## Phase 6r: User Story 11 · Interrupted work restarts cleanly (P1)

**Goal**: coordinators can re-dispatch every interrupted run from Docket alone, parked workers are never mistaken for finished ones, and nothing is left running unnoticed (owner decision 26; FR-110 to FR-117).

**Independent Test**: spec US11 and SC-014. Dispatch three workers (active; parked on an item; with a dev server and an unpushed commit), restart the service, then re-dispatch from `recovery_report` alone.

**Fills**: `server/src/domain/{runs,recovery}.ts`, `server/src/jobs/sweeper.ts`, `server/src/mcp/tools/{runs,evidence,recovery}.ts`, `server/src/api/routes/recovery.ts`, the Problems rows, the item page's "Where the work lives" block, and Agents → Workspaces

### Tests for US11
- [X] T096 [P] [US11] Unit tests in `server/tests/unit/recovery.test.ts`:
  - parking suspends the lease, and any call with the `run_id` resumes it;
  - `resume_ready` once every `waiting_on` item clears; "unattended" after `DOCKET_RESUME_UNATTENDED`; a Problem after `DOCKET_PARK_MAX`;
  - `end_reason` set on every terminal path;
  - unreleased resources orphaned after `DOCKET_ORPHAN_AFTER`;
  - unpushed at-risk detection (`head_sha` ≠ `pushed_sha`, or `dirty`) and clearing it (a later push, or owner handled);
  - workspace state derivation for every case, including `unknown` when nothing was reported.
- [X] T097 [P] [US11] MCP contract tests for flows §7.12 and §7.13 and MCP_SPEC §10 tests 17–20, in `server/tests/contract/us11-recovery.test.ts`: the brief comes back byte-identical; `finish_run` warns on unreleased resources and unpushed commits; `recovery_report` paging and `include_briefs`; SC-014's crash simulation (three runs, restart, re-dispatch from the report alone)
- [X] T098 [P] [US11] E2E in `web/e2e/us11-recovery.spec.ts`: the Problems rows (orphaned resources, unpushed work may be lost, parked 24 h, ready to resume unattended) with *Mark released* and *Handled* plus undo; the "Where the work lives" block and *Copy resume note*; Agents → Workspaces states; axe in both themes

### Implementation for US11
- [X] T099 [US11] Implement the recovery behaviour in the runs service (`server/src/domain/runs.ts`):
  - workspace, orchestrator, brief (stored as a `brief` document version) and `external` on claim and start;
  - heartbeat workspace patches, `resources_started` and `resources_released` (with events);
  - `park_run`, and resuming on any call;
  - `end_reason` on every end;
  - the `finish_run` warnings;
  - `report_commit` `pushed` → `pushed_sha`.

  Extend the sweeper: suspend leases while parked, and flag ready-to-resume, unattended, parked-too-long and orphaned.
- [X] T100 [US11] Implement `recovery_report`, workspace-state derivation and `Item.resume` in `server/src/domain/recovery.ts`. Replace the `park_run` and `recovery_report` stubs, add the recovery fields to the `claim_lead`, `start_run`, `heartbeat`, `finish_run`, `report_commit` and `get_item` handlers, and fill the `recovery` route handlers.
- [X] T101 [US11] Fill the UI per UI_SPEC: the recovery Problems rows and their actions on Needs you, the "Where the work lives" block with *Copy resume note* in the Lead and runs section, and the Agents → Workspaces card

**Checkpoint**: the US11 independent test passes, and the `docket-coordinator` skill matches the behaviour.

---

## Phase 7: User Story 4 · Dependencies decide what's ready (P2)

**Fills**: `server/src/domain/{links,subgraph}.ts`, the dependency tools in `server/src/mcp/tools/items.ts` and `read.ts`, `server/src/api/routes/deps.ts`, `web/src/components/ProgressMap/` (slice-owned), the Dependencies and Map tabs, Work → Map, the Settings blocker rule

### Tests for US4
- [X] T102 [P] [US4] Unit tests for `satisfied_when`: done, merged and verified; the project default against a link override; verified on a blocker without review items → `validation`; verified with a deferred check → stays blocked plus a Problem; canceled blockers; an archived blocker is not cleared by archiving; re-evaluation and the event. In `server/tests/unit/dependencies.test.ts`.
- [X] T103 [P] [US4] Unit tests for cycle rejection with the path, strongly connected components on imported data, and cross-project blocking in `server/tests/unit/cycles.test.ts`
- [X] T104 [P] [US4] MCP contract test for flow §7.11 and `dependency_subgraph` with `delay_days` in `server/tests/contract/us4-deps.test.ts`
- [X] T105 [P] [US4] E2E: the map (waves, outside column, arrows kept on resize and zoom, hover tracing, pan, Fit), the blocked chip "(needs merge)", the project rule select with undo, cycle fix from the Dependencies tab; in `web/e2e/us4-deps.spec.ts`

### Implementation for US4
- [X] T106 [US4] Implement the link service (`link_items` that creates or updates `satisfied_when`, `unlink_items`, cycle DFS, strongly connected components, the cleared-blocker evaluation per data-model.md) in `server/src/domain/links.ts`, and `dependency_subgraph` (depth 1–5, direction, `date_source`, `at_risk` with `delay_days`) in `server/src/domain/subgraph.ts`. Also add the item-reference write check (MCP_SPEC §3.4): item IDs mentioned in any text field that don't exist are accepted with a `! RCP-99 doesn't exist` warning. Apply it once in the write path so every text-writing tool gets it, and test it (left unassigned by B7).
- [X] T107 [US4] Replace the stubs for `link_items`, `unlink_items` and `dependency_subgraph`, and fill the `deps` route handlers
- [X] T108 [US4] Build the ProgressMap (waves = longest blocks path; 200 px columns, 76 px gap, 16 px rows; canvas at most 540 px tall; zoom steps 50/67/80/100/125, Fit down to 40%; More pills; SVG arrows) per UI_SPEC §6.3.4 in `web/src/components/ProgressMap/`
- [X] T109 [US4] Fill the Dependencies tab (1-hop view with "waiting for merge/verification", cycle callout), the epic Map tab, Work → Map, and the Settings "Blockers clear when" select

---

## Phase 8: User Story 5 · Context in one call, and shared decisions (P2)

**Fills**: `server/src/domain/{decisions,context}.ts`, `server/src/mcp/tools/decisions.ts`, `get_context` in `read.ts`, `server/src/api/routes/decisions.ts`, the Decisions sections

### Tests for US5
- [X] T110 [P] [US5] Unit tests for the context bundle (section order, budgets of 1k/3k/8k, truncation markers, essentials and decisions never cut first, notes counted but not marked read) in `server/tests/unit/context.test.ts`
- [X] T111 [P] [US5] Unit tests for decisions (scope inheritance from project to epic to label to item; agents forbidden on owner records; supersede and withdraw states; confirm) in `server/tests/unit/decisions.test.ts`
- [X] T112 [P] [US5] MCP contract test for flow §7.10 and the `get_context` budget (RCP-14 medium ≤ 3,000). Also turn on the pending SC-001 step in the budget test. In `server/tests/contract/us5-context.test.ts`.
- [X] T113 [P] [US5] E2E: the Decisions section on a ticket (inherited scope chips, Confirm → "Owner", Withdraw with undo, Record form), on an epic and on a label, in `web/e2e/us5-decisions.spec.ts`

### Implementation for US5
- [X] T114 [US5] Implement the decision service (publish, list with `in_scope_of`, withdraw, confirm, supersede, authority rules) in `server/src/domain/decisions.ts`, and the context assembler per BUILD_SPEC §5.15 in `server/src/domain/context.ts`
- [X] T115 [US5] Replace the stubs for `get_context`, `publish_decision`, `list_decisions` and `withdraw_decision`, and fill the `decisions` route handlers
- [X] T116 [US5] Fill the Decisions sections (ticket, epic, label, the Settings project dialog) using the kit's DecisionRow, per UI_SPEC §6.3.5

---

## Phase 9: User Story 6 · The owner steers without a review round (P2)

**Fills**: `server/src/domain/messages.ts`, `ask_owner` and delivery in `get_item`, `server/src/api/routes/steer.ts`, Lead and runs, the History note box, checklist add rows, the inline answer

### Tests for US6
- [X] T117 [P] [US6] Unit tests for exactly-once delivery of answers and notes, one open question per item, and the run going to `needs_input` and back, in `server/tests/unit/messages.test.ts`
- [X] T118 [P] [US6] MCP contract test for flow §7.5 and an old `run_id` after release returning `conflict`, in `server/tests/contract/us6-steer.test.ts`
- [X] T119 [P] [US6] E2E: inline answer, note logged, the release dialog focusing Cancel with undo, Return to Ready, owner adds and removes a work step and a check, in `web/e2e/us6-steer.spec.ts`

### Implementation for US6
- [X] T120 [US6] Implement questions and owner notes (`ask_owner`, answer, delivery marking only in `get_item` standard and full views) in `server/src/domain/messages.ts`. Replace the `ask_owner` stub and fill the `steer` route handlers (answer, notes, release, return-to-ready, and the owner work, check and human-review entries). Reuse B9's `messages.markDelivered`; don't rebuild it. When the owner releases a claim or cancels, emit the run's end event with `data.run_id` and set `end_reason` (`owner_released`, `canceled`), so US11's recovery views see it (B10 note).
- [X] T121 [US6] Fill Lead and runs (conflict callout, error output, release dialog, Return to Ready), the History note box, the checklist add rows, the inline answer in Needs you, and the question banner, per UI_SPEC §6.3.1–2

---

## Phase 10: User Story 7 · Planning and keeping things tidy (P2)

**Fills**: `server/src/domain/{documents,archive}.ts`, cancel and text edits in `items.ts`, `put_document` and `upsert_label`, `server/src/api/routes/{planning,upload}.ts`, quick capture, inline editing, cancel, archive, the label page, viewers

### Tests for US7
- [X] T122 [P] [US7] Unit tests in `server/tests/unit/planning.test.ts` covering:
  - owner cancel (FR-064b): any open item, optional reason; an epic with open children is refused naming them; an active lead run ends `interrupted` and its claim is released; an open packet is withdrawn; undo restores the status but not the run;
  - the archive guards (done only), and archived items excluded from owner views but included in agent queries;
  - owner text edits (limits, secret check, version conflict, undo).
- [X] T123 [P] [US7] E2E in `web/e2e/us7-planning.spec.ts`:
  - Cancel item… (inline confirm focusing *Keep item*, the lead warning, the open-children list, Undo, still found in search);
  - quick capture (title required, lands in Inbox; from an epic you stay on the epic);
  - label page Move N to Ready with undo;
  - Archive and Archive all with undo, the Archived filter, the "+ N archived" fold;
  - the document viewer;
  - inline edit with the conflict callout.

### Implementation for US7
- [X] T124 [US7] Implement the documents service (immutable versions, sha256, 25 MB through MCP, the `/agent-upload` multipart endpoint up to 500 MB, preview MIME handling, `Content-Disposition` and `nosniff`) in `server/src/domain/documents.ts` and `server/src/api/routes/upload.ts`. Replace the `put_document` and `upsert_label` stubs. Serve `brief` documents (written by `claim_lead`/`start_run`) like any other in the document viewer, and refuse `put_document` with kind `brief` (B10 note).
- [X] T125 [US7] Implement owner cancel, archive and unarchive, and owner text edits in `server/src/domain/{items,archive}.ts`, and fill the `planning` route handlers (quick capture, `PATCH` fields, cancel, archive, labels and move-to-ready, document content)
- [X] T126 [US7] Fill quick capture and + New item in this epic; inline editing (title, description, outcome, acceptance; Preview; `Ctrl+Enter`/`Esc`; conflict callout; counters); and the item header's "⋯" Cancel item… flow, per UI_SPEC §6.3 and §6.9
- [X] T127 [US7] Fill the Done column Archive and Archive all actions, the Archived filter, the epic fold-up, the Label page (UI_SPEC §6.5), and the document viewer and Checklist history dialogs

---

## Phase 11: User Story 10 · Running Docket safely (P2)

**Fills**: `server/src/jobs/backup.ts`, `server/src/domain/projects.ts`, `server/src/cli/index.ts`, the `settings` and `diagnostics` route handlers, the Settings and Unlock content, the README, `docker/smoke/`

### Tests for US10
- [X] T128 [P] [US10] Integration tests in `server/tests/integration/us10-ops.test.ts`:
  - **extra backup location:** with it set, the archive appears in both places and the extra copy restores after the data dir is removed; an unwritable extra dir still lets the default backup succeed and raises a Problem;
  - **restore:** a backup restored into a temporary data dir is identical (item, event and document checksums);
  - **project delete:** rows and the docs dir are removed, and the tombstone is retried at startup;
  - **logs:** the call log contains no arguments, and no log contains an `Authorization` value;
  - **deleted IDs:** a deleted project's IDs return `not_found` to agents;
  - **container replacement** (`docker compose down && up` in the CI Docker job) keeps every item, event and document (SC-008).
- [X] T129 [P] [US10] E2E: Settings (projects, connections, snippets showing `$DOCKET_TOKEN`, Reveal token auto-hiding after 30 s, the delete dialog with typed key and focus on Cancel, the backup locations, *Download diagnostic log*), in `web/e2e/us10-settings.spec.ts`

### Implementation for US10
- [X] T130 [US10] Implement the nightly backup in `server/src/jobs/backup.ts` and the CLI in `server/src/cli/index.ts`:
  - `VACUUM INTO` plus a docs tar.gz, with `BACKUP_KEEP` retention;
  - the opt-in copy to `DOCKET_BACKUP_EXTRA_DIR` (a failed extra copy never fails the default backup, and raises a Problem);
  - the CLI commands `backup now`, `restore <file>` (refuses while running; verifies first), `owner-key` and `agent-token`.
- [X] T131 [US10] Implement project delete (transaction plus tombstone, docs removal after commit, retry at startup) in `server/src/domain/projects.ts`, and fill the `settings` and `diagnostics` route handlers
- [X] T132 [US10] Fill Settings (Projects, Connections with the compatibility matrix and snippets, Endpoint, Service health with backup locations, This browser) and the Unlock screen per UI_SPEC §6.7–6.8
- [X] T133 [US10] Write the README quick start (clean machine to connected agent in ≤ 10 minutes, plus the optional extra-backup bind mount) and `docker/smoke/` (a script and checklist per client surface, O07)

---

## Phase 12: User Story 8 · Dates, effort and a forecast (P3)

**Fills**: `server/src/domain/forecast.ts`, the `timeline` route handlers, Work → Timeline, the burn-down card

- [X] T134 [P] [US8] Unit tests in `server/tests/unit/forecast.test.ts`: date risk; burn-down replay from events, with scope additions and the unestimated count; forecast thresholds (≥ 8 estimated items done in the last 4 weeks, across ≥ 2 weeks); Monte Carlo P50/P85 deterministic with a seeded RNG; planned dates unchanged
- [X] T135 [P] [US8] E2E: Timeline (planned and actual bars, set-by only on hover, blocker ticks, risk text, undated list, forecast lane), and the burn-down card with *Show as table*, in `web/e2e/us8-timeline.spec.ts`
- [X] T136 [US8] Implement the timeline query, burn-down and forecast in `server/src/domain/forecast.ts`, and fill the `timeline` route handlers
- [X] T137 [US8] Fill the Timeline layout and the burn-down card per UI_SPEC §6.2.4 and §9.1

---

## Phase 13: User Story 9 · Jira import with a dry run (P3)

**Fills**: `server/src/import/jira/`, the `import` route handlers, the Import dialog

- [X] T138 [P] [US9] Unit tests for every mapping row in BUILD_SPEC §9 (types, status categories, priorities, links, ADF to Markdown losses, sub-tasks as work steps, field detection), using recorded responses in `server/tests/fixtures/jira/`, in `server/tests/unit/jira-map.test.ts`
- [X] T139 [P] [US9] Integration test: the dry run writes nothing; the commit is atomic; the token appears nowhere (grep the data dir and logs); a recorded 500-issue fixture dry-runs in under 2 minutes and accounts for 100% of issues (SC-011); in `server/tests/integration/us9-jira.test.ts`
- [X] T140 [US9] Implement the Jira client (REST v3 search and pagination, links, comments, attachment metadata and download, honouring `Retry-After`; the token held in memory, expiring after 1 h or on cancel), the mapper and the report builder, in `server/src/import/jira/{client,mapper,report}.ts`
- [X] T141 [US9] Implement the commit (one transaction, `jira_key`, `imported`, post-commit attachment download, the report stored as an `import_report` document), and fill the `import` route handlers and the three-step Import dialog per UI_SPEC §9.2

---

## Phase 14: Polish and cross-cutting · M8

**Carry-overs from the slices** (fold these into T142–T149 as they fit, and list each one in the PR as done):
- the kit's archived-card opacity fails axe contrast; B14 overrides it on its own screens. Fix it in the kit (B14);
- `ProgressMap`'s default `outside = []` makes a fresh array each render and loops if a caller omits it (B14);
- check the PDF document preview by hand in Chrome; headless Chromium can't render it (B14);
- map arrows from the outside column run underneath wave-1 cards (B11);
- undoing an owner answer after the agent has read it reopens the question; the receipt isn't an event (B13);
- consider listing earlier document versions in the viewer; only the latest shows today (B14);
- the Timeline shows no indicator of an active epic or label filter (B16);
- the burn-down's "today" uses the server's time zone, while the Now line uses the browser's (B16).

- [X] T142 [P] Accessibility pass: run the axe suite on every route in both themes; keyboard paths (skip link, tabs pattern, map canvas arrows, dialogs); NVDA spot check of the packet flow. In `web/e2e/a11y.spec.ts`.
- [X] T143 [P] Performance check at scale (generate 20 projects, 5,000 items and 100,000 events): owner views under 1 s, agent calls p95 under 500 ms (SC-013), in `server/tests/perf/scale.test.ts` (run on demand)
- [X] T144 [P] Reduced-motion and 1024×900 layout checks (the packet decision panel under the queue) in `web/e2e/layout.spec.ts`
- [X] T145 [P] FR-106 guard: run the contract and e2e suites with the container on an internal network with no egress, and assert no outbound connection attempts (only the Jira fixture may reach out), in `.github/workflows/ci.yml` and `server/tests/integration/no-egress.test.ts`
- [ ] T146 Run the real-client smoke test (installed Codex, installed Claude Code, an Orca worker running Codex, an Orca worker running Claude), fill in the Settings compatibility matrix, and record the BUILD_SPEC §12 verifications V1–V3 and V6
- [X] T147 Stretch: add `docket export` (full JSON plus documents) in `server/src/cli/export.ts`. It is required before the pilot (ROADMAP §1).
- [X] T148 [P] Skills (owner decision 27):
  - **Lint:** `server/tests/contract/skills-lint.test.ts` parses every `skills/*/SKILL.md` and fails if a backticked snake_case name isn't a registered tool, a top-level input field, or an enum value from `shared/`. It also checks that each file has `name` and `description` frontmatter.
  - **Eval:** script the US1 and US11 scenarios against the seeded server with a real client, with and without `docket-worker` and `docket-coordinator`, and record calls, tokens and mistakes in the PR. The skills must do at least as well as without them, and meet the SC-001 budget.
  - **Fix and verify:** fix any skill text the eval shows is wrong, and record V7 (where each client loads skills).
- [X] T149 Run the quickstart.md validation end to end, and run `/speckit-analyze` until there are no CRITICAL findings

---

## Phase 15: Help and agent setup (owner decision 29)

**Contracts first**, as for every other change: B21 lands the schema, routes, the `get_context` contract change and the snapshot, then the slices fill them.

- [X] T150 [contract] Migration for `agent_files`, `agent_file_versions`, `project_workflows` and `installs` (BUILD_SPEC §4); route schemas and 501 placeholders for every §7 decision-29 route, including `GET /install/:token`; config keys `DOCKET_PUSH_ROOT` and `DOCKET_PUSH_HOST_PATH`; the typed client entries. Tests: migration (fresh and current-main databases), route contract.
- [X] T151 [contract] `get_context`: add `workflow` to `ContextBundle` (MCP_SPEC §4), its compact renderer, the description change in `mcp-copy.ts` and MCP_SPEC §5.2 (the same PR), and the snapshot and budget tests. Return `workflow: null` until T157 fills it.
- [X] T152 [US12] Help center: `docs/help/*.md` articles (at least: connect an agent, review a packet, run states, workspaces and safe pruning, crash recovery, blocker rules, decisions, Jira import, backup and restore, agent setup), bundled into the web build; `/help`, `/help/:slug`, palette results, and contextual "?" side panels per UI_SPEC §6.7c. E2E plus axe.
- [X] T153 [US13] Agent files service: bundled loading at startup (with new-version detection), layers and resolution, versions, revert, diff, and the bundled-updated flag (BUILD_SPEC §5.17). Unit tests for every resolution and upgrade case.
- [X] T154 [US13] Agent setup UI per UI_SPEC §6.7b: the file list, file view with layers, edit, history and diff, and the project section (effective set, Workflow notes editor). E2E plus axe.
- [X] T155 [US13] Install: the bundle builder (layout per client and target, marked AGENTS.md section, manifest), the single-use download token, the PowerShell and bash commands, and the install log. Tests: bundle contents, marker insertion and replacement, token expiry and reuse refused, nothing outside the markers changed.
- [X] T156 [US13] Push install and check: the push-root guard (no paths outside it, no symlinks out, never delete), *Test*, writes, and the diff check; the copy-paste check command. Tests on a temporary push root, including path-escape attempts.
- [X] T157 [US13] Fill `workflow` in the context bundle (truncated last among sections 1–5) and the Workflow notes routes; a contract test that `get_context` for a project's item includes its notes.
- [X] T158 Update the `docket-coordinator` and `docket-worker` skills (and `skills/README.md`) to mention Workflow notes and Agent setup installs; update the README's install section to point at Agent setup. Keep the skills lint green.

## Phase 16: Agent proposals and drift (owner decision 30)

- [x] T159 [contract] Spec plus code in one PR (the snapshot reads MCP_SPEC): migration (`agent_file_proposals`, `instruction_reports`, `drift`); the MCP tools `get_agent_files` and `propose_agent_file_change` with exact descriptions; `claim_lead.instructions` with its description update; the new server-instructions bullet; route schemas and placeholders for proposals and drift; config `DOCKET_DRIFT_CHECK_INTERVAL`; events (`agent_file.proposed`, `agent_file.proposal_decided`, `drift.detected`, `drift.resolved`); client entries. Snapshot 38 → 40 tools.
- [x] T160 [US14] Proposals: the service (read, propose, approve, edit then approve, decline, three-way basis, limits, write checks); the tools; the owner routes; and the UI per UI_SPEC §6.7b-1, including the Needs you line. Tests, e2e and axe.
- [x] T161 [US14] Drift: the scheduled push-folder check; instruction reports from `claim_lead`; drift records and remedies (*Adopt*, *Restore*, *Keep local*, with the accepted hash); the Problems row; run instruction display; and the installed `docket-check` script that produces the report (PowerShell and bash, with content only for differing files). Tests, including the SC-017 drift suite.
- [x] T162 [US14] Update the skills (worker: report instructions on claim, and propose instead of editing; coordinator: drift remedies), the AGENTS.md block, `skills/README.md`, the README, and the Agent files help article. The skills lint stays green.

## Phase 17: Onboarding (owner decision 31)

- [x] T163 [contract] Migration (`onboarding_sessions`, `projects.created_by`); the MCP tools `onboard_project` and `finish_onboarding`, with exact descriptions; the `onboard` prompt (the server's prompts capability); the server-instructions bullet; route schemas and placeholders (`POST /api/projects`, onboarding list and review); events (`project.created`, `onboarding.started`, `onboarding.finished`, `onboarding.reviewed`); client entries. Snapshot 40 → 42 tools plus 1 prompt.
- [x] T164 [US15] New project (the owner route and the Settings dialog), `onboard_project` (create or adopt, session, existing counts, the guide), `finish_onboarding`, session tagging of changes, the `onboard` prompt, and the bundled `docs/templates/ONBOARDING-guide.md` as agent file `guide:onboarding` (editable, per project too). Owner-only project settings and delete stay enforced. Tests.
- [x] T165 [US15] The onboarding review card on Needs you, the "created by agent" chip, and *Install agent files* from the card. E2E, plus the SC-018 fixture: a Jira fixture import followed by onboarding a fixture Spec Kit repo, with no duplicates.
- [x] T166 [US15] The Help article "Onboard a project", the README quick start for a new project, and the skills (the coordinator can onboard; the worker points to it). The skills lint stays green.

## Phase 18: Local trust and connection files (owner decision 32)

- [x] T167 Trust mode: `DOCKET_PROTECTED_MODE` (default off). In local trust, the owner API needs no session (CSRF still applies to browser requests), `/mcp` needs no token, and the Unlock route redirects home. Owner actions record `via` (browser or script plus user agent), shown in Activity. Protected mode keeps today's behaviour exactly. The Settings Security line and protected-only controls. Tests for both modes, including that the Host and Origin guards still refuse in local trust.
- [x] T168 Connection files in the install bundle and push install: write and merge `.mcp.json` and `.codex/config.toml` (only the `docket` entry; refuse invalid files; never a secret; the env-var token in protected mode); manifest, *Check* and drift coverage; the Install dialog text. Tests for merging into existing files, and a real check that Claude Code and Codex pick them up (headless, with temporary config).
- [x] T169 Docs: the README quick start (no commands beyond starting Docket), Help ("Connect an agent", "Security and protected mode"), the skills' setup notes, the smoke checklist, and the Settings compatibility notes. Remove the token from the default quick start.

## Phase 19: Step details (owner decision 33)

- [x] T170 [contract] Migration: `work_steps.details_md`, `source` and `details_version`. Shared types (`WorkStep`: `source`, `has_details`, optional `details_md` and `details_version`); `set_plan` and `update_step` inputs; the new read tool `get_step`; the description changes for `set_plan`, `update_step` and `get_item`, plus `get_step`'s description; the compact renderer's `· details` marker; the owner API for editing step details (route schema plus a 501 placeholder); the client entries. Snapshot 42 → 43 tools. Budgets unchanged for `get_item` standard. B33 went further than the contract, so T171 is smaller: `set_plan` and `update_step` store details and source (patch semantics, the write checks), `get_step` is implemented with its history, the owner route is implemented with its version check (not a 501), and the budget test with 10 detailed steps is in. Left for T171: `get_context` with the current step's details.
- [x] T171 [US16] Service and tools: details and source in `set_plan` (patch semantics, carried across revisions) and `update_step`; `get_step` with history; `get_context` including the current step's details; the owner edit route with a version check; write checks. Tests, including the token budgets with 10 detailed steps.
- [x] T172 [US16] The step dialog per UI_SPEC §6.3.1a, and the details icon on rows. E2E plus axe.
- [x] T173 [US16] The Jira import: sub-task details (header line plus converted description), source, and the "Comments from Jira sub-tasks" note on the parent. The report's wording ("Imported with changes: became checklist steps; description and comments kept"). Fixture tests for SC-020. Help ("Jira import", "Checklist"), the worker skill (put long step context in details), and BUILD_SPEC §9.

## Phase 20: Install and onboarding follow-ups (owner decision 34)

- [x] T174 [contract] Spec plus code in one PR: decision 34 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; `POST /api/installs` takes `clients` (`client` still accepted) and returns `clients` (each client's files); `GET /api/install-state`; the MCP tool `apply_batch` with its description, and the `set_plan` and `update_step` description changes. Snapshot 43 → 44 tools.
- [x] T175 [US17] Several clients per install (push planned for every client first; one command token with per-client row hashes and a wrapper bundle that checks every client first) and install state from the manifest and drift (`outdated`, open drift, markers and defaults from a push-folder repo). Tests, including the real bash and PowerShell commands.
- [x] T176 [US17] `CLAUDE.md` imports an existing `AGENTS.md` (`@AGENTS.md`, outside the markers, never added to an existing file), in push and both install steps. The Install dialog (checkboxes with state chips, the defaults, the verb-aware button, the one summary) and the Agent files install state card. Help ("Agent files"). Screenshots in both themes.
- [x] T177 [US17] `apply_batch`: up to 100 operations, each validated and written as its single call, atomic per operation, `$n` references, derived idempotency keys, per-operation results; its budget (30 + 25 per operation). The onboarding guide and `docket-planner` use it. Tests, including SC-021 (160 operations in one session).
- [x] T178 [US17] Imported steps take added details from agents (`set_plan`, `update_step`): set or extend only, history "details added by <agent>", text and owner-typed steps stay protected. Tests.

## Phase 21: Approve with notes (owner decision 35)

- [x] T179 [contract] Spec plus code in one PR: decision 35 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.6, UI_SPEC §6.4, FR-154–FR-157 and US3 scenario 8. `approve` verdicts take an optional `note` and, only with a note, `keep` (`item`, `epic` or `project`); the "Not used for approve" refusal goes. The packet's verdicts gain `keep` and `decision_id`; Activity rows gain an optional `decision_ids`. No MCP tool changes: agents already receive owner notes and the decisions in scope.
- [x] T180 [US3] The service: the note on the verdict, the "Approved with a note: …" owner note, and for `epic` or `project` an owner decision in the same transaction (title from the note, ≤ 120 at a word; the "From your review of …" rationale; `decision.published` with `from_review`; the review event's `kept`), refused for `epic` without an epic. The packet: "Notes for later (optional)" and "Keep it for" on *Looks good* (disabled epic choice with its reason), the note and decision link in past rounds, the History link. Tests: schema, service (each `keep`, no epic, undo), UI (keyboard).
- [x] T181 [US3] E2E: approve with an epic-scoped note by keyboard, axe in both themes, the past round, the epic's decision, and `get_context` on another ticket in the epic; the disabled epic choice. Help ("Review a handoff packet": Approve with notes). Screenshots in both themes.

## Phase 22: Shared changes and conflict guardrails (owner decision 36)

- [x] T182 [contract] Migrations for the tables in BUILD_SPEC §5.21. Shared types and zod; the new MCP tools (`declare_shared_changes`, `list_shared_parts`, `take_lease`, `release_lease`) and the changes to `claim_lead`, `set_status` (to `ready`, and `changed_files` and `branch` to `done`), `submit_packet` and `get_context`; the new error codes; the descriptions in MCP_SPEC and the snapshot; owner API route shapes (registry, declarations, overlap decisions, undeclared decisions, lease release, radar settings and run); the client entries.
- [x] T183 [US18] Service: the registry, declarations, the Ready gate (with owner override), the overlap check at claim with questions and decisions, leases with expiry, the changed-file mapping and hold at hand-off, and `get_context.shared` within budget. Tests, including an unattended two-agent scenario (SC-023).
- [x] T184 [US18] The conflict radar: the scheduler, git `merge-tree` with a temporary object directory (proven read-only: the repo's `.git` is unchanged byte-for-byte), findings, clearing, the "Radar off" state, and git in the image. Tests against a fixture repo with conflicting worktree branches.
- [x] T185 [US18] UI per UI_SPEC §6.3.6 (Shared changes, Needs you cards, card markers, the Settings registry and radar); Help ("Shared changes and conflicts"); the planner and worker skills (declare before Ready, pick other work on `seam_conflict`, take the lease before generating a migration, report `changed_files` and `branch` at hand-off, on `submit_packet` or `set_status` to `done`); the onboarding prompt (propose a starter registry from the codebase's hot files). E2E plus axe.

## Phase 23: Problems that say what to do (owner decision 37)

- [x] T186 [contract] Spec plus code in one PR: decision 37 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.22, §5.21 B42, §5.15 4c, §7; MCP_SPEC §5.16; UI_SPEC §6.1, §6.3, §6.3.6, §6.7c; FR-165–FR-172, US18 scenarios 7–9, SC-024. Migration `0013_problem_handling` (`problem_acks`, `resolutions`); `DOCKET_AGENT_PROBLEM_GRACE_HOURS`; the Problems row's optional `id`, `explanation`, `reached_you`, `branches`, `acknowledged`, `resolution`; Needs you's `agent_problems`, `acknowledged`, `resolutions`; the item's `problems` and `resolutions`; `POST /api/problems/acknowledge`, `POST /api/resolutions/:id/decide`; `propose_resolution` (snapshot 48 → 49) and `get_context`'s `problems` and `resolutions`; three event types.
- [x] T187 [US18] The service: the explanation for every kind (domain/problems.ts), agent problems routed to the leads (grace period, no lead), acknowledgements with the material-change rule, proposed resolutions and decisions with owner notes; the radar: pairs explained by main left out, findings cleared when a branch stops being reported, one note per item. Tests: every kind's text, the routing (time-controlled), the no-lead routing, *Remind the agent*, *Not an active branch* with Undo, the suppression on the Gameflow-like fixture, the immediate clearing, the acknowledgement rule, propose → a different way → propose again → approve.
- [x] T188 [US18] UI per UI_SPEC §6.1 and §6.3: the three lines on every row and card, the agent actions, "Agents are handling N problems", "You acknowledged N", proposal cards, the item's problem banner (`?problem=`). Help ("Problems and what to do"; the Problems anchors move to it). Worker and planner skills (`propose_resolution`, routine fixes need none, the radar's note).
- [x] T189 [US18] E2E: the banner with *Remind the agent*, *Not an active branch* and Undo, *Acknowledge*, and propose → a different way → propose again → approve, axe in both themes; the sweep spec stays green.

## Phase 24: Work filters and the Epics strip (owner feedback, Gameflow pilot)

- [x] T190 [US2] Spec plus code in one PR: UI_SPEC §2 (persistence, route) and §6.2 (the filter row, the Epics row, the Done column); Help ("Your first look around" → Filters on the Work page); BUILD_SPEC §7 and §13. `shared/src/work-filter.ts` (quick filters, checks, shows, counts, the old `filter=` mapping); `GET /api/work` takes `quick`, `has` and `show` and returns the new `filter_counts`; canceled items return under *Shows canceled*. No MCP changes.
- [x] T191 [US2] UI: the Active, Blocked and In progress chips; the Filters menu (ARIA menu button, `menuitemcheckbox`es with counts, the keyboard); pills and *Clear*; the URL with Back and Forward, the last choice per project in `localStorage`, old links rewritten in place; done epics behind *Show N done*; the Done column's *Show N done*; a Canceled column under *Shows canceled*.
- [x] T192 [US2] Tests: the model, the URL round trip and the old-link mapping (shared), the API (server), the state, storage, menu keyboard and Epics strip (web); e2e on the stress seed: done epics and the toggle, each quick filter, a menu combination from the keyboard, pills, *Clear*, the remembered choice, old links, 1024 px, axe in both themes; the sweep stays green.

## Phase 25: Project decisions get their own page (owner decision 38)

- [x] T193 [US5] Spec plus code in one PR: decision 38 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §4, §5.14, §7, §10; MCP_SPEC §4 (EventType) and §5.8 (no tool changes); UI_SPEC §2, §6.1, §6.3.5, §6.3.7, §6.7; FR-173–FR-176, US5 scenario 6; Help ("Decision records"). Migration `0014_project_decision_review` (`acknowledged_at`, `review_grouped`, set for existing agent project records); `POST /api/decisions/acknowledge`; Needs you's `project_decisions` and `project_decision_groups`; the event type `decision.acknowledged` (owner only; the tools-list snapshot gains one enum value).
- [x] T194 [US5] UI: ticket and epic Decisions list their own scopes with "N project decisions also apply · View"; the project Decisions page (`/projects/:key/decisions`, *All* / *Needs your review*, `?decision=`); the Needs you cards (one per new agent project decision, one grouped card per project for older ones) with *Confirm*, *Withdraw…*, *Acknowledge*, *Open*, *Review*, *Acknowledge all*; links from the switcher, Settings → Projects and Help.
- [x] T195 [US5] Tests: acknowledge and the card rules (server), the filtering, the line and its count, the page and the cards (web); e2e `b44-project-decisions` with axe in both themes; the sweep spec stays green.

## Phase 26: Overlaps reach the owner only when they need the owner (owner decision 39)

- [x] T196 [contract] Spec plus code in one PR: decision 39 in REQUIREMENTS_DRAFT and the BUILD_SPEC log, amending 36; BUILD_SPEC §5.21 B46; MCP_SPEC §5.15 (declaration inputs, classification in outputs, descriptions, snapshot); UI_SPEC §6.3.6, §6.7; Help; the planner and worker skills. Migration `0015_overlap_autonomy` (additive).
- [x] T197 [US18] Service: members and `design_impact` on declarations; the classification at claim, on declaration changes and at hand-off; automatic sequences with `merged` blockers; the radar's merge order and its runs on reported branches and commits; Overlap handling (global and per project); overrule with undo; Docket attribution. UI: the ticket's outcomes, the Needs you line, the Settings card, the declaration editor.
- [x] T198 [US18] Tests: every classification path; the same-line add-only fixture (a text conflict with a merge order, no owner card, neither agent stopped); the clean-merge same-member fixture (sequenced); `changes_approved_design`; all three settings, global and per project; overrule and undo; an unattended multi-agent run; migration of existing overlaps; e2e `b46-overlaps` with axe in both themes; the sweep spec stays green.

- [x] T199 [US18] A change to an approved design always reaches the owner, with or without an overlap and in every mode (owner correction to decision 39): `design_reviews`; the `design_review` error; held packets; a Needs you card and ticket banner with *Approve the design change* and *Send back*; tests for no overlap, overlap, already claimed, approve, send back, re-declare and every mode; e2e with axe in both themes.

## Phase 27: One status colour system; map arrows route around cards (owner feedback, Gameflow pilot)

- [x] T200 [US4] Spec plus code in one PR: UI_SPEC §3, §5 (the status palette) and §6.3.4 (bar, spacing, arrows); UI_DESIGN; Help ("Blocker rules and dependencies" → Reading the map); the prototype's token block. No MCP change.
- [x] T201 [US4] One status token set (`--st-<status>`, `-soft`, `-text`, light and dark) used by chips, the shared `StatusBar` (Map, epic cards, Settings), legends and card edges; `--teal` removed; Blocked is its own red, Canceled is hatched. `routing.ts`: a pure, deterministic layout with barycenter ordering, shared rows, lanes in gutters and channels, and ports spread across card edges.
- [x] T202 [US4] Tests: the palette over the real tokens (CIEDE2000 at least 20, at least 12 under deuteranopia and protanopia, WCAG AA, both themes); sampled arrow geometry for a Gameflow-like epic, the STR epic's shape and 200 seeded DAGs; determinism; performance at 5,000 cards; e2e `b47-map-routing` (arrows clear of cards at every zoom and Fit, hover and keyboard tracing, shared tokens, axe in both themes); the sweep spec stays green.

## Phase 28: Coordinators get what they need with far fewer tokens (owner decision 40)

- [x] T203 [US1] Spec plus code in one PR: REQUIREMENTS_DRAFT decision 40, BUILD_SPEC (§2, §5.11, §12 V6, §14), MCP_SPEC (§3, §5.2, §10, §11), Help (Connect an agent), the skills and the AGENTS.md block.
- [x] T204 [US1] Waiting: `GET /agent/changes/wait` on one event-driven waiter set, `get_changes { wait_s }` (≤ 45 s, below the measured client limit) and the installed `docket-wait` (`.sh`, `.ps1`), in the manifest and covered by *Check* and drift. `get_digest`: one capped snapshot with a cursor.
- [x] T205 [US1] Compact tool definitions (shorter descriptions, lean input schemas, top-level output schemas, Codex text-only), a contract budget, skill line and token caps, and a scripted coordinator scenario on a Gameflow-sized fixture reporting old path against new.

## Phase 29: Survive restarts, catch up backups, truthful Needs you (owner decision 41)

- [x] T206 [US11] Spec plus code in one PR: decision 41 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §2, §5.3, §5.13, §5.16, §5.22; MCP_SPEC §5.9; UI_SPEC §6.1; spec FR-188–FR-195; Help (Problems and what to do, Recovering after a crash, Backups, Run states) and the coordinator skill.
- [x] T207 [US11] Runs survive a restart: the boot sweep keeps open runs with a lease of at least `DOCKET_RESTART_GRACE_MINUTES`, one `service.restarted` event, and normal lease expiry for a run that never returns. Child runs get a stored restart deadline: a signal continues them, and silence ends them as interrupted without affecting the parent.
- [x] T208 [US10] Backups: a wall-clock scheduler with one catch-up, tries kept across restarts, and the `backup_missed` Problem.
- [x] T209 [US18] Needs you: parked and unpushed Problems routed to agents first, the read-only git check, canceled and deferred wording, *Keep for later* and *Safe to discard* with undo, and one count for the badge, the tab title and the page.

## Phase 30: Status follows what agents are doing (owner decision 42)

- [x] T210 [US11] Spec plus code in one PR: decision 42 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.16, §5.23; MCP_SPEC §5.4; UI_SPEC §6.3.2, §6.7, §6.7b; spec FR-196–FR-200; Help (Run states, Connect an agent) and the worker and coordinator skills.
- [x] T211 [US1] Per-launch connections verified on Claude Code and Codex with temporary homes; `LAUNCH_SNIPPETS` on Agent files and in the coordinator skill.
- [x] T212 [US11] `update_run_status`: a named coordinator updates a run without its `run_id`, with attribution and no other power.
- [x] T213 [US11] Activity detection: read-only git, item events and cleared blockers, one event per flag, no flapping.
- [x] T214 [US1] Producer holds across worker handoffs, keeping one active lead and every protection.
- [x] T215 [US11] Only mutating calls resume a parked run; every read tool leaves it parked.
- [x] T216 [US11] Scripted replays of GF-269, GF-336 and GF-280, including a restart.

## Phase 31: The Overview page (owner decision 43)

- [x] T217 [US2] Spec plus code in one PR: decision 43 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.24; UI_SPEC §2, §6.1; spec FR-201–FR-205; Help (Your first look around, Run states, Problems); the design file marked built.
- [x] T218 [US2] The read API: `GET /api/overview` and `/api/overview/items`, each metric defined once, read-only, with unit tests for handoffs, reopened and canceled tickets, epics and imports.
- [x] T219 [US2] The page at `/`: four numbers, every owner action, Health, completed per day, workload by epic, the Planning and Deferred lists; the time window; `/overview/:metric`; `/needs-you` redirects.
- [x] T220 [US2] Tests: every owner action from Overview, the badge invariant, links, e2e on the seeded and STR data, axe in both themes at 1440 and 1024 px, and the sweep.
- [x] T221 [US2] One count of agents: the sidebar badge, the Overview card and the Agents page's line read `agents_now` from one response; the Agents lists are labelled as runs; invariant tests across All projects and one project, through handoffs and parks.

## Phase 32: Time-limited coordinator parking (owner decision 44)

- [x] T222 [US11] Spec plus code in one PR: decision 44 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.25; MCP_SPEC §5.4; UI_SPEC §6.3.2; spec FR-206–FR-210; Help (Run states, Connect an agent); the coordinator and worker skills.
- [x] T223 [US11] `update_run_status` gains `park_minutes` (no new tool): park, renew and end early, with decision 42's authority, the two named limits refused rather than clamped, and migration `0020` (`runs.coordinator_park`).
- [x] T224 [US11] Expiry in the sweep and at boot: back to open on the restart-grace lease, one `run.park_expired`, then the normal `lease_expired` path for a dead run. The run's own `park_run` replaces the limit.
- [x] T225 [US11] Show it: "Parked by X until T" on the item, in `get_item`, `get_digest` and `get_context`, within their token budgets. An expired park is the coordinator's until the normal routing applies.
- [x] T226 [US11] Tests: authority, each limit, renewal, early end, expiry for a dead and a live run, restart before and after the deadline, own park, reads, digest and token budget, no double processing, and part leases.

## Phase 33: Make a parked story's wait visible (owner decision 45)

- [x] T227 [US11] Spec plus code in one PR: decision 45 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.26; MCP_SPEC §4, §5.2, §5.4; UI_SPEC §6.3.2; spec FR-211–FR-216; Help (Problems, Run states); the coordinator and worker skills; `docs/design/wait-and-backlog-followups.md` (proposed, not built).
- [x] T228 [US11] The wait card, derived from stored facts: what it waits for, first-parked time through re-parks, next action's owner along a bounded, cycle-safe chain, the exact resume sentence, and a one-line hint when a blocker was linked after the claim, in `park_run`, `get_digest`, `get_context` (the item and its blocker) and the item page.
- [x] T229 [US11] `wait_no_next_step` and `wait_owner_unasked` in the two-minute job, with no git and migration `0021`: raised once, cleared when the condition ends, kept through a short re-park.
- [x] T230 [US11] Routing through decision 41's Problems, one `run.wait_flagged` per flag, and one `run.resume_ready` the coordinator relays to the same run and dispatch.
- [x] T231 [US11] Replays of GF-243 → GF-381 and GF-229 → GF-382 with real IDs and times and synthetic text, failing before B54, plus the negatives: a cited decision, a pending proposal, a live lead, a blocker being shaped and a cycle. Token budgets hold.

## Phase 34: Wake the right session when the owner answers (owner decision 46)

- [x] T232 [US6] Spec plus code in one PR: decision 46 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.27; spec FR-217–FR-223; Help (Questions and notes); `tools/docket-relay/README.md`. No skill change: the message says what to do.
- [x] T233 [US6] `tools/docket-relay`: the long-poll with reconnect, the owner-side filter, per-ticket batching, and the immediate path for answers and `run.resume_ready`. No server change.
- [x] T234 [US6] The target resolver and delivery: a live dispatch, then its coordinator, then undelivered; a pointer with no content; no shell; bounded retries; a rate limit per session.
- [x] T235 [US6] Reliability and visibility: atomic state outside the repo, no replay on first run, 24-hour catch-up, no duplicates across restarts, one instance, `status`, a capped log, `test-send`, and the Windows auto-start steps.
- [x] T236 [US6] Tests with a fake feed and a fake `orca`, plus the real app for the event wording and to prove a relay read delivers nothing; event-to-send latency measured.
- [x] T249 [US6] B55b, coordinators only: remove the implementer route; use only the Run `worker-show` reports for the recorded dispatch, and never a stored Run ID or session address; always use the coordinator wording; refuse anything but a `run:` address in `orca.send` and `test-send`. BUILD_SPEC §5.27 and T26, the README and Help in the same PR.
- [x] T250 [US6] B55b, `hold_reconcile`: at 24 hours or more since the last feed read, or with an untrusted state or cursor, send nothing and keep the cursor; `status` reports what waits with no content; `reconcile --deliver` or `reconcile --skip-to-end --reason <text>` is the only way out; held batches never expire quietly.
- [x] T251 [US6] B55b tests: every routing fallback, no `dispatch:` send on any path, `test-send` refusal, the hold at and over 24 hours, untrusted state, no send or cursor move in a hold, both reconcile paths, a coalesced restart inside the window, and a hard kill mid-send.
- [x] T252 [US6] B55b review fixes: never trust a persisted send; check state invariants; make entering a hold atomic with sending; an uncapped append-only skip audit; a hidden launcher that returns Node's exit code; a graceful `stop` over the pipe; and scripted stop, disable, verify and remove with proofs that never kill a process or delete recursively. What only the real host can prove is listed as required post-install checks in the README.

## Phase 35: Overview fixes from the owner's feedback (polish within owner decision 43)

- [x] T237 [US2] Spec plus code in one PR: UI_SPEC §2, §6.1, §6.6; BUILD_SPEC §5.24; the Overview design note; Help (First look around, Run states, Workspace states). No MCP tool or migration change.
- [x] T238 [US2] The open-ticket tab strip doesn't show on Overview, and the open tabs survive going there and back.
- [x] T239 [US2] The Agents card becomes **Tickets with agents** ("N being worked", "M parked/waiting"), from the same `agents_now`; the sidebar badge, Agents page and lists use the same words, with a note that it counts tickets, not sessions. No session count.
- [x] T240 [US2] The Completed chart: a whole-number vertical axis, and a tooltip by hover and keyboard naming each bucket's tickets (bounded in the read API), which stays on-screen and is in the text alternative.
- [x] T241 [US11] The at-risk line says which worktrees need the owner: `at_risk_owner` on `GET /api/workspaces`, from the existing Problems routing, with a *What to do* column. The Needs you badge doesn't change.
- [x] T242 [US2] Tests: unit, API, e2e and axe in both themes at 1440 × 900 and 1024 px, the UI sweep, and screenshots on the stress data.

## Phase 36: Questions the owner can actually read (owner decision 47)

- [x] T243 [US6] Spec plus code in one PR: decision 47 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.28; MCP_SPEC §2, §3, §5.7 and §7.5; UI_SPEC §6.1 and §6.3; spec FR-224–FR-229 and SC-027; Help (Questions and notes).
- [x] T244 [US6] The `ask_owner` contract, its limits, the plain-language guard and the error that teaches the old shape. Still 51 tools.
- [x] T245 [US6] Migration 0022 (`questions.form`, `questions.answer_choice`), the option answer, and delivery to text-only and structured clients.
- [x] T246 [US6] The answer dialog on Needs you and the item page: option cards, note, *Something else*, Undo, keyboard and focus, both themes, 1024 px and 1440 × 900.
- [x] T247 [US6] `docket-worker`, `docket-coordinator`, `docket-lead-subagents` and the MCP instructions: check first, decide what you can, ask only what needs the owner, write for someone who has not seen the work.
- [x] T248 [US6] Tests: contract, limits, guard, old shape, delivery, the dialog by mouse and keyboard, older questions, token budgets, e2e and axe in both themes.

## Phase 37: Flow trends and a daily brief (owner decision 48)

- [x] T249 [US2] Spec plus code in one PR: decision 48 (B59's part) in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.29 and §7; UI_SPEC §6.1 and §6.1b; spec FR-230–FR-235 and SC-028; Help (A first look around). No MCP tool changes.
- [x] T250 [US2] `domain/flow.ts`: finished, recorded merges and parks over Overview's buckets, what's missing from the merge record, and the divergence note.
- [x] T251 [US2] `GET /api/brief` and `domain/brief.ts`: local day boundaries, finished, what's stuck, decision changes, and `held_by` read as optional until B58 lands.
- [x] T252 [US2] The Flow chart on Overview, sharing its tooltip behaviour with Completed: keyboard, focus, text alternative, both themes, 1024 px and 1440 × 900.
- [x] T253 [US2] The daily brief page: day picker, four sections, every line linked, no cost section.
- [x] T254 [US2] Tests: metrics with empty windows, timezone boundaries and excluded epics; the chart's tooltip and table; the brief with and without data; e2e and axe in both themes.

## Phase 38: Truthful waits, expired leases and a true Ready (owner decision 48, B58)

- [x] T255 [US18] Spec plus code in one PR: decision 48 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.21, §5.26 and §5.30; MCP_SPEC §5.2; UI_SPEC §6.1 and §6.2; spec FR-236–FR-241; Help and the coordinator skill.
- [x] T256 [US18] Waits: a bare person wait is never an unasked decision, a cited active decision settles a wait, and `WaitCard.held_by` carries an active owner decision.
- [x] T257 [US18] An owner-held run doesn't escalate or get told to resume; lifting the decision restarts aging; existing false flags clear once.
- [x] T258 [US18] The sweeper ends expired part leases, parked holders included, with one `lease.ended` naming the coordinator.
- [x] T259 [US18] Startable and Waiting on Work's board, filters and counts; ranked `next_work` and `bottlenecks` in `get_digest`; Overview's link.
- [x] T260 [US18] Tests and replays with synthetic text, token budgets, unit and e2e on CI, and evidence at 1440 x 900 and 1024 px in both themes.

## Phase 39: Critical path and worktree cleanup (owner decision 48, B60)

- [x] T261 [US4] Spec plus code in one PR: decision 48's B60 part in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.31 and §5.32; MCP_SPEC (no tool change); UI_SPEC §6.3.4 and §6.6; spec FR-242–FR-249 and SC-029; Help.
- [x] T262 [US4] The critical path read on `BlockIndex`: longest chain, cycles, ties and the reason for the ticket to move next.
- [x] T263 [US4] The Map: choose a goal, highlight and mute, step labels, the ordered list, and links from the ticket and epic pages.
- [x] T264 [US11] The worktree scan: bounded read-only git in the push folder, batched commit facts, per-worktree and whole-scan time limits.
- [x] T265 [US11] The verdicts, reusing the at-risk rules and owners, and a command only for Safe to remove.
- [x] T266 [US11] Agents → Workspaces → Every worktree: grouped, filterable, hundreds of rows.
- [x] T267 [US11] Tests: chain selection, ties, cycles, reasons; each verdict on fixture repositories, timeouts, paths outside the root, `.git` hash proof; e2e and axe in both themes at 1440 × 900 and 1024 px on the stress data.

## Phase 40: Split a ticket and withdraw a question (owner decision 48)

- [x] T268 [US6] Spec plus code in one PR: decision 48 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.33; MCP_SPEC §4, §5.3 and §5.8; UI_SPEC §6.3; spec FR-250–FR-255; Help and the skills.
- [x] T269 [US6] Migration 0023 (`items.split_from`, `packets.criteria_changed_at`, the `questions` withdrawal columns, the rebuilt one-open index).
- [x] T270 [US6] Withdraw a question through `withdraw_decision`: authority, reason, event, Needs you and every "open question" read. Still 51 tools.
- [x] T271 [US6] Split a ticket through `create_item` `split_from` and `POST /api/items/:id/split`: atomic, no criterion lost, relations, live lead, packets, overlaps and undo.
- [x] T272 [US6] The split dialog on the item page, provenance in the header, Withdrawn in History: keyboard, both themes, 1024 px and 1440 × 900.
- [x] T273 [US6] Tests: authority, withdraw then ask again, atomicity and rollback, every criterion preserved, each relation, live lead, stale version, out-of-date packets, undo, token budget, e2e and axe in both themes.

## Phase 42: Real token use per ticket and epic (owner decision 48, B63)

- [x] T278 [US2] Spec plus code in one PR: decision 48 (B63's part) in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §4, §5.34 and §7; UI_SPEC §6.1, §6.1b, §6.1c and §6.7; spec FR-205, FR-235, FR-259–FR-268 and SC-030; Help (Token use, A first look around). No MCP tool changes.
- [x] T279 [US2] `tools/docket-sync/sources/usage.mjs`: Codex and Claude Code logs, allowlisted fields only, known workspaces only, byte offsets, partial lines, rotation and per-pass limits.
- [x] T280 [US2] Migration, `domain/usage.ts` and the routes: the switch, the sync contract, attribution, overhead and not linked, rollups.
- [x] T281 [US2] `usage-prices.ts`: a dated table citing its source per model; "Cost not available" with no sourced price.
- [x] T282 [US2] The Settings switch with the owner's note and status; Overview's card; a ticket's and an epic's Token use; the brief's *What it cost*. Keyboard, text, both themes, 1024 px and 1440 × 900.
- [x] T283 [US2] Tests: both log formats from fixtures, duplicate and cumulative counting, partial lines and offsets, privacy, no file call when off, unknown workspaces, attribution, overhead and not linked, missing prices, rollups, empty and off states, e2e and axe in both themes.

## Phase 43: An optional GitHub connection (owner decision 49)

- [x] T284 [US2] Spec plus code in one PR: decision 49 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.35 and §7; MCP_SPEC §5.4; UI_SPEC §6.1, §6.3.6a and §6.7; spec FR-269–FR-277; Help; the worker skill.
- [x] T285 [US2] `tools/docket-sync`: the runner, the source contract, durable state, one instance, backoff and install steps. Not installed, started or scheduled.
- [x] T286 [US2] `sources/github.mjs`: read-only through `gh`, GraphQL with a request budget, rate-limit backoff, no merge-queue PRs, no token and no PR body kept.
- [x] T287 [US2] Migration, `domain/sync.ts`: the validated, size-capped, idempotent ingest route, status per source and the quiet event.
- [x] T288 [US2] The naming rule: `claim_lead`'s suggestion, a warning on a reported branch, exemptions, and never a block.
- [x] T289 [US2] Matching: exact primary links, related mentions, and the run active at the time.
- [x] T290 [US2] The ticket's GitHub panel, Overview's Merged source and Settings → Connections → GitHub: keyboard, focus, both themes, 1024 px and 1440 × 900.
- [x] T291 [US2] Tests with a fake `gh` only: matching, multi-mention PRs, exemptions, merge-queue PRs, idempotent ingest, down and recovery, rate limits, no secrets, no connection, every Settings state; e2e and axe in both themes.

## Phase 44: Installs stay in scope (owner decision 50)

- [x] T292 [US13] Spec plus code in one PR: decision 50 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.36 and §7; UI_SPEC §6.7b; spec FR-124 and FR-278–FR-284, SC-031; Help and the skills.
- [x] T293 [US13] Refuse new user-wide installs; legacy rows stay in the log, count for no project and raise no drift or Problems.
- [x] T294 [US13] `GET /api/install-overview`, the All projects card with a choice of project, and worktree wording from recorded runs only.
- [x] T295 [US13] The uninstall command in PowerShell and bash: hash-checked, marker-only, no links, no recursion, repeatable, and recorded. *Mark as removed* with Undo.
- [x] T296 [US13] Tests in temporary folders only: status, worktree wording, uninstall with unchanged, modified, missing, link and surrounding content, in each shell; e2e and axe in both themes at 1024 px and 1440 × 900.

## Phase 45: A bundled delivery skill (owner decision 52)

- [x] T297 [US13] Spec plus code in one PR: decision 52 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.17; spec FR-285–FR-289 and SC-032; Help; `skills/README.md`.
- [x] T298 [US13] `skills/docket-delivery/SKILL.md`: project-agnostic, subordinate to the project, the twelve delivery lessons, within the skill limits. No MCP tool.
- [x] T299 [US13] One short pointer each from `docket-worker` and `docket-coordinator`.
- [x] T300 [US13] Tests: listing, install for both clients, drift, uninstall in each shell, update available from an older install, skills lint, a guard against project-specific names, token budgets.

## Phase 46: Real worktree facts from the host helper (owner decision 48, B68)

- [x] T301 [US11] Spec plus code in one PR: BUILD_SPEC §5.32 and §5.35, UI_SPEC §6.6 and §6.7, spec FR-290–FR-294 and SC-033, Help, the helper's README.
- [x] T302 [US11] `tools/docket-sync/sources/worktrees.mjs` and `lib/git.mjs`: read-only host git, no shell, bounded, with no file names in any record.
- [x] T303 [US11] Store the latest facts per project as bookkeeping and merge them into the Worktree view while fresh. Stale, missing or partial facts are never Safe to remove.
- [x] T304 [US11] Settings → Connections → Worktree checks, and the fresh facts in B49's unpushed and uncommitted checks.
- [x] T305 [US11] Tests: real repositories with linked worktrees in every state, Windows-style paths, timeouts, idempotent ingest, stale and partial data, a `.git` hash proof, no file names; e2e and axe in both themes at 1024 px and 1440 × 900.

## Phase 47: Pause project (owner decision 53)

- [x] T306 [US2] Spec plus code in one PR: decision 53 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.37; MCP_SPEC; UI_SPEC §6.1d; spec FR-295–FR-301 and SC-034; Help; skills.
- [x] T307 [US18] Migration and `domain/project-pause.ts`: the pause is an owner decision record, read by `decisionHold`. Refused claims, resumes and new child runs; parked runs stay parked through writes; coordinator parks wait; digest and context lines; one resume event after a lift.
- [x] T308 [US2] Owner API and UI: Pause and Resume with Undo, the banner on Overview, Work and the item page, and the Paused marker in pickers.
- [x] T309 [US18] Tests: authority, refused claims, allowed writes, parked and open runs, alerts and aging, a blocker clearing during a pause, resume events, Undo, restart, two projects, budgets, and e2e with axe in both themes.

## Phase 48: Pick next epic (owner decision 54)

- [x] T310 [US4] Spec plus code in one PR: decision 54 in REQUIREMENTS_DRAFT and the BUILD_SPEC log; BUILD_SPEC §5.38; UI_SPEC §6.2.5; spec FR-302–FR-307 and SC-035; Help.
- [x] T311 [US4] `domain/epic-picks.ts` and `GET /api/projects/:key/pick-epic`: the six numbers, fit, order and the Best next reason, on `BlockIndex`, `readyStates` and `upstreamOf`.
- [x] T312 [US4] The Pick next epic page, the link from Work, and the outside-dependency indicator on epic cards and the epic page.
- [x] T313 [US4] Tests: self-contained, transitive and no-epic chains, cleared and canceled blockers, cycles, paused projects, being worked, order, Best next, empty states, the indicator; e2e and axe in both themes at 1024 px and 1440 x 900 on stress data.

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
| B10 | 6r US11 | T096–T101 | P1 complete. Run the crash drill in the `docket-coordinator` skill by hand |
| B11 | 7 US4 | T102–T109 | |
| B12 | 8 US5 | T110–T116 | |
| B13 | 9 US6 | T117–T121 | |
| B14 | 10 US7 | T122–T127 | Split in two if the diff gets large: server, then UI |
| B15 | 11 US10 | T128–T133 | |
| B16 | 12 US8 | T134–T137 | |
| B17 | 13 US9 | T138–T141 | |
| B18 | 14 Polish | T142–T149 | |
| B21 | 15 Contracts for help and agent setup | T150–T151 | The snapshot changes once, for `get_context` |
| B22 | 15 Help center (US12) | T152 | |
| B23 | 15 Agent files and workflow (US13) | T153–T154, T157 | |
| B24 | 15 Install and check (US13) | T155–T156, T158 | Needs B23 |
| B26 | 16 Contracts for proposals and drift | T159 | Builds on the spec branch; snapshot 38 → 40 |
| B27 | 16 Proposals, drift and skill updates (US14) | T160–T162 | Split into two PRs if large |
| B29 | 17 Contracts for onboarding | T163 | Snapshot 40 → 42 plus a prompt |
| B30 | 17 Onboarding (US15) | T164–T166 | Before the Gameflow pilot |
| B31 | 18 Local trust and connection files | T167–T169 | Before the Gameflow pilot |
| B33 | 19 Contracts for step details | T170 | Snapshot 42 → 43 |
| B34 | 19 Step details (US16) | T171–T173 | Before the Gameflow import |
| B36 | 20 Install and onboarding follow-ups (US17) | T174–T178 | Contract and implementation in one PR; snapshot 43 → 44 |
| B38 | 22 Contracts for shared changes | T182 | Snapshot 44 → 48 |
| B39 | 22 Shared changes and guardrails (US18) | T183–T185 | After B38 |
| B37 | 21 Approve with notes (US3) | T179–T181 | Contract and implementation in one PR; no MCP changes |
| B42 | 23 Problems that say what to do (US18) | T186–T189 | Contract and implementation in one PR; snapshot 48 → 49 |
| B43 | 24 Work filters and the Epics strip (US2) | T190–T192 | Owner feedback; UI API change only, no MCP changes |
| B44 | 25 Project decisions get their own page (US5) | T193–T195 | Owner feedback; no tool changes; one new event type |
| B46 | 26 Overlaps reach the owner only when they need the owner (US18) | T196–T199 | Owner decision 39; contract and implementation in one PR; no new tools, snapshot updated |
| B47 | 27 One status colour system; map arrows route around cards (US4) | T200–T202 | Owner feedback, Gameflow pilot |

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
| 15 Help and agent setup | B21 first; B22 any time after; B23 then B24 |
| 16 Proposals and drift | B26 then B27 |
| 17 Onboarding | B29 then B30 |
| 18 Local trust | B31 |
| 19 Step details | B33 then B34 (after B32) |
| 20 Install and onboarding follow-ups | B36 (after B35) |
| 21 Approve with notes | B37 (after B9) |
| 22 Shared changes and conflict guardrails | B38 then B39 |
| 23 Problems that say what to do | B42 (after B41) |
| 24 Work filters and the Epics strip | B43 (after B42) |
| 25 Project decisions get their own page | B44 (after B43) |
| 26 Overlaps reach the owner only when they need the owner | B46 (after B44) |
| 27 One status colour system; map arrows route around cards | B47 (after B46) |
| 28 Coordinators get what they need with far fewer tokens | B48 (after B47) |
| 29 Survive restarts, catch up backups, truthful Needs you | B49 (after B48) |
| 30 Status follows what agents are doing | B50 (after B49) |
| 31 The Overview page | B51 (after B50) |
| 32 Time-limited coordinator parking | B53 (after B52) |
| 33 Make a parked story's wait visible | B54 (after B53) |
| 34 Wake the right session when the owner answers | B55 (after B54) |
| 35 Overview fixes from the owner's feedback | B56 (after B55) |
| 36 Questions the owner can actually read | B57 (after B56) |
| 37 Flow trends and a daily brief | B59 (decision 48; alongside B58, B60 and B61) |
| 40 Split a ticket and withdraw a question | B61 (decision 48, in parallel with B58–B60) |
| 42 Real token use per ticket and epic | B63 (decision 48; alongside B60, B61 and B62) |
| 43 An optional GitHub connection | B62 (decision 49; alongside B63) |
| 44 Installs stay in scope | B64 (decision 50) |
| 45 A bundled delivery skill | B66 (decision 52) |
| 47 Pause project | B69 (decision 53) |
| 48 Pick next epic | B70 (decision 54) |

**Within a phase:** tests (failing) → services → replace stubs or fill handlers → fill screens → checkpoint.

## Implementation strategy

1. **Contracts first (B1–B6).** After B6, the whole interface (38 tools, every route, every screen) exists and is enforced by snapshot and route tests. Slices only add behaviour.
2. **MVP (B7).** Agents coordinate end to end. Validate with a real client.
3. **P1 complete (B8–B10):** the first owner-usable release, including crash recovery.
4. **P2 then P3 (B11–B17),** each behind green CI and the gate.
5. **Polish (B18), then the pilot checklist** (ROADMAP §1). From B8 on, track the remaining batches in Docket itself.
