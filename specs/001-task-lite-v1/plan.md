# Implementation Plan: Task Lite V1

**Branch**: `001-task-lite-v1` (spec branch `eps5000/speckit-v1`) | **Date**: 2026-11-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-task-lite-v1/spec.md`

## Summary

Build a single local service that agents coordinate through over MCP, with a supervision UI for the
owner:
- one TypeScript process in one container;
- one SQLite database and a document store on one volume;
- one port serving `/mcp` (agents), `/api` with server-sent events (UI) and the React app.

The domain layer enforces every rule (claims and leases, dependencies with per-project and per-link
rules, review gates, owner authority over decisions) inside the mutation's transaction, and appends
an event for every change. The MCP adapter adds a token-lean contract (views, field selection,
patches, compact text renderings, budgeted context bundles), and the UI adds the owner's views,
notifications and inline editing.

**The design is already decided.** This plan does not restate it. It points to the authoritative
documents and adds the Spec Kit artifacts the tasks are generated from:

| Topic | Authoritative source |
|---|---|
| Rules, data, API, tests, milestones, decisions | [docs/BUILD_SPEC.md](../../docs/BUILD_SPEC.md) |
| Agent contract | [docs/MCP_SPEC.md](../../docs/MCP_SPEC.md) |
| Screens | [docs/UI_SPEC.md](../../docs/UI_SPEC.md) |
| Visual reference | [design/prototype.html](../../design/prototype.html) |
| Seed data | [design/sample-data.json](../../design/sample-data.json) |
| Technical decisions with rationale | [research.md](research.md) |
| Entities and state machines | [data-model.md](data-model.md) |
| Interface indexes, plus the additions from clarifications | [contracts/](contracts/) |
| Run and validate | [quickstart.md](quickstart.md) |

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node.js 22 LTS. pnpm workspace with `server/`, `web/` and `shared/`.

**Primary Dependencies**:
- Hono with `@hono/node-server`;
- `@modelcontextprotocol/sdk` (Streamable HTTP server);
- better-sqlite3 with drizzle-orm and drizzle-kit;
- zod, plus zod-to-json-schema for MCP schemas;
- React 19, Vite, React Router, TanStack Query;
- markdown-it with DOMPurify.

**Storage**: SQLite in WAL mode with FTS5 at `/data/tasklite.db`; documents in `/data/docs/<KEY>/<doc>/v<n>/`; backups in `/data/backups`; call logs in `/data/logs`; secrets in `/data/secrets`. All on the named volume `tasklite-data`.

**Testing**:
- Vitest for unit tests (every domain rule) and integration tests;
- MCP contract tests using the official MCP client SDK, including description snapshots and token budgets;
- Playwright for end to end in Chromium, with `@axe-core/playwright`;
- a real-client smoke checklist (O07);
- CI on GitHub Actions (`ubuntu-latest`, `.github/workflows/ci.yml`).

**Target Platform**:
- a Linux container (`node:22-bookworm-slim`, non-root) on the owner's machine (Docker Desktop on Windows today);
- the UI in a current Chromium or Firefox browser on the same machine.

**Project Type**: Web service (MCP and JSON API) plus a single-page web app, deployed as one container.

**Performance Goals** (SC-013):
- owner views render in under 1 s;
- 95% of agent calls finish in under 500 ms, at 20 projects, 5,000 items, 100,000 events and up to 10 connected agents;
- token budgets per MCP_SPEC §3.2.

**Constraints**:
- loopback-only;
- no model APIs, and no launching agents (Principle I);
- every write is one SQLite transaction, with `BEGIN IMMEDIATE` and a 5 s busy timeout;
- WCAG 2.1 AA in both themes, down to 1024 px wide;
- secrets are never stored or logged.

**Scale/Scope**: one owner, up to 10 agents at once. About 9 owner screens, plus 2 not prototyped (burn-down/forecast and Jira import), 36 MCP tools, about 45 API routes, and about 25 tables.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How the plan complies | Status |
|---|---|---|
| I. Coordinator, not dispatcher | No component launches agents or calls model APIs. The sweeper only re-derives run state and pings MCP sessions. Notifications are produced in the browser (FR-068), not sent by the service to agents. | PASS |
| II. The server enforces the rules | One domain layer under both adapters (`server/domain`). Every rule in BUILD_SPEC §5 is implemented there, in the mutation's transaction. Events are appended in the same transaction. Idempotency and version checks happen centrally. Owner text edits reuse the same path (decision 22). | PASS |
| III. Provenance is never blurred | Provenance and authority are enums in `shared/`. Approval styling is reserved for owner review decisions. Run states are derived from evidence only. "Merged" is labelled as agent-reported. | PASS |
| IV. Agent-first, token-lean contract | Descriptions live in `shared/mcp-copy.ts` with a snapshot test against MCP_SPEC. Compact renderers live in `shared/compact.ts`. Budgets are enforced in CI. Patch semantics are the default. Errors are structured. | PASS |
| V. Owner attention is scarce | Only for-you items raise the badge, tab-title count and notifications. Undo or confirm on every owner mutation. axe runs in CI in both themes. | PASS |
| VI. Local, private and safe by default | `127.0.0.1` publish, Host and Origin allowlists, a separate owner session with CSRF, secret detection in the domain layer, a call log without contents, backups and restore, delete-together. | PASS |
| VII. Tested against the contract | Unit, contract, end-to-end and accessibility suites are the done-when of each phase. CI is green before the merge queue. | PASS |
| VIII. Scope discipline | Scope is fixed by spec.md and BUILD_SPEC §1. Two clarifications added small, owner-approved scope (notifications, text edits). No new dependency beyond the stack in owner decision 14. | PASS |

**Post-design re-check (after Phase 1):** PASS. The data model, the contracts and the quickstart
add nothing that conflicts with a principle. The only judgement call: the diagnostic call log (T21)
records metadata, never arguments, to satisfy Principle VI.

## Project Structure

### Documentation (this feature)

```text
specs/001-task-lite-v1/
├── spec.md              # requirements of record (user stories, FRs, SCs, clarifications)
├── plan.md              # this file
├── research.md          # Phase 0: decisions, rationale, alternatives
├── data-model.md        # Phase 1: entities, fields, state machines, validation
├── quickstart.md        # Phase 1: run, connect, seed, validate each user story
├── contracts/
│   ├── mcp-tools.md     # index of the 36 tools → MCP_SPEC sections, by user story
│   ├── ui-api.md        # API routes → BUILD_SPEC §7, plus the clarification routes
│   └── events.md        # event types, SSE payload, change cursor
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
shared/                  # zod schemas, enums, error codes, filters, mcp-copy.ts, compact.ts, secrets.ts
server/
├── src/
│   ├── domain/          # services + rules (items, links, claims/runs, checklist, review, decisions, context, archive, forecast)
│   ├── db/              # drizzle schema, migrations, FTS triggers, seed loader
│   ├── mcp/             # MCP server, session/identity, tool adapters
│   ├── api/             # Hono routes, owner session/CSRF, SSE stream, diagnostics
│   ├── jobs/            # sweeper (run state, leases, pings), nightly backup, log rotation
│   ├── import/          # Jira dry run + import
│   └── cli/             # tasklite owner-key | agent-token | seed | backup | restore | export
└── tests/
    ├── unit/            # one file per domain rule area
    ├── contract/        # MCP contract tests (MCP_SPEC §10)
    └── integration/     # API + lifecycle tests
web/
├── src/
│   ├── routes/          # needs-you, work, items, review, labels, agents, settings, unlock
│   ├── components/      # Chip, RunState, Provenance, Section, ViewTabs, TicketCard, ProgressMap, …
│   ├── lib/             # api client, SSE, notifications, persistence, undo
│   └── styles/tokens.css
└── e2e/                 # Playwright specs per user story + axe
docker/                  # Dockerfile, compose.yaml, .env.example, smoke/
.github/workflows/ci.yml
```

**Structure Decision**: a pnpm workspace with three packages (`shared`, `server`, `web`) built
into one image. The web build is served by the server, so there's one process and one port.
`shared` is what keeps the UI, MCP and tests byte-identical on enums, copy and renderers
(BUILD_SPEC §13).

## Complexity Tracking

No constitution violations to justify.
