# Task Lite Constitution

## Core Principles

### I. Coordinator, Not Dispatcher
Task Lite is the enforced source of truth that agents work through. It is not an agent runner.
- The service MUST NOT launch, schedule or message agents, and MUST NOT call model APIs (owner
  decisions 2 and 18, requirement O08). Orca, or the owner, starts agents.
- It MUST answer, authoritatively and at any moment: what work exists, what is eligible to start,
  who holds it, what it depends on, which decisions apply, and what the owner must verify.
- Features that would make the service start or steer agents need a constitution amendment.

Rationale: execution belongs to tools built for it. Coordination is valuable only if it is correct
and always available.

### II. The Server Enforces the Rules
Agents MUST NOT be trusted to remember workflow rules. The server enforces them on every call.
- Status transitions, blocking (including each link's `satisfied_when`), cycle rejection, lead
  claims and leases, the human-review gate on Done, owner-only actions, and the authority of owner
  decisions MUST be checked in the domain layer, inside the mutation's transaction.
- There is exactly one write path. MCP tools and UI API handlers MUST be thin adapters over the same
  domain services, so agents and the owner always see the same state (O04).
- Every mutation MUST be versioned, retry-safe (idempotency keys), and recorded as an append-only
  event with actor, time and old/new values (O03, A07).

Rationale: a rule that depends on an agent remembering it will eventually be broken by one.

### III. Provenance Is Never Blurred
Every statement shown to the owner or an agent MUST say who asserted it and how we know.
- Only an attributed owner decision records human approval. CI, merges, agent claims, observed child
  runs and relayed reports MUST be stored and displayed as distinct evidence, and MUST NOT look like
  approval (H06).
- Unknown is not done. A run with no recent signal is stale or interrupted, never finished. A deferred
  check is "not verified", never approved.
- Agent-reported facts that the service cannot observe (for example "PR merged" in V1) MUST be labelled
  as reported.

Rationale: the owner's trust in what they see is the product.

### IV. Agent-First, Token-Lean Contract
Agents are the primary users. The MCP contract is product surface, not plumbing.
- Tool descriptions and server instructions are product copy. They MUST match MCP_SPEC.md verbatim,
  enforced by a snapshot test.
- Reads MUST be bounded: pagination, `view`, `fields`, and budgeted context bundles. Writes MUST patch
  ("what you don't restate, you don't change").
- Every result MUST include a complete compact text rendering. Token budgets in the contract tests
  MUST hold, and a regression fails CI.
- Errors MUST be structured, with a code and a one-sentence next step.

Rationale: every token and every extra call an agent spends costs the owner time and money.

### V. Owner Attention Is Scarce
The UI exists so the owner can supervise without wading.
- Only things that need the owner may raise a red badge or appear in Needs you.
- One job per view. Prefer a count, a dot or a chip over explanatory text. No explanatory subtitles.
- Owner mutations MUST be undoable, or confirmed with focus on Cancel when they are destructive.
- The UI MUST meet WCAG 2.1 AA in light and dark themes, and state MUST never be shown by colour
  alone.

Rationale: a supervision UI that needs supervising has failed.

### VI. Local, Private and Safe by Default
- Published on `127.0.0.1` only, with Host and Origin allowlists (O02). Agents authenticate with a
  bearer token. Owner actions require a separate owner session that agents never hold.
- Secrets MUST NOT be stored in task content, events or logs, and writes containing secret-like text
  MUST be rejected.
- Data MUST survive container replacement. Deleting a project MUST remove its records and documents
  together. Backups MUST be restorable (O01, O03, O10).

Rationale: the tracker holds the owner's working context, and it runs where the owner's code runs.

### VII. Tested Against the Contract
- Every domain rule MUST have unit tests. Every MCP tool MUST have contract tests (happy path, each
  error code, idempotency, concurrency).
- The owner-facing scenarios MUST have end-to-end tests.
- Accessibility MUST be checked with axe on every screen.
- Tests for a rule or tool SHOULD be written before or with its implementation, and a milestone is
  not done until its tests pass in CI.

Rationale: agents will build and change this code. The tests are how we know they didn't break the
contract.

### VIII. Scope Discipline
- V1 scope is defined in BUILD_SPEC.md §1. Anything else goes to ROADMAP.md, with the trigger
  evidence that would justify it.
- New dependencies (libraries, services, formats) MUST be justified by a measured need. TERSL, for
  example, stays a reference until an experiment shows clear gains.
- Prefer one container, one process and one database until a measured limit says otherwise.

Rationale: the fastest way to never ship is to build the control plane before the tracker works.

## Technology and Operational Constraints

- **Stack** (owner decision 14): Node 22 LTS with TypeScript (strict), a pnpm workspace with
  `server/`, `web/` and `shared/`. Hono, and the official `@modelcontextprotocol/sdk` over
  Streamable HTTP. SQLite via better-sqlite3 and Drizzle (WAL, FTS5). React 19 with Vite, React
  Router and TanStack Query. zod schemas shared by MCP, the API and the UI.
- **Deployment:** one Docker container (`node:22-bookworm-slim`, non-root), one named volume at
  `/data`, one port (7420) serving `/mcp`, `/api` and the UI, published only on `127.0.0.1`.
- **Identity** (owner decision 16): one agent bearer token, with client identity from the MCP
  `clientInfo` plus an optional `agent_label`, and an owner key and browser session for owner
  actions.
- **CI** (T20): GitHub Actions on hosted `ubuntu-latest` runners, with a single `ci.yml`.
- **Authoritative design documents,** in order of precedence:
  1. `docs/BUILD_SPEC.md` (rules);
  2. `docs/MCP_SPEC.md` (agent contract);
  3. `docs/UI_SPEC.md` (screens);
  4. the Spec Kit artifacts in `specs/`.

  `design/prototype.html` is the visual reference. The requirements of record are
  `specs/001-task-lite-v1/spec.md`. `docs/REQUIREMENTS_DRAFT.md` keeps the history of owner
  decisions.

## Development Workflow and Quality Gates

- **One PR per milestone** (BUILD_SPEC §11), or per Spec Kit phase in
  `specs/001-task-lite-v1/tasks.md`. PRs merge through the Mergify merge queue, and only with CI
  green.
- A PR that changes a rule, a tool contract or a screen MUST update the governing document
  (BUILD_SPEC, MCP_SPEC or UI_SPEC) in the same PR. A PR that changes a decision MUST add a row to
  BUILD_SPEC §14.
- MCP description strings live in `shared/mcp-copy.ts`, and they change only together with
  MCP_SPEC.md.
- **Before a feature is called done:**
  - its acceptance scenarios in `spec.md` pass;
  - its tasks are checked off in `tasks.md`;
  - the cross-artifact analysis (`/speckit-analyze`) reports no critical issues.
- **Before the pilot:** the checklist in ROADMAP.md §1 is complete.

## Governance

This constitution supersedes other practices in this repository. Where a design document conflicts
with a principle, the principle wins until the document is fixed or the constitution is amended.

- **Amendments:** a PR that edits this file. It states the change, the reason and the version bump,
  and updates any affected design documents and templates in the same PR. Changes to Principle I or
  VI need explicit owner approval in the PR.
- **Versioning:** semantic versioning.
  - MAJOR: removing or redefining a principle.
  - MINOR: adding a principle or section, or materially expanding guidance.
  - PATCH: wording and clarifications.
- **Compliance:** every PR review checks the principles it touches. `/speckit-analyze` treats
  constitution conflicts as CRITICAL. Complexity that bends a principle MUST be justified in the
  plan's Complexity Tracking table.

**Version**: 1.0.0 | **Ratified**: 2026-11-14 | **Last Amended**: 2026-11-14
