# Research: Docket (formerly Task Lite) V1

Phase 0 output. The spec has no remaining `NEEDS CLARIFICATION`; this file records each technical
decision in Spec Kit's Decision / Rationale / Alternatives form. The full decisions log, with
section links, is [BUILD_SPEC §14](../../docs/BUILD_SPEC.md); the owner decision history is in
[REQUIREMENTS_DRAFT.md](../../docs/REQUIREMENTS_DRAFT.md).

## R1. Stack (owner decision 14)
- **Decision**: TypeScript end to end: Node 22, Hono, the official MCP TypeScript SDK, SQLite
  (better-sqlite3 + Drizzle), React 19 + Vite.
- **Rationale**:
  - one language across the MCP server, the API, the UI and the shared schemas;
  - the reference MCP SDK;
  - SQLite gives serializable writes for a single local service with no extra container.
- **Alternatives**:
  - Python (FastAPI + the MCP Python SDK): two languages;
  - PostgreSQL: an extra container, and no need at this scale;
  - TERSL/DB: closed and undocumented, with single-user open-source tooling (ROADMAP §3).

## R2. Transport and identity (decision 16, T1, T2)
- **Decision**:
  - one port with MCP Streamable HTTP (stateful sessions) at `/mcp`;
  - one agent bearer token;
  - client identity from `clientInfo`, plus `agent_label`;
  - a separate owner key that unlocks a browser session (HttpOnly cookie + CSRF).
- **Rationale**:
  - simplest setup for many clients;
  - stops agents recording owner approval through the API (H06);
  - Host/Origin allowlists guard against DNS rebinding (the MCP spec requires Origin checks).
- **Alternatives**:
  - per-client tokens: more setup, and the attribution is no more trustworthy locally;
  - no owner auth: any local process could approve.

## R3. Run liveness (T3)
- **Decision**: displayed run state is derived from signals:
  - *session* (the run's own MCP session: requests, or answered server pings every 60 s);
  - *report* (another session);
  - *relayed*.

  Windows: live 2 min, stale after 30 min, lease 60 min. Restart interrupts every open run.
- **Rationale**: never show more certainty than the data supports (Principle III).
- **Alternatives**: timer-only heartbeats from agents. LLM agents can't reliably send them.
- **Verify in M2/M8**: whether Codex and Claude answer server pings (BUILD_SPEC §12, V1).

## R4. Concurrency and retries (T5, T6)
- **Decision**:
  - optimistic versions on mutable rows;
  - idempotency keys kept for 24 h;
  - `BEGIN IMMEDIATE` with a 5 s busy timeout, then `unavailable`;
  - owner undo is a server-side inverse event within 60 s.
- **Rationale**: correctness of claims and edits under concurrent agents (A07, A15, SC-003).
- **Alternatives**: last-write-wins, which loses updates; client-side undo, which can't see agents' later changes.

## R5. Token-lean responses (decision 19, T18, T19)
- **Decision**:
  - `structuredContent` JSON, plus a complete compact text rendering;
  - `view` and `fields` on reads;
  - patch by default on plan, checks and items;
  - a `get_context` bundle with 1k, 3k and 8k budgets;
  - budgets enforced in contract tests.
- **Rationale**: tokens and calls are the agents' cost (SC-001, SC-002). TERSL's "silence preserves"
  and identity-first layout are adopted as ideas only (decision 20).
- **Alternatives**:
  - JSON text blocks, which are verbose;
  - TERSL encoding, which is pre-1.0 and not justified by our own measurements;
  - many small reads, which multiply calls.
- **Verify**: which content each client forwards to the model (V6).

## R6. Dependencies (T7, T16)
- **Decision**:
  - a blocker is cleared when its rule is met: `done`, `merged` (agent-reported), or `verified` (all review items approved);
  - the rule is a project default with a per-link override;
  - canceled blockers stay uncleared;
  - cycles are rejected on create and found with strongly connected components on read.
- **Rationale**: automatic, correct eligibility without trusting "done" claims when stricter evidence is wanted (owner decision 19).
- **Alternatives**: observed merges via GitHub. That needs an integration, and is deferred (ROADMAP §2).

## R7. Decision records (decision 19, T17)
- **Decision**:
  - scoped records (project, epic, label or item) with owner or agent authority;
  - agents can't change owner records;
  - nothing goes to Needs you.
- **Rationale**: shared conventions without repeat discovery; the owner stays authoritative.
- **Alternatives**: free-form notes, which aren't scoped or queryable; a full knowledge base, which is out of scope.

## R8. Live updates and notifications (T10, decision 21)
- **Decision**:
  - server-sent events at `/api/stream`, with `Last-Event-ID` resume and query invalidation in the UI;
  - desktop notifications built in the browser with the Notification API, from for-you events on that stream;
  - repeats suppressed per browser via `localStorage` and a single-tab lock (`navigator.locks` or BroadcastChannel);
  - a `(N) Docket` tab title.
- **Rationale**: no server push infrastructure, nothing leaves the machine, and works with the tab in the background.
- **Alternatives**:
  - polling: laggy and wasteful;
  - WebSockets: more machinery for a one-way feed;
  - OS-level notifier or email: off-machine, or extra dependencies.

## R9. Owner inline text editing (decision 22)
- **Decision**: `PATCH /api/items/:id` accepts title, description, outcome and acceptance criteria, with `expected_version`, through the same domain path as agents (limits, secret checks, events, undo).
- **Rationale**: Planning is the owner's stage, and editing text there shouldn't require an agent.
- **Alternatives**:
  - full H11 (dates, effort, links): more UI, deferred;
  - notes only: slow.

## R10. Documents (T9)
- **Decision**:
  - immutable versions;
  - 25 MB through MCP, 500 MB through bearer HTTP upload;
  - a fixed set of preview formats, with Markdown sanitized in the browser.
- **Rationale**: H10, plus safe rendering.
- **Alternatives**: rendering on the server, which needs more dependencies and is no safer.

## R11. Forecast (T11)
- **Decision**:
  - weekly completed effort over the last 4 weeks;
  - shown only with at least 8 estimated items done in at least 2 different weeks;
  - 10,000-trial Monte Carlo, reporting P50 and P85;
  - unestimated items counted, not zero.
- **Rationale**: honest uncertainty (H14), and it never overwrites planned dates.
- **Alternatives**: a straight-line average, which hides uncertainty.

## R12. Jira import (decision 17, T12)
- **Decision**:
  - Jira Cloud REST v3 with a token held in memory only;
  - a dry run builds everything in memory and reports it;
  - the import commits in one transaction;
  - attachments are fetched after the commit;
  - field IDs are auto-detected by name.
- **Rationale**: O05, with no credential persistence.
- **Alternatives**: CSV export, which is lossy for links and comments and needs manual steps.

## R13. Backups, logs, CI (T13, T20, T21)
- **Decision**:
  - nightly `VACUUM INTO` plus the docs tarball, kept 14 days, restored by CLI;
  - a JSONL call log without arguments, kept 7 days;
  - GitHub Actions hosted runners.
- **Rationale**: O03, FR-108, and free CI on the public repo.
- **Alternatives**:
  - file-copy backups, which risk inconsistency under WAL;
  - verbose logs, which leak secrets and documents;
  - Namespace runners, which aren't needed.

## Open verifications (not blocking)

These are carried from BUILD_SPEC §12; each has a working default:
- V1: whether clients answer server pings.
- V2: whether Orca Claude workers inherit the MCP config.
- V3: Claude's user-scope `${}` expansion.
- V4: Jira field IDs.
- V5: SQLite performance on a Docker Desktop volume.
- V6: which result content each client forwards to the model.
