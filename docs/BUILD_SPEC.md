# Task Lite: V1 build spec

Status: ready to build, 2026-11-07. This is the implementation contract for MVP V1. It is written for an integration agent working without the design conversation.

**Read in this order:**
1. This file: architecture, data model, rules, MCP tools, UI API, milestones and decisions.
2. [UI_SPEC.md](UI_SPEC.md): screens, components, tokens, states and accessibility.
3. [design/prototype.html](../design/prototype.html): the visual and behavioural reference. Open `?selftest` to render every view.
4. [design/sample-data.json](../design/sample-data.json): the seed data, exported from the prototype.
5. Background only, not instructions: [REQUIREMENTS_DRAFT.md](REQUIREMENTS_DRAFT.md) (requirement IDs such as A05 and H04 cited below), [UI_DESIGN.md](UI_DESIGN.md) (design rationale and revision history) and [JIRA_RESEARCH.md](JIRA_RESEARCH.md).

**Where the docs disagree:** this file and UI_SPEC.md win over the requirements draft and UI_DESIGN.md. Where the prototype and UI_SPEC.md disagree, UI_SPEC.md wins. Every place this spec deliberately departs from the draft is listed in [Decisions](#14-decisions-log).

---

## 1. What V1 is

Task Lite is a local Docker service. It runs one container on the owner's machine and serves three things on one port:

- an **MCP endpoint** (`/mcp`). Installed agent clients (Codex, Claude Code, and both launched as Orca workers) use it to plan, claim, update and hand off work;
- a **JSON API** (`/api`) for the web UI;
- the **web UI** (`/`). It exists so the owner can see what agents did, what they're doing, and what needs the owner.

The service never calls a model API and never launches an agent (O08). It is a task and data server.

### In scope for V1
All P0 requirements, plus four P1 items the owner pulled in: the Timeline layout, Label pages, burn-down and forecast (H14, A18), and the Jira import dry run and import (O05). The UI covers every screen in the prototype plus two screens that weren't prototyped: burn-down/forecast and Jira import. Those two are specified in UI_SPEC.md §9.

### Out of scope for V1
- Machine-readable full export (O06; a `tasklite export` CLI is a stretch goal, see M7).
- Bulk mutation tools for agents (A12).
- Git/CI integrations (A14).
- Sprints and dashboards (H12).
- A restore UI (restore is a CLI).
- Editing dates, blockers and acceptance from the UI (H11; agents do it, or the owner leaves a note).
- A UI to cancel an item (agents can cancel).
- Access from other devices.

---

## 2. Architecture

```
┌─────────────────────────── docker container: tasklite ───────────────────────────┐
│  Node 22 process (TypeScript)                                                     │
│   ├─ Hono HTTP server on 0.0.0.0:7420 (published as 127.0.0.1:7420 only)          │
│   │   ├─ /mcp     MCP Streamable HTTP (bearer token)        ─┐                    │
│   │   ├─ /api/*   UI JSON API + /api/stream SSE (owner session)├─ domain services  │
│   │   ├─ /healthz /readyz                                    ─┘   (one write path)│
│   │   └─ /*       static React build (SPA fallback to index.html)                 │
│   ├─ scheduler: run-state sweeper (every 30 s), nightly backup (03:00 local)      │
│   └─ SQLite (better-sqlite3, WAL) + document store on /data                       │
└──────────────────────────────────── volume: tasklite-data → /data ───────────────┘
```

**One write path.** MCP tools and API handlers are thin adapters over the same domain services. Every mutation runs in one SQLite transaction: it validates, applies the change, bumps `version` and appends events. No adapter writes tables directly. This is how O04 holds: there is one task store, and agents and the UI see the same state.

### Stack
Owner decision 14 (see §14).

| Concern | Choice |
|---|---|
| Runtime | Node 22 LTS, TypeScript (strict), pnpm workspace |
| HTTP | Hono on `@hono/node-server` |
| MCP | Official `@modelcontextprotocol/sdk`, Streamable HTTP server transport, stateful sessions (`Mcp-Session-Id`) |
| DB | SQLite via `better-sqlite3`, `drizzle-orm` + `drizzle-kit` migrations, WAL mode, `foreign_keys=ON`, FTS5 |
| Validation | `zod` schemas in `shared/`, used by MCP tool schemas, the API and the web client |
| Web | React 19 + Vite, React Router, TanStack Query. Plain CSS using the prototype's tokens (no CSS framework) |
| Markdown | `markdown-it` + `DOMPurify` (render in the browser, sanitized) |
| Tests | Vitest (unit, integration), Playwright (end to end), `@axe-core/playwright` |
| Container | Multi-stage build, `node:22-bookworm-slim`, non-root user `tasklite` (uid 10001) |

### Repository layout to create

```
server/      domain/ (services + rules), db/ (schema, migrations), mcp/ (tools), api/ (routes), jobs/, cli/
web/         src/ (routes, components, styles/tokens.css), e2e/ (Playwright)
shared/      zod schemas, types, enums, error codes
docker/      Dockerfile, compose.yaml, .env.example
design/      prototype.html, sample-data.json   (existing, reference only)
docs/        (existing)
```

### Configuration
Environment variables, with defaults:

| Var | Default | Meaning |
|---|---|---|
| `TASKLITE_TOKEN` | (generated) | Agent bearer token for `/mcp`. If unset, generated on first boot into `/data/secrets/agent-token` (mode 0600) and shown in Settings. Never logged. |
| `TASKLITE_PORT` | `7420` | Listen port inside the container. |
| `TASKLITE_ALLOWED_HOSTS` | `127.0.0.1:7420,localhost:7420` | Host header allowlist (DNS-rebinding guard). |
| `TASKLITE_LIVE_WINDOW` | `2m` | Run counts as *live* if its session showed signs of life within this window. |
| `TASKLITE_STALE_AFTER` | `30m` | Open run with no signal for this long is *stale*. |
| `TASKLITE_LEASE` | `60m` | Lead claim lease, renewed by any signal from the run. |
| `TASKLITE_BACKUP_AT` | `03:00` | Local time for the nightly backup. |
| `TASKLITE_BACKUP_KEEP` | `14` | Days of backups kept. |
| `TASKLITE_SEED` | (unset) | `sample` loads the sample data into an empty database. |
| `TZ` | host TZ | Display time zone. Storage is always UTC. |

`docker/compose.yaml` publishes `127.0.0.1:7420:7420` only (O02), mounts the named volume `tasklite-data:/data`, sets `restart: unless-stopped`, and has a healthcheck on `/healthz`.

### Volume layout

```
/data/tasklite.db (+ -wal, -shm)
/data/docs/<PROJECT_KEY>/<document_id>/v<n>/<filename>
/data/secrets/agent-token  /data/secrets/owner-key
/data/backups/tasklite-YYYYMMDD-HHMM.tar.gz
```

---

## 3. Security and identity

- **Network.** Only `127.0.0.1:7420` is published. Every request's `Host` must be in `TASKLITE_ALLOWED_HOSTS`, otherwise 421. Requests with an `Origin` header must have an allowed origin (the MCP spec requires this), otherwise 403. Other devices and containers are out of scope. A container-network path is documented as off by default (O02).
- **Agents.** `/mcp` requires `Authorization: Bearer <TASKLITE_TOKEN>`. One token serves all clients (owner decision 16).
  - **Who is calling:** the client name comes from the MCP `initialize` handshake (`clientInfo.name`), normalised: contains `codex` → `codex`; contains `claude` → `claude`; anything else is used as is. Agents add an optional `agent_label` (for example `orca-w3`) on `claim_lead` and `start_run`.
  - **Display:** the actor shows as `claude · orca-w3`.
  - **Storage:** events store `actor_kind=agent`, `client`, `label`, `session_id` and `run_id`.
- **Owner.** The browser gets an **owner session**, and agents never get its credential. Without this, any local agent could `curl` the API and record a human approval, which breaks H06. How it works:
  - On first boot the server writes `/data/secrets/owner-key`: 32 random bytes, base32-encoded.
  - The first visit in a browser shows a one-field "Unlock Task Lite" screen. The owner pastes the key, printed by `docker compose exec tasklite tasklite owner-key`.
  - The server then sets the `tl_owner` cookie: HttpOnly, SameSite=Strict, Path=/, 30-day sliding expiry. It's a signed session ID, and sessions are stored in the database.
  - `/api/*` requires that cookie. Mutating API calls also need the header `X-Tasklite-CSRF`, which must match the `tl_csrf` cookie (double submit).
  - Settings → Connections has *Lock this browser* (ends the session) and *Rotate owner key* (ends all sessions).
- **Secrets.** Tokens, keys and Jira API tokens are never written to task content, events or logs, and logs redact `Authorization` headers. The Jira API token lives only in memory for the import session (§9).
- **What agents cannot do through MCP:** record review decisions, answer their own questions as the owner, write owner notes, archive or unarchive, delete projects, or release another agent's claim. Those are owner actions, available only through `/api`.

---

## 4. Data model

SQLite tables. Every row has `id`, `created_at` and `updated_at`; all timestamps are UTC ISO-8601. Mutable entities also carry an integer `version` (starting at 1, incremented on every change) for optimistic concurrency (A07).

| Table | Key columns | Notes |
|---|---|---|
| `projects` | `key` (2–5 uppercase letters, unique), `name`, `short_name`, `color`, `next_seq`, `deleted_at` | Item IDs are `<KEY>-<n>`. `next_seq` increments inside the creating transaction. |
| `items` | `id` (`RCP-14`), `project_key`, `type` (Epic\|Story\|Task\|Bug), `title`, `description_md`, `outcome_md`, `status`, `priority` (1–3), `epic_id` (nullable; must be an Epic in the same project), `planned_start`, `planned_end`, `dates_set_by`, `dates_set_at`, `effort` (number, nullable), `effort_unit` ('pts'), `closed_by` (owner\|agent\|imported), `closed_at`, `archived_at`, `jira_key`, `imported` (bool), `from_review` (JSON: `{item_id, round, hr_item_id}`), `version` | `status`: inbox, planning, ready, progress, review, done, canceled. |
| `acceptance_criteria` | `item_id`, `position`, `text` | Ordered list. |
| `labels` | `project_key`, `name`, `brief_md`, `brief_by`, `brief_at` | Unique per project. |
| `item_labels` | `item_id`, `label_id` | |
| `links` | `from_id`, `to_id`, `type` (blocks\|relates), `created_by` | For `blocks`, `from` blocks `to`. Creating a link that closes a cycle is rejected (A04). |
| `plan_versions` | `item_id`, `version_no`, `reason`, `created_by` | The Work checklist history (A16). Each `set_plan` writes a version. |
| `work_steps` | `item_id`, `plan_version_no`, `position`, `text`, `state` (todo\|current\|done\|blocked\|skipped), `was_text`, `change_reason`, `from_review` (JSON), `added_by`, `state_by`, `state_at` | The current plan is the latest `plan_version_no`. |
| `subagent_logs` | `item_id`, `work_step_id`, `name`, `outcome`, `evidence`, `provenance` (observed\|relayed), `child_run_id`, `reported_by_run_id` | A17. |
| `agent_checks` | `item_id`, `position`, `text`, `state` (todo\|pass\|fail\|skipped), `evidence`, `provenance` (agent\|observed\|relayed\|ci), `added_by` | The checklist's Agent review section. |
| `hr_items` | `item_id`, `position`, `text`, `state` (declared\|ready\|approved\|deferred), `added_by` (owner\|agent actor), `last_decision` (JSON), `follow_up_item_id`, `version` | Human review items. `ready` means it's in the current packet. |
| `packets` | `item_id`, `round`, `content_hash` (displayed as `pkt-xxxx`), `built_from_commit`, `estimate`, `how` (JSON), `checked` (JSON), `gaps` (JSON), `created_by`, `state` (open\|decided\|withdrawn) | One row per round. |
| `packet_items` | `packet_id`, `hr_item_id`, `text_snapshot` | Freezes the item text as it was in this round. |
| `packet_attachments` | `packet_id`, `document_version_id`, `caption` | |
| `decisions` | `packet_id`, `hr_item_id`, `kind` (approve\|changes\|defer), `note`, `into` (checklist\|bug), `follow` (ticket\|none), `result_ref`, `decided_at` | Always owner. |
| `runs` | `item_id`, `parent_run_id`, `client`, `label`, `session_id`, `is_lead`, `state` (open\|needs_input\|finished\|failed\|interrupted), `last_signal_at`, `last_signal_kind` (session\|report\|relayed), `lease_expires_at`, `summary`, `error`, `current_step_id` | The displayed run state is derived (§5.4). |
| `questions` | `item_id`, `run_id`, `text`, `asked_by`, `answer`, `answered_at`, `read_by_agent_at` | |
| `owner_notes` | `item_id`, `text`, `read_by_agent_at` | |
| `commits` | `item_id`, `sha`, `branch`, `message`, `pr_url`, `reported_by`, `reported_at` | Drives packet staleness. |
| `artifacts` | `item_id`, `kind` (url\|pr\|ci\|deploy\|test), `label`, `url`, `state`, `provenance` | A08 evidence links. |
| `documents` | `project_key`, `item_id` (nullable), `name`, `kind` (planning\|packet_attachment\|import_report\|other) | Unique `(item_id, name)`. |
| `document_versions` | `document_id`, `version_no`, `mime`, `size`, `sha256`, `path`, `created_by` | Immutable. |
| `events` | `seq` (autoincrement, the change cursor), `at`, `actor_kind` (owner\|agent\|system), `client`, `label`, `run_id`, `project_key`, `item_id`, `type`, `summary`, `data` (JSON), `inverse` (JSON, nullable), `mutation_id`, `idempotency_key` | Append-only (O03). `summary` is the one-line text shown in Activity. |
| `idempotency` | `key`, `client`, `request_hash`, `response`, `expires_at` | Retained 24 h. |
| `owner_sessions` | `id`, `created_at`, `last_seen_at`, `user_agent` | |
| `settings` | `key`, `value` | |
| `search_fts` | FTS5 over item `id`, `title`, `description_md`, `outcome_md`, labels, `jira_key` | Kept in sync by triggers. |

**Derived values, never stored:**
- **blocked:** at least one unresolved `blocks` predecessor.
- **for you:** the item has a packet ready or an open question.
- **date risk:** see §5.9.
- **cycle membership:** see §5.2.
- **displayed run state:** see §5.4.

---

## 5. Domain rules

The server enforces these. Each rule cites its source.

### 5.1 Status transitions
Workflow (owner decision 8): `inbox → planning → ready → progress → review → done`, plus `canceled`.

| From → To | Who | Guard |
|---|---|---|
| inbox → planning | owner, agent | — |
| planning → ready | owner, agent | Agents may move to Ready when the project's workflow says so. The tracker doesn't judge readiness (decision 11). |
| ready → planning | owner, agent | — |
| ready → progress | agent via `claim_lead`, or `set_status` | Not blocked. |
| progress → ready | owner (*Return to Ready*, *Release lead claim*), agent, sweeper on lease expiry | Ends the lead claim. |
| progress → review | agent via `submit_packet` | At least one human review item exists. |
| review → progress | owner decision with any "changes"; owner *Ask for a fresh packet*; agent | — |
| progress or review → done | agent via `set_status`, or the owner's decision outcome | **No human review item may be `declared` or `ready`** (decision 13, the only gate the tracker enforces). Agent checks are recorded, not enforced. |
| any open → canceled | agent (reason required) | — |
| done → progress | agent (reopen, reason required) | — |

- Epics follow the same statuses. An epic can only become done when every child is done or canceled.
- `closed_by` is `owner` when the owner's packet decision closes the item, `agent` when `set_status` does, and `imported` for Jira imports.
- An invalid transition returns `validation` with the allowed transitions (A10).

### 5.2 Links, blocked, ready, cycles
- A `blocks` predecessor is **unresolved** unless its status is done. A canceled blocker stays unresolved, and Problems shows "Blocked by canceled X" with *Remove link*. The tracker never silently unblocks.
- **Blocked:** open and has an unresolved predecessor. Blocking crosses projects. Parent epics and `relates` links never block.
- **Ready to start** (A05): status `ready`, not blocked, and no active lead claim.
- **Cycles:**
  - `link_items` runs a DFS and rejects a link that would create a cycle. The error includes the path, for example `DOC-7 → DOC-8 → DOC-7`.
  - Imported data can still contain cycles. Strongly connected components are computed on read; each one larger than one node is a Problem whose *Fix* opens the Dependencies view.

### 5.3 Lead claims
A15.
- `claim_lead` is atomic, a conditional update on "no active lead run".
- If someone else holds the claim, it returns `conflict` with the current claimant, lease expiry and last signal, and records the rejected claim as an event. The Activity view shows those rejections.
- A claim creates an open lead run with `lease_expires_at = now + LEASE`. Any signal (§5.4) extends the lease.
- **When the lease expires,** the sweeper ends the run as `interrupted` ("lease expired"), releases the claim, and moves the item from `progress` back to `ready`. The checklist, logs and partial work stay on the ticket, and an event records why.
- **Owner *Release lead claim*:** same effect, earlier. It needs a confirmation dialog whose focus starts on Cancel.
- **If the original agent comes back** after either, its next call naming the old run returns `conflict` with the current state.
- **On service start:** every open run becomes `interrupted` ("service restarted"). Runs are never shown as finished unless the agent finished them.

### 5.4 Run signals and displayed state
A06, H05. **The rule: never show more certainty than the data supports.** A signal is one of:
- **session:** an MCP request from the same MCP session that started the run, or a successful server→client MCP `ping` on that session. The sweeper pings the open sessions of open runs every 60 s.
- **report:** a tool call that names the run but arrives from a different session.
- **relayed:** a parent run reporting on a child's behalf.

| Displayed | Condition |
|---|---|
| live | open, and the last *session* signal is within `LIVE_WINDOW` |
| reported | open, no session signal within `LIVE_WINDOW`, and the last signal of any kind is within `STALE_AFTER` |
| stale | open, and no signal for `STALE_AFTER` |
| needs input | `state = needs_input` (an open question) |
| failed / finished / interrupted | terminal `state` |

Display labels and their one-line meanings are in UI_SPEC.md §5 (run state). Subagent log entries never imply a heartbeat (JIRA_RESEARCH, last paragraph).

### 5.5 Checklist
H13, A16, A17.
- **Work steps** are the agent's plan. `set_plan` replaces the whole list as a new plan version with a reason. `update_step` changes one step's state. Revisions keep `was_text` and `change_reason`, which the UI shows as strikethrough and "Changed: …". The owner can add a step (`added_by=owner`) and remove their own undone steps.
- **Agent checks** have state and evidence. The owner can add one, and remove their own while it's still todo.
- **Human review items:**
  - Agents and the owner can add, edit and remove them while they're `declared`.
  - Items in the current open packet (`ready`) are locked.
  - Items added while a packet is open stay `declared` and go into the next round.

### 5.6 Packets and decisions
Decision 13, H04.
- **`submit_packet`:**
  - creates a round with all `declared` items (or a given subset);
  - sets them to `ready`;
  - stores `built_from_commit`, `how`, `checked` (each with provenance), `gaps` and attachments;
  - moves the item to `review`;
  - computes `content_hash` from the canonical JSON.
- **Owner decision** (`POST /api/review/:id/decisions`): one atomic call, with a verdict for every `ready` item, otherwise `validation`.
  - **approve:** item → `approved`, `last_decision={kind:'approve', round, at}`.
  - **changes:** `note` required. `into=checklist` adds a work step whose `from_review` is set. `into=bug` creates a Bug in **Ready** (the owner has already decided it needs fixing) with the parent's project, epic and priority. Its title is the note, truncated to 70 characters with an ellipsis; `from_review` points back, and a `relates` link joins the two. The human review item goes back to `declared` with `last_decision` holding the note.
  - **defer:** `note` optional. The item becomes `deferred`. With `follow=ticket`, the server creates a Task in Inbox (the parent's project, epic and priority) titled `Verify: <item text, truncated to 60 characters>`. The Task carries a copy of the item as `declared`, `from_review` points back, a `relates` link joins the two, and the parent stores `follow_up_item_id`.
  - **Outcome:**
    - any `changes` → status `progress`, packet `decided`;
    - otherwise → status `done`, `closed_by=owner`.
  - **Approvals carry forward:** approved items stay approved in later rounds. If a commit is reported after an approval, the UI shows "code changed since", and nothing re-opens.
- **Stale packet:** an open packet is stale when a commit is reported for the item after the packet was created with a SHA different from `built_from_commit`. For an epic-level packet, a commit on any child counts.
  - Needs you and the packet show "out of date".
  - Owner *Ask for a fresh packet*: the packet becomes `withdrawn`, its `ready` items go back to `declared`, the item returns to `progress`, and the server posts an owner note: "Please submit a fresh packet; code changed after <sha>".
- **Epic-level review:** human review declared on an epic. In the UI, a child with no review items of its own says "reviewed with its epic".
- **Deferred, not verified:** a deferred item whose follow-up isn't done, or that has no follow-up. The list is visible to the owner (Needs you, Work filter) and to agents (`deferred_reviews`). A deferred item clears when the owner or an agent re-declares it and it later gets approved, or when its follow-up ticket reaches done with its own review approved.

### 5.7 Questions and owner notes
- `ask_owner` creates an open question and sets the run to `needs_input`.
- The owner answers in Needs you or on the ticket.
- The next `get_item` (or `get_changes` event) delivers the answer and sets `read_by_agent_at`. Until then the UI says "Waiting for <agent> to read it". Reading it puts the run back to `open`.
- Owner notes are delivered the same way and listed under `unread_owner_notes` in `get_item`.

### 5.8 Archive
Owner only. `archived_at` hides a done item from the owner's default views (board, list, Timeline, Epics row, epic ticket list), and the item can be unarchived. Agent queries include archived items by default. Archiving an item that isn't done is rejected.

### 5.9 Dates, effort, forecast
H08, H14, A18.
- **Dates:** `planned_start` and `planned_end` are set by an owner or an agent, recording `dates_set_by` and `dates_set_at`. Actual dates come from run and status history: first `progress` to `done`.
- **Date risk:** an item's `planned_start` is before an unresolved blocker's `planned_end`.
- **Burn-down** for a scope (project, epic, or label):
  - one daily series of remaining effort: the sum of `effort` over open items in scope at the end of each local day, replayed from events;
  - scope additions are marked;
  - items without effort are counted and reported as "N not estimated", not as zero.
- **Forecast:**
  - Sample = effort completed per week over the last 4 full weeks. It's shown only when at least 8 estimated items were completed in that window and at least 2 weeks had any completion; otherwise "No forecast yet: needs 8 completed items with effort (have N)".
  - Method: Monte Carlo with 10,000 trials, drawing weekly throughput from the sample with replacement until remaining effort reaches 0. Report the P50 and P85 finish dates, plus the stated assumptions (window, n, rate) and "excludes N unestimated items".
  - Forecasts never overwrite planned dates.

### 5.10 Documents
H10.
- Each upload with the same `(item, name)` becomes a new immutable version.
- **Limits:** 25 MB through MCP (base64 inside JSON-RPC). Up to 500 MB through `POST /agent-upload` (bearer, multipart), which returns a `document_version_id` to reference from tools.
- Bytes are streamed to disk, `sha256` is recorded, and nothing is ever overwritten.
- **Preview formats** (rendered by the UI):
  - Markdown: rendered and sanitized;
  - text, log, json, yaml, csv: monospaced, JSON pretty-printed;
  - png, jpg, gif, webp, and svg (served as `<img>`, never inline);
  - mp4 and webm: `<video controls>`;
  - pdf: browser viewer in a sandboxed iframe;
  - anything else: download only.
- Responses set `Content-Disposition` and `X-Content-Type-Options: nosniff`.

### 5.11 Events, undo, change feed
- Every mutation appends events, including the old and new values that matter, in the same transaction (O03).
- Owner API mutations return a `mutation_id`. `POST /api/mutations/:id/undo` is accepted within 60 s if no later event touched the same objects; otherwise it returns `conflict`. Undo applies the stored `inverse` and records an `undo` event.
- The UI shows Undo in a 6 s toast.
- Agent mutations aren't undoable from the UI.
- `get_changes(cursor)` and `/api/stream` both read from `events.seq`.

### 5.12 Delete project
O10. Owner only; the UI asks the owner to type the project key.
- In one transaction: delete the project's rows, then insert a tombstone.
- After commit: remove `/data/docs/<KEY>`. A failure retries at startup from the tombstone.
- Backups are untouched and age out on their own retention schedule (Settings says so).

### 5.13 Backup and restore
O03.
- Nightly at `BACKUP_AT`: `VACUUM INTO` a temporary database, then tar.gz it together with `/data/docs` into `/data/backups`.
- Keep `BACKUP_KEEP` days.
- CLI:
  - `tasklite backup now`;
  - `tasklite restore <file>`: refuses while the server is running. Run it with `docker compose run --rm tasklite tasklite restore …` after stopping the service. It verifies the archive before replacing anything.
- Settings shows the last backup time and how long backups are kept.

---

## 6. MCP tool contract

Tools are snake_case, with input and output schemas defined in `shared/` with zod, and every result returns `structuredContent`. Lists are paginated with `cursor` and `limit` (default 25, max 50) (A02).

- **Mutating tools:**
  - take an optional `expected_version`; a mismatch returns `conflict` with the current record (A07);
  - take an optional `idempotency_key`; a replay with the same key and arguments returns the original result, while a replay with different arguments returns `validation`.
- **Every call carrying `run_id` is a signal** (§5.4).
- **Errors** return `isError: true` and `structuredContent: {code, message, details?, current?}`, where `code` is one of `validation`, `conflict`, `not_found`, `forbidden`, `unavailable`, `internal` (A10). The message is one sentence that says what to do next.

| Tool | Purpose | Key inputs → output | Req |
|---|---|---|---|
| `whoami` | Connection check | → `{client, session_id, server_version, limits, time}` | A01, A10 |
| `list_projects` | | → `[{key, name, counts}]` | A02 |
| `search_items` | Bounded search | `project?, text?, status?[], type?[], label?, epic?, filter?: ready_to_start\|blocked\|waiting_for_review\|mine\|deferred_review, include_archived?=true, cursor?, limit?` → items with `id, title, type, status, priority, blocked_by[], lead, run_state, version` | A02, A05 |
| `get_item` | Full item | `id` → fields, acceptance, labels, links (blocks/blocked_by/relates, each with status), checklist (work with plan version, agent checks, human review with states), lead and recent runs, open question and answer, `unread_owner_notes` (marked read), documents (latest versions), packets (summary), commits, artifacts, 20 most recent events | A02, H13 |
| `create_item` | | `project, type, title, description?, outcome?, acceptance?[], priority?=2, epic?, labels?[], status?: inbox\|planning (default inbox), planned_start?, planned_end?, effort?` → item | A03 |
| `update_item` | Edit fields | `id, expected_version, title?, description?, outcome?, acceptance?[], priority?, epic?, labels?[], planned_start?, planned_end?, effort?` → item. Dates record `dates_set_by` = the caller. | A03, A18 |
| `set_status` | Transition | `id, status, reason?` → item, or `validation` listing the allowed transitions | §5.1 |
| `link_items` / `unlink_items` | | `from, to, type: blocks\|relates` → link; a cycle returns `validation` with the path | A04 |
| `upsert_label` | Agents may create labels | `project, name, brief?` → label | decision 13 |
| `claim_lead` / `release_lead` | | `id, agent_label?` → `{run_id, lease_expires_at}`, or `conflict` with the claimant / `id, run_id, reason?` | A15 |
| `start_run` | Child run under a lead | `id, parent_run_id, agent_label?` → `{run_id}` | A06 |
| `heartbeat` | Explicit signal | `run_id, current_step_id?, note?` → `{lease_expires_at}` | A06 |
| `finish_run` | | `run_id, result: finished\|failed, summary, error?` → run | A06 |
| `set_plan` / `update_step` | Work checklist | `id, steps:[{text, state, id?}], reason` → plan version / `id, step_id, state, note?` | A16 |
| `log_subagent` | | `id, step_id?, name, outcome, evidence?, provenance: observed\|relayed, child_run_id?` | A17 |
| `set_checks` / `update_check` | Agent review | `id, checks:[{text, state, evidence?, provenance}]` / `id, check_id, state, evidence?` | H06 |
| `declare_human_review` / `update_human_review` | | `id, items:[text]` / `id, hr_item_id, text?, remove?` (rejected while `ready`) | decision 13 |
| `submit_packet` | Hand off | `id, built_from_commit, estimate, hr_item_ids?, how[], checked[{text, provenance, evidence}], gaps[], attachments[{document_version_id, caption}]` → packet | decision 13 |
| `get_review` | Read decisions | `id` → rounds with per-item decisions and notes | A09 |
| `ask_owner` | | `id, run_id?, question` → question | H02 |
| `add_note` | Progress note / comment | `id, text, run_id?` → event | A08 |
| `put_document` | | `item_id? \| project, name, kind, content_text? \| content_base64?, mime?` → `{document_id, version_no, document_version_id}` | H10 |
| `link_artifact` | | `id, kind, label, url?, state?` | A08 |
| `report_commit` | | `id, sha, branch?, message?, pr_url?` → commit, plus `stale_packets[]` if any went stale | decision 13 |
| `get_changes` | Poll | `cursor?, project?, limit?` → `{events[], next_cursor}` | A13 |
| `dependency_subgraph` | | `id, depth?=2 (1–5), direction?: up\|down\|both` → nodes with status and dates (each date labelled `entered` or `none`) and edges, plus the downstream items whose dates are at risk | A11 |
| `deferred_reviews` | Cleanup list | `project?` → deferred items with follow-up status | decision 13 |

**Tool descriptions** (the text agents read) must state the workflow in one or two sentences each:
- claim from Ready;
- publish the plan as checklist Work steps, not as new tickets;
- declare human review during Planning when the owner must verify something;
- report commits for the ticket they belong to;
- submit a packet when the work is built and the agent's own checks pass.

These descriptions are the agents' only manual, so write and review them as product copy.

---

## 7. UI JSON API

Every route requires the owner session (§3). JSON bodies are validated with the shared zod schemas. Responses carry the version numbers the client needs for its next write. List endpoints accept `scope` (`all` or a project key).

| Method & path | Used by |
|---|---|
| `POST /api/session/unlock` `{key}` · `POST /api/session/lock` | Unlock screen, Settings |
| `GET /api/bootstrap` | Shell: projects, labels, sidebar counts, settings, health |
| `GET /api/needs-you?scope` | Needs you: `for_you_now[]` (packets, questions), `problems[]`, `deferred[]`, `planning_queue[]`, `agent_counts{}` |
| `GET /api/work?scope&epic&label&filter&layout` | Work board/list/map; Timeline adds dates and forecast |
| `GET /api/burndown?scope&epic&label` | Timeline burn-down card |
| `GET /api/items/:id` | Ticket or epic page (all four tabs; small enough to load at once) |
| `POST /api/items` | Quick capture: `{title, type, project, epic?, notes?}` → item in Inbox |
| `PATCH /api/items/:id` | `{expected_version, priority? , status?: planning\|ready}` |
| `POST /api/items/:id/archive` · `/unarchive` · `POST /api/archive` `{ids[]}` | Archive, Archive all |
| `POST /api/items/:id/work` · `DELETE …/work/:stepId` | Owner work steps |
| `POST /api/items/:id/checks` · `DELETE …/checks/:checkId` | Owner agent-review items |
| `POST /api/items/:id/human-review` · `PATCH`/`DELETE …/human-review/:hrId` | Human review items |
| `POST /api/items/:id/notes` `{text}` | Note for the agent |
| `POST /api/items/:id/answer` `{question_id, text}` | Answer a question |
| `POST /api/items/:id/release` · `POST /api/items/:id/return-to-ready` | Lead and runs actions |
| `DELETE /api/links/:linkId` | Cycle fix, and removing a canceled blocker |
| `GET /api/review/:id?round` · `POST /api/review/:id/decisions` · `POST /api/review/:id/refresh` | Packet screen |
| `POST /api/deferred/:hrId/follow-up` | *Create test ticket* |
| `GET /api/labels/:project/:name` · `POST /api/labels/:project/:name/move-to-ready` | Label page |
| `GET /api/agents?scope` | Agents table |
| `GET /api/settings` · `DELETE /api/projects/:key` `{confirm_key}` | Settings |
| `GET /api/search?q` | Command palette (items, labels, views) |
| `GET /api/documents/:versionId/content` | Document viewer, attachments |
| `POST /api/import/jira/dry-run` · `GET /api/import/jira/:id` · `POST /api/import/jira/:id/commit` · `DELETE /api/import/jira/:id` | Jira import (§9) |
| `POST /api/mutations/:id/undo` | Undo toast |
| `GET /api/stream` | SSE: `event: change`, `data: {seq, objects:[{kind, id}]}`. The client invalidates matching TanStack Query keys. Supports `Last-Event-ID`. Sends a heartbeat comment every 25 s. |
| `GET /healthz` (process up) · `GET /readyz` (database writable, docs dir writable, migrations current) | Compose healthcheck, sidebar health line |

---

## 8. Seed data

`design/sample-data.json` is the prototype's dataset in shorthand. The seed loader (`tasklite seed sample`, or `TASKLITE_SEED=sample` when the database is empty) maps it into the schema:

- **Time shift:** the prototype's clock is `2026-11-06T11:00` local. Shift every date and time by `now − that clock`, so relative states ("silent 47m", "lease expires in 13 min") look current on the day you run it. Times like `'09:10'` mean that day; `'Nov 5'` means a date.
- **`items[]`:**
  - `prio` → `priority`;
  - `blockedBy` → `blocks` links;
  - `relates` → `relates` links;
  - `hr` → `hr_items`: `state` maps directly; `epicLevel` marks a review on an epic; `last` → `last_decision`;
  - `lead` → `client · label` of an open lead run, and `run` sets the run state;
  - `start`/`end`/`setBy` → planned dates;
  - `actual` → events;
  - `pts` → `effort`;
  - `question` → `questions`;
  - `closedBy` → `closed_by`;
  - `imported` → `imported`, with a made-up `jira_key`.
- **`detail{}`:**
  - `outcome`, `acceptance`;
  - `work` → `work_steps`: `s` is state, `t` text, `who`/`when` the state author and time, `was`/`why` the revision, `from` the review link, and `contrib` → `subagent_logs` as `[provenance, name, source, outcome]`;
  - `checks` → `agent_checks` as `[text, provenance, evidence, state, by]`;
  - `history` → `plan_versions`;
  - `docs` → `documents`: `[name, version, by, when]`. Generate the bytes: a short Markdown stub for `.md`, a placeholder for binaries;
  - `activity` → events as `[time, summary]`;
  - `runs`, `conflict`, `error` → runs and events.
- **`packets{}`** → `packets` and `decisions`: `rounds[].decided.verdicts[]` uses `k` for kind.
- **`changes[]`:** historical events. "Since you looked" was removed from the UI, so use them only as Activity rows.

The seed exists so the acceptance tests (§10) run against a known state. Keep the loader deterministic.

---

## 9. Jira import

O05; owner decision 17 puts it in V1.

**Flow** (UI in UI_SPEC.md §9.2):
1. The owner enters the Jira site URL, account email, API token, Jira project key, and a target Task Lite project (new key and name, or an existing empty project).
2. **Dry run:** the server reads the Jira Cloud REST v3 API (search with JQL `project = X ORDER BY key`, then issue links, comments, attachments metadata and fields). It builds the mapped records **in memory** and produces a report. It writes nothing except the report.
3. The owner reviews the report, then *Import* commits everything in one transaction. Attachment bytes download after the commit, and failures are reported per file.
4. The API token is held in memory for the import session only (expires after 1 hour or on cancel). It's never stored, logged or written into the report.

**Mapping** (anything lossy appears in the report):

| Jira | Task Lite | Lossy? |
|---|---|---|
| Epic | Epic | — |
| Story, Task, Bug | same type | — |
| Sub-task | Work step on the parent (state from status category) | Yes: the subtask's own comments, assignee and dates drop out (listed) |
| Other issue types | Task | Yes: the original type is noted in the description |
| Status category To Do / In Progress / Done | Inbox / In progress (no lead claim, no run) / Done (`closed_by=imported`) | Status names are noted when not standard |
| Priority Highest, High / Medium / Low, Lowest | P1 / P2 / P3 | — |
| Parent epic | `epic_id` | — |
| Blocks link | `blocks` | — |
| Relates, Duplicates, Clones, other links | `relates` | Yes: the link type name is noted |
| Labels | Labels (created) | — |
| Description (ADF) | Markdown | Yes: unsupported nodes are listed |
| Comments | Events (`imported comment`, author display name, date) | — |
| Attachments | Documents (≤500 MB each) | Larger files are skipped and listed |
| Due date / start date field / story points field | `planned_end` / `planned_start` / `effort` | Field IDs vary by site: auto-detect by name, and list the field used |
| Assignee, reporter, sprint, fix version, components, other custom fields | not mapped | Yes: counts appear in the report |

Every imported item keeps `jira_key`, which search finds, and has `imported = true`. Cycles found in Jira links are imported as they are and show up under Problems.

**The report** (JSON, also rendered in the UI) contains:
- counts by type, mapped, skipped and lossy, per field;
- the list of lossy items with reasons;
- detected cycles;
- the attachments total size.

After import, the report is stored as an `import_report` document on the project.

---

## 10. Testing and acceptance

### Unit (Vitest)
Every rule in §5 has tests:
- status guards;
- blocked/ready derivation and cycle rejection, including across projects;
- claim races (two concurrent `claim_lead` → exactly one succeeds);
- displayed run states at window boundaries, including the restart sweep;
- packet decision outcomes (approve all, any changes, defer with or without follow-up, mixed);
- stale packets (ticket-level and epic-level);
- undo windows and conflicts;
- archive guards;
- burn-down replay and forecast thresholds;
- Jira mapping of every row in §9.

### Integration
- Drive `/mcp` with the official MCP client SDK.
- Two simultaneous clients, conflict responses, idempotent replays, structured errors for every error code.
- A full lifecycle: create → plan → claim → subagent log → checks → declare review → commit → packet → owner decision through `/api` → done.

### End to end (Playwright against a seeded container, Chromium)
Port the prototype's scenario checks; the list below matches what the prototype verifies today. Each bullet is a test:

- **Needs you:**
  - "3 for you" (2 packets + 1 question); only action cards plus the Problems, Deferred and Planning queue cards (no Coming up, no Since you looked);
  - answering a question clears it, and the ticket shows "Waiting for codex to read it";
  - *Inspect* on a stale run opens the Activity tab; *Fix* on a cycle opens Dependencies; *Timeline* on a date risk opens Work → Timeline;
  - *Create test ticket* for a deferred item, and undo removes it.
- **Packets:**
  - opens on the latest round;
  - submit is disabled until every item is decided, and the button names the outcome;
  - "changes" needs a note, and sending back returns the ticket to In progress with the item coming up again;
  - a finding becomes a checklist step or a new Bug linked back;
  - defer offers *Close ticket (1 deferred)*, the closed ticket says "deferred, not verified", and a follow-up test ticket in Inbox carries the item;
  - an out-of-date packet shows its built-from commit and a banner, and *Ask for a fresh packet* clears it from For you;
  - approving all closes with owner provenance and unblocks dependents;
  - past "needed changes" decisions render amber, not green;
  - attachments open in the viewer;
  - undo works for send-back, defer and refresh.
- **Tickets and epics:**
  - four tabs (Details, Checklist, Dependencies or Map, Activity), with counts and attention dots;
  - epics open on Details, and Details doesn't hold the checklist;
  - the Checklist tab has three collapsible sections, and collapse state carries across tickets;
  - human review items can be added, edited and removed, but packet items are locked;
  - work steps and agent checks can be added and removed;
  - a child ticket says "reviewed with its epic";
  - Dependencies shows the 1-hop view with *See it on the epic map*;
  - Activity has Lead & runs, History and the note box, and notes are logged;
  - releasing a stale claim confirms with focus on Cancel, and undo restores it;
  - breadcrumbs return to the epic on the tab you left.
- **Map:**
  - waves plus an "Outside this epic" column;
  - done items and the done count;
  - arrows drawn and kept on resize and zoom; hover highlights links;
  - overflow shows "More" pills and a drag hint; drag pans; Fit, reset and zoom steps work;
  - the person icon on cards: filled = packet ready, outlined = review later, none = no review.
- **Work:**
  - Board, List, Map and Timeline layouts;
  - the Epics row opens epics;
  - the filters are Blocked, For you, Human review later, Deferred review, Live run, and Archived (shown once anything is archived); the agent query shows as a tooltip;
  - a Review card with a packet ready opens the packet;
  - Done cards have Archive and the column has *Archive all*; archived items leave every view, open from search with *Unarchive*, and fold into "+ N archived" on an epic; undo restores them.
- **Labels:** the label page groups items across epics; *Move N to Ready* works and then disappears; *Show on the board* filters Work.
- **Shell:**
  - the sidebar is Needs you, Work, Agents and Settings;
  - open-item tabs open, switch and close (closing the active tab moves to a neighbour), with at most 8;
  - quick capture: + New focuses the title, a title is required, and the item lands in Inbox and opens; *+ New item in this epic* prefills the epic;
  - the command palette finds items and labels, and Esc closes it;
  - Settings holds projects and connections.
- **Cross-cutting:**
  - axe finds no serious or critical violations on each screen, in both light and dark themes;
  - at 1024×900 the packet's decision panel sits under the queue;
  - every visit starts at All projects (a new browser context sees scope All).

### Smoke test with real clients (O07)
`docker/smoke/` holds a script and a checklist. For each surface (installed Codex, installed Claude Code, an Orca worker running Codex, and an Orca worker running Claude):
1. Configure the client with the snippet from Settings.
2. Run `whoami`.
3. Claim a disposable sample ticket, publish a plan, log a step and read it back.
4. Confirm that the UI shows the client name correctly and the run as live.

Record the results in the Settings compatibility matrix. A surface that can't connect gets "Not verified" and a note. Do not build a bridge unless a required surface fails.

---

## 11. Milestones for the integration agent

Work in order. Each milestone ends with its own tests green and a short demo note in the PR. Track the work however you like, but keep milestone boundaries as PR boundaries.

| # | Deliverable | Done when |
|---|---|---|
| M0 | Workspace scaffold, lint, typecheck, Vitest, Dockerfile, compose, `/healthz` and `/readyz`, CI workflow | `docker compose up` serves "Task Lite is running"; CI is green |
| M1 | Schema and migrations, domain services for §5, event log, idempotency, undo, seed loader | Unit tests for every §5 rule pass; the seed loads deterministically |
| M2 | MCP server: auth, Host/Origin guards, identity, every §6 tool, structured errors, sweeper, restart handling | Integration tests pass; two simultaneous SDK clients work |
| M3 | Owner session and CSRF, UI API (§7), SSE stream | API contract tests pass; the unlock flow works |
| M4 | Web shell, tokens, Needs you, Work board and list, ticket and epic pages (four tabs, checklist editing), open-item tabs, palette, quick capture | The e2e groups for Needs you, Tickets and epics, and Shell pass |
| M5 | Packet screen and decisions, deferrals, questions and notes, archive, undo toasts | The e2e groups for Packets and Work (archive) pass |
| M6 | Progress map (epic, label, Work → Map), Timeline, Label pages, Agents, Settings, document viewer | The e2e groups for Map, Labels and cross-cutting pass |
| M7 | Burn-down and forecast, Jira import (dry run and import), backup/restore CLI, delete project. Stretch: `tasklite export` | Unit tests for forecast and mapping pass; a dry run against a test Jira project produces a report |
| M8 | O07 smoke with real clients, an accessibility pass, dark mode and 1024 px checks, a README quick start | The smoke matrix is filled in; axe is clean; the README walks through from an empty machine to a connected agent in under 10 minutes |

---

## 12. Things to verify during the build

These can't be settled on paper. Each one has a default already, so none of them blocks starting.

| # | Question | Default until verified | Where |
|---|---|---|---|
| V1 | Do Codex and Claude Code keep their MCP session open, and do they answer server `ping`? This decides whether *live* is reachable or every run shows as *reported*. | The §5.4 rules. If pings aren't answered, *live* relies on requests alone, and the UI is still truthful. | M2, M8 |
| V2 | Does an Orca worker running Claude inherit the user's MCP configuration? (The Codex one was verified in discovery.) | Show "Not verified" in Settings until the smoke test passes. | M8 |
| V3 | Exact client config syntax: the Codex `bearer_token_env_var` key, and the Claude `mcp add --transport http … --header` form. | Use the prototype's snippets, check them against each client's current docs, and fix the Settings snippets to match. | M8 |
| V4 | Field IDs for start date and story points on the owner's Jira site. | Detect them by field name, and let the dry-run report show which field was used. | M7 |
| V5 | SQLite WAL performance on a Docker Desktop named volume on Windows. | Named volume (not a bind mount). If writes are slow, measure before changing anything. | M1 |

---

## 13. Definitions the UI and MCP share

These must be byte-for-byte the same on both sides, so put them in `shared/`:
- status names and order;
- run-state names and one-line meanings;
- provenance kinds and labels;
- item types;
- filters and their agent-query strings: `status:planning`, `status:ready -is:blocked`, `is:blocked`, `needs:human`, `has:human-review`, `review:deferred`, `run:live`, `is:archived`. Each saved filter's tooltip shows its query, and `search_items` accepts the same filters.

---

## 14. Decisions log

Owner decisions are marked **(owner)**. Every other entry is a technical choice made in this spec. Change one by editing this table and the section it points to.

| # | Decision | Section |
|---|---|---|
| 14 **(owner)** | Stack: TypeScript end to end. Node 22, the official MCP SDK, Hono, SQLite with Drizzle, React with Vite. | §2 |
| 15 **(owner)** | Requirement O11 (project-level approval policies) is **superseded** by decision 13. Gates are per-ticket human review items declared according to the project's workflow, and the tracker enforces only "can't close while a review item is undecided". H06's "project with a required owner gate" becomes "ticket with human review items". | §5.1, §5.6 |
| 16 **(owner)** | One agent bearer token. Identity comes from the MCP `clientInfo`, plus an optional `agent_label`. | §3 |
| 17 **(owner)** | V1 also includes the Timeline layout, Label pages, burn-down and forecast, and the Jira import (dry run and import). | §1, §5.9, §9 |
| T1 | One port (7420) for MCP, API and UI, published only on 127.0.0.1, with Host and Origin allowlists. | §2, §3 |
| T2 | A separate owner key and browser session, so agents can't record human approval through the API. | §3 |
| T3 | Displayed run state is derived from session signals (requests and pings) using `LIVE_WINDOW` 2 m, `STALE_AFTER` 30 m and `LEASE` 60 m. Restart interrupts open runs. | §5.3, §5.4 |
| T4 | IDs are `<KEY>-<n>`, numbered per project. | §4 |
| T5 | Optimistic concurrency with `version`; idempotency keys kept for 24 h. | §4, §6 |
| T6 | Owner undo is server-side, within 60 s, by inverse event. The UI toast lasts 6 s. | §5.11 |
| T7 | Canceled blockers still block until someone removes the link. | §5.2 |
| T8 | Agent checks are recorded but don't gate Done. Only human review items do. | §5.1 |
| T9 | Document limits: 25 MB through MCP, 500 MB through bearer HTTP upload. Fixed list of preview formats. | §5.10 |
| T10 | Live UI updates by SSE plus query invalidation. Agents poll `get_changes`. | §5.11, §7 |
| T11 | Forecast: last 4 weeks, at least 8 completed estimated items, 10,000-trial Monte Carlo, P50 and P85. | §5.9 |
| T12 | Jira import reads the Jira Cloud REST API with a token held in memory only. No CSV path. | §9 |
| T13 | Nightly backup at 03:00, kept 14 days, restore by CLI only. | §5.13 |
| T14 | Archive is owner-only and UI-only; agent queries include archived items. | §5.8 |
| T15 | Scope resets to All projects on each visit (sessionStorage). Theme and collapsed sections persist (localStorage). | UI_SPEC §2 |
