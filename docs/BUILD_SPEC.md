# Task Lite: V1 build spec

Status: ready to build, 2026-11-07. This is the implementation contract for MVP V1. It is written for an integration agent working without the design conversation.

**Read in this order:**
1. This file: architecture, data model, rules, MCP tools, UI API, milestones and decisions.
2. [MCP_SPEC.md](MCP_SPEC.md): the full agent-facing contract. It holds the server instructions, every tool's final description text and schemas, errors, worked flows, contract tests and client setup. Agents are the primary users, so this is as important as the UI.
3. [UI_SPEC.md](UI_SPEC.md): screens, components, tokens, states and accessibility.
4. [design/prototype.html](../design/prototype.html): the visual and behavioural reference. Open `?selftest` to render every view.
5. [design/sample-data.json](../design/sample-data.json): the seed data, exported from the prototype.
6. [templates/AGENTS-tasklite.md](templates/AGENTS-tasklite.md): the block each project adds to its `AGENTS.md` or `CLAUDE.md`. Ship it in the repo; the README tells owners to use it.
   - [../skills/](../skills/README.md): the agent skills (owner decision 27). Ship them in the repo; CI lint-checks them against the tool contract.
7. [ROADMAP.md](ROADMAP.md): what is deliberately *not* in V1 (dispatching, GitHub-observed merges, contracts, a knowledge layer), the pre-pilot checklist, and the TERSL reference notes. Don't build anything from it.
8. Background only, not instructions: [REQUIREMENTS_DRAFT.md](REQUIREMENTS_DRAFT.md) (requirement IDs such as A05 and H04 cited below), [UI_DESIGN.md](UI_DESIGN.md) (design rationale and revision history) and [JIRA_RESEARCH.md](JIRA_RESEARCH.md).

**Where the docs disagree:** this file and UI_SPEC.md win over the requirements draft and UI_DESIGN.md. Where the prototype and UI_SPEC.md disagree, UI_SPEC.md wins. Every place this spec deliberately departs from the draft is listed in [Decisions](#14-decisions-log).

---

## 1. What V1 is

Task Lite is a local **agent coordination service** with a human supervision UI. It's the shared, enforced source of truth that agents work through: work items and their dependencies, eligibility to start, lead claims and leases, plans and evidence, decision records, and the owner's review gates. It runs as one Docker container on the owner's machine and serves three things on one port:

- an **MCP endpoint** (`/mcp`). Installed agent clients (Codex, Claude Code, and both launched as Orca workers) use it to plan, claim, update and hand off work;
- a **JSON API** (`/api`) for the web UI;
- the **web UI** (`/`). It exists so the owner can see what agents did, what they're doing, and what needs the owner.

The service never calls a model API and never launches an agent (O08). It is the **coordinator**, not the dispatcher (owner decision 18): it holds the authoritative record of what work exists, what is eligible to start, who holds it, and the rules (blocking, leases, review gates), and it enforces them on every call. Orca, or the owner, decides when to start an agent; the agent then asks Task Lite what to do.

### In scope for V1
All P0 requirements, plus four P1 items the owner pulled in: the Timeline layout, Label pages, burn-down and forecast (H14, A18), and the Jira import dry run and import (O05). The UI covers every screen in the prototype plus two screens that weren't prototyped: burn-down/forecast and Jira import. Those two are specified in UI_SPEC.md §9.

V1 also includes four coordination features from the 2026-11-14 review (owner decision 19):
- a **context bundle** for agents (`get_context`, §5.15);
- **decision records** that all agents can read (§5.14);
- **lean agent responses**: summary views, field selection and compact text results (MCP_SPEC §3);
- **stricter dependency rules**: a blocker can be required to be merged or verified, not just done (§5.2).

### Out of scope for V1
- Machine-readable full export (O06; a `tasklite export` CLI is a stretch goal, see M7).
- Bulk mutation tools for agents (A12).
- Git/CI integrations (A14).
- Sprints and dashboards (H12).
- A restore UI (restore is a CLI).
- Editing planned dates, effort and blocker links from the UI (part of H11; agents do it, or the owner leaves a note). The owner *does* edit title, description, outcome and acceptance criteria inline (owner decision 22).
- Access from other devices.
- Dispatching or launching agents (owner decision 18).
- Observing merges and CI directly. A blocker's "merged" state is agent-reported in V1; see ROADMAP.md.
- Versioned interface contracts with invalidation, and a general knowledge base beyond decision records (ROADMAP.md).

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
| CI | GitHub Actions on GitHub-hosted `ubuntu-latest` runners (free on this public repo; no Namespace or self-hosted runners). One workflow, `.github/workflows/ci.yml`, on pull requests and pushes to `main`: install with a pnpm cache, then lint, typecheck, Vitest, and `docker build`. From M4 it also runs Playwright end to end (Chromium) against the built image with the sample seed, uploading the report and traces as artifacts on failure. Mergify's merge queue waits for this check. |

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
| `TASKLITE_LEASE` | `60m` | Lead claim lease, renewed by any signal from the run. Suspended while the run is parked. |
| `TASKLITE_PARK_MAX` | `24h` | How long a run may stay parked before it shows under Problems. It keeps its claim either way. |
| `TASKLITE_RESUME_UNATTENDED` | `30m` | How long a parked run may sit `resume_ready` before it shows under Problems as "Ready to resume". |
| `TASKLITE_ORPHAN_AFTER` | `15m` | How long a resource may stay unreleased after its run ends before it shows as an orphaned resource. |
| `TASKLITE_PUSH_ROOT` | unset | Opt-in push install (decision 29): the container path of a host folder the owner mounts, for example `/host-code`. Unset means push install is off. |
| `TASKLITE_PUSH_HOST_PATH` | unset | The same folder's path on the host, for example `C:/Users/me/code`, so the UI can show and accept host paths. |
| `TASKLITE_DRIFT_CHECK_INTERVAL` | `15m` | How often push-folder installs are checked for files edited outside Task Lite (decision 30). |
| `TASKLITE_BACKUP_AT` | `03:00` | Local time for the nightly backup. |
| `TASKLITE_BACKUP_KEEP` | `14` | Days of backups kept, in every location. |
| `TASKLITE_BACKUP_EXTRA_DIR` | (unset) | Opt-in extra backup location: the path *inside the container* of a host folder bind-mounted by the owner (e.g. `/backups-extra`). When it's set and writable, each nightly backup is also copied there (owner decision 24). |
| `TASKLITE_TEXT_ONLY_CLIENTS` | `claude-code` | MCP clients whose sessions get text-only tool results (MCP_SPEC §3 Results; owner decision 28): exact `clientInfo.name`s, comma-separated, ignoring case. `none` gives every client structured results. The default is the name Claude Code sends. |
| `TASKLITE_SEED` | (unset) | `sample` loads the sample data into an empty database. |
| `TZ` | host TZ | Display time zone. Storage is always UTC. |

`docker/compose.yaml` publishes `127.0.0.1:7420:7420` only (O02), mounts the named volume `tasklite-data:/data` (plus a commented-out, opt-in bind mount for the extra backup folder, e.g. `~/TaskLiteBackups:/backups-extra`), sets `restart: unless-stopped`, and has a healthcheck on `/healthz`.

### Volume layout

```
/data/tasklite.db (+ -wal, -shm)
/data/docs/<PROJECT_KEY>/<document_id>/v<n>/<filename>
/data/secrets/agent-token  /data/secrets/owner-key
/data/logs/calls-YYYYMMDD.jsonl   (diagnostic call log, kept 7 days)
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
| `projects` | `key` (2–5 uppercase letters, unique), `name`, `short_name`, `color`, `next_seq`, `default_satisfied_when` (done\|merged\|verified, default done), `deleted_at` | Item IDs are `<KEY>-<n>`. `next_seq` increments inside the creating transaction. |
| `items` | `id` (`RCP-14`), `project_key`, `type` (Epic\|Story\|Task\|Bug), `title`, `description_md`, `outcome_md`, `status`, `priority` (1–3), `epic_id` (nullable; must be an Epic in the same project), `planned_start`, `planned_end`, `dates_set_by`, `dates_set_at`, `effort` (number, nullable), `effort_unit` ('pts'), `closed_by` (owner\|agent\|imported), `closed_at`, `archived_at`, `jira_key`, `imported` (bool), `from_review` (JSON: `{item_id, round, hr_item_id}`), `version` | `status`: inbox, planning, ready, progress, review, done, canceled. |
| `acceptance_criteria` | `item_id`, `position`, `text` | Ordered list. |
| `labels` | `project_key`, `name`, `brief_md`, `brief_by`, `brief_at` | Unique per project. |
| `item_labels` | `item_id`, `label_id` | |
| `links` | `from_id`, `to_id`, `type` (blocks\|relates), `satisfied_when` (null = the blocked item's project default; done\|merged\|verified), `created_by` | For `blocks`, `from` blocks `to`. Creating a link that closes a cycle is rejected (A04). |
| `plan_versions` | `item_id`, `version_no`, `reason`, `created_by` | The Work checklist history (A16). Each `set_plan` writes a version. |
| `work_steps` | `item_id`, `plan_version_no`, `position`, `text`, `state` (todo\|current\|done\|blocked\|skipped), `was_text`, `change_reason`, `from_review` (JSON), `added_by`, `state_by`, `state_at` | The current plan is the latest `plan_version_no`. |
| `subagent_logs` | `item_id`, `work_step_id`, `name`, `outcome`, `evidence`, `provenance` (observed\|relayed), `child_run_id`, `reported_by_run_id` | A17. |
| `agent_checks` | `item_id`, `position`, `text`, `state` (todo\|pass\|fail\|skipped), `evidence`, `provenance` (agent\|observed\|relayed\|ci), `added_by` | The checklist's Agent review section. |
| `hr_items` | `item_id`, `position`, `text`, `state` (declared\|ready\|approved\|deferred), `added_by` (owner\|agent actor), `last_decision` (JSON), `follow_up_item_id`, `version` | Human review items. `ready` means it's in the current packet. |
| `packets` | `item_id`, `round`, `content_hash` (displayed as `pkt-xxxx`), `built_from_commit`, `estimate`, `how` (JSON), `checked` (JSON), `gaps` (JSON), `created_by`, `state` (open\|decided\|withdrawn) | One row per round. |
| `packet_items` | `packet_id`, `hr_item_id`, `text_snapshot` | Freezes the item text as it was in this round. |
| `packet_attachments` | `packet_id`, `document_version_id`, `caption` | |
| `review_decisions` | `packet_id`, `hr_item_id`, `kind` (approve\|changes\|defer), `note`, `into` (checklist\|bug), `follow` (ticket\|none), `result_ref`, `decided_at` | Always owner. |
| `runs` | `item_id`, `parent_run_id`, `client`, `label`, `session_id`, `is_lead`, `state` (open\|needs_input\|finished\|failed\|interrupted), `last_signal_at`, `last_signal_kind` (session\|report\|relayed), `lease_expires_at`, `summary`, `error`, `current_step_id`, `end_reason` (finished\|failed\|released\|lease_expired\|owner_released\|service_restart\|canceled), `parked_reason`, `waiting_on` (JSON), `parked_at`, `workspace` (JSON: host, repo, path, branch, base_ref, base_sha, head_sha, pushed_sha, dirty, updated_at), `orchestrator` (JSON: name, dispatch_id, task_id, run_id), `brief_document_version_id`, `external` (JSON, ≤ 2 KB), `unpushed_handled_at` (set by the owner's *Handled*) | The displayed run state is derived (§5.4). The stored `state` gains `parked`. Workspace state is derived (§5.16). |
| `run_resources` | `id` (`rsc_…`), `run_id`, `kind` (process\|dev_server\|session\|container\|temp_dir\|port\|other), `label`, `locator` (JSON: pid, port, session_id, container, path, host), `started_at`, `released_at`, `released_by`, `release_note` | §5.16. |
| `questions` | `item_id`, `run_id`, `text`, `asked_by`, `answer`, `answered_at`, `read_by_agent_at` | |
| `owner_notes` | `item_id`, `text`, `read_by_agent_at` | |
| `commits` | `item_id`, `run_id`, `sha`, `branch`, `message`, `pr_url`, `pushed`, `reported_by`, `reported_at` | Drives packet staleness. With `pushed`, it also sets the run's `workspace.pushed_sha`. |
| `agent_files` | `id` (`af_…`), `key` (`skill:<name>` or `agents_block`), `layer` (bundled\|service\|project), `project_key` (project layer only), `current_version_id`, `bundled_hash_at_edit` | One row per key, layer and project. Unique `(key, layer, project_key)`. §5.17. |
| `agent_file_versions` | `id` (`afv_…`), `file_id`, `version_no`, `content` (≤ 50,000, B21), `sha256`, `author`, `note`, `created_at` | Immutable. |
| `project_workflows` | `project_key`, `version_no`, `content_md` (≤ 10,000), `author`, `note`, `created_at` | Versioned; the newest is current. Delivered in `get_context` (§5.15). |
| `installs` | `id` (`ins_…`), `at`, `client` (claude\|codex), `target_kind` (repo\|user), `project_key` (nullable), `path` (nullable; required for push), `method` (command\|push), `manifest` (JSON: key → `{version_id, sha256}`), `token_sha256`, `token_expires_at`, `token_used_at` | §5.17. A command install keeps only its token's sha256 and expiry, never the token (B21). |
| `agent_file_proposals` | `id` (`afp_…`), `project_key` (nullable), `file_key`, `content`, `reason`, `based_on_version_id`, `run_id`, `proposed_by`, `state` (pending\|approved\|declined), `decided_at`, `decided_note`, `result_version_id` | §5.19. `based_on_version_id` is an `afv_…` or `wf_…` ID (not a foreign key), null for Workflow notes that didn't exist yet. |
| `instruction_reports` | `id` (`irp_…`), `source` (agent\|push_check), `run_id` (nullable), `install_id` (nullable), `project_key`, `location`, `files` (JSON: key → `{sha256, content?}`), `at` | §5.19. |
| `drift` | `id` (`dft_…`), `install_id`, `project_key` (nullable: a user-wide install), `file_key`, `change` (edited\|missing\|extra), `state` (open\|adopted\|restored\|kept_local), `local_sha256` (null when missing), `report_id` (the instruction report that found it), `detected_at`, `resolved_at` | One open row per install and file; *Keep local* stores the accepted hash. B26 added `change` and `report_id`. A report without an `install_id` is stored but raises no drift. |
| `artifacts` | `item_id`, `kind` (url\|pr\|ci\|deploy\|test), `label`, `url`, `state`, `provenance` | A08 evidence links. |
| `documents` | `project_key`, `item_id` (nullable), `name`, `kind` (planning\|packet_attachment\|import_report\|brief\|other; `brief` is written only through `claim_lead`/`start_run`) | Unique `(item_id, name)`. |
| `document_versions` | `document_id`, `version_no`, `mime`, `size`, `sha256`, `path`, `created_by` | Immutable. |
| `events` | `seq` (autoincrement, the change cursor), `at`, `actor_kind` (owner\|agent\|system), `client`, `label`, `run_id`, `project_key`, `item_id`, `type`, `summary`, `data` (JSON), `inverse` (JSON, nullable), `mutation_id`, `idempotency_key` | Append-only (O03). `summary` is the one-line text shown in Activity. |
| `idempotency` | `key`, `client`, `request_hash`, `response`, `expires_at` | Retained 24 h. |
| `decision_records` | `id` (`dec_…`), `project_key`, `scope_kind` (project\|epic\|label\|item), `scope_id`, `title`, `decision_md`, `rationale_md`, `authority` (owner\|agent), `author` (actor), `status` (active\|superseded\|withdrawn), `supersedes_id`, `confirmed_at`, `version` | §5.14. Separate from review decisions. |
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
| progress → progress (resume) | agent via `claim_lead` | No active lead claim. This is how sent-back work and failed runs are picked up again (the `resumable` filter). |
| progress → ready | owner (*Return to Ready*, *Release lead claim*), agent, sweeper on lease expiry | Ends the lead claim. |
| progress → review | agent via `submit_packet` | At least one human review item exists. |
| review → progress | owner decision with any "changes"; owner *Ask for a fresh packet*; agent | — |
| progress or review → done | agent via `set_status`, or the owner's decision outcome | **No human review item may be `declared` or `ready`** (decision 13, the only gate the tracker enforces). Agent checks are recorded, not enforced. |
| any open → canceled | agent (reason required), or owner (reason optional; owner decision 23) | An epic with open children is refused, naming them. An active lead run ends as `interrupted`, and its claim is released. An open packet is withdrawn. Owner cancel is undoable (it restores the status, not the run). |
| done → progress | agent (reopen, reason required) | — |

- Epics follow the same statuses. An epic can only become done when every child is done or canceled.
- `closed_by` is `owner` when the owner's packet decision closes the item, `agent` when `set_status` does, and `imported` for Jira imports.
- An invalid transition returns `validation` with the allowed transitions (A10).

### 5.2 Links, blocked, ready, cycles
- **When a blocker counts as cleared** depends on the link's effective `satisfied_when` (the link's own value, else the blocked item's project default, else `done`):

  | `satisfied_when` | Cleared when the blocker is… |
  |---|---|
  | `done` | in status done |
  | `merged` | done, **and** has a `pr` artifact with state `merged`. This is agent-reported in V1, and the UI says "reported merged". A GitHub integration would make it observed (ROADMAP.md). |
  | `verified` | done, **and** every human review item on it is approved (none deferred) |

  - Until then the predecessor is **unresolved**.
  - `link_items` with `verified` on a blocker that has no human review items returns `validation`: "Declare human review on X, or use done."
  - **A verified blocker that closes with deferred items stays unresolved.** Problems shows "RCP-22 needs RCP-12 verified, but 1 check was deferred" with *Open* (Dependencies tab).
  - Changing a project's default or a link's value re-evaluates blocked state immediately and records an event.
- **A canceled blocker stays unresolved,** and Problems shows "Blocked by canceled X" with *Remove link*. The tracker never silently unblocks.
- **Blocked:** open and has an unresolved predecessor. Blocking crosses projects. Parent epics and `relates` links never block.
- **Ready to start** (A05): status `ready`, not blocked, and no active lead claim.
- **Cycles:**
  - `link_items` runs a DFS and rejects a link that would create a cycle. The error includes the path, for example `DOC-7 → DOC-8 → DOC-7`.
  - Imported data can still contain cycles. Strongly connected components are computed on read; each one larger than one node is a Problem whose *Fix* opens the Dependencies view.

### 5.3 Lead claims
A15.
- `claim_lead` is atomic, a conditional update on "no active lead run". It works on Ready items that aren't blocked (moving them to `progress`) and on `progress` items with no lead (resuming them).
- A failed lead run (`finish_run` with `failed`) or a send-back from the owner leaves the item in `progress` with no lead. It shows under Problems (failed) or as `resumable`.
- If someone else holds the claim, it returns `conflict` with the current claimant, lease expiry and last signal, and records the rejected claim as an event. The Activity view shows those rejections.
- A claim creates an open lead run with `lease_expires_at = now + LEASE`. Any signal (§5.4) extends the lease. **A parked run's lease is suspended** (§5.16): it neither expires nor goes stale.
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
| parked | `state = parked` (§5.16). Never stale while parked. Shown with what it's waiting on. |
| needs input | `state = needs_input` (an open question) |
| failed / finished / interrupted | terminal `state` |

Display labels and their one-line meanings are in UI_SPEC.md §5 (run state). Subagent log entries never imply a heartbeat (JIRA_RESEARCH, last paragraph).

### 5.5 Checklist
H13, A16, A17.
- **Work steps** are the agent's plan. `set_plan` replaces the whole list as a new plan version with a reason. `update_step` changes one step's state. Revisions keep `was_text` and `change_reason`, which the UI shows as strikethrough and "Changed: …". The owner can add a step (`added_by=owner`) and remove their own undone steps. An agent's `set_plan` always keeps owner-added steps, though the agent may change their state. The same applies to owner-added agent checks under `set_checks`.
- **Agent checks** have state and evidence. The owner can add one, and remove their own while it's still todo.
- **Human review items:**
  - Agents and the owner can add them. While an item is `declared`, its author can edit or remove it. The owner can also change agent-added items, but agents can't change owner-added ones (`forbidden`).
  - Items in the current open packet (`ready`) are locked.
  - Items added while a packet is open stay `declared` and go into the next round.

### 5.6 Packets and decisions
Decision 13, H04.
- **`submit_packet`:**
  - is refused when the item is blocked, when a packet is already open, when there are no declared items (close with `set_status` instead), or when an agent check is `fail` and no gap in the packet mentions it;
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
- `ask_owner` creates an open question and sets the run to `needs_input`. An item has at most one open question at a time.
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
- Owner API mutations return a `mutation_id`. `POST /api/mutations/:id/undo` is accepted within 60 s if no later event touched the same objects; otherwise it returns `conflict`. Undo applies the stored `inverse` and records it as an ordinary event of the inverse's own type (for example `item.status_changed`). It has `data.undo_of = <mutation_id>` and the summary "Undid: <original summary>"; there is no separate `undo` event type (decided in B2).
  - The original mutation is marked undone, so undoing it again returns `conflict` ("already undone").
  - The undo gets its own `mutation_id` but cannot itself be undone (`validation`).
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
  - `tasklite checksums`: prints item, event and document checksums, to compare a restore with its backup (B15);
  - `tasklite restore <file>`: refuses while the server is running. Run it with `docker compose run --rm tasklite tasklite restore …` after stopping the service. It verifies the archive before replacing anything.
- **Extra location** (owner decision 24): if `TASKLITE_BACKUP_EXTRA_DIR` is set, the finished archive is also copied there, with the same retention. A failed or missing extra copy never fails the default backup; it shows as a Problem, "Extra backup copy failed: <reason>", until a later copy succeeds. `tasklite restore` accepts an archive from either location.
- Settings shows each location with its last successful backup time and how long backups are kept.

### 5.14 Decision records
Shared knowledge that agents must respect: "Nutrition is per serving", "Use the v2 design tokens". A record is short (title ≤ 120 characters, decision ≤ 4,000) and has a scope: project, epic, label or item. Agents see everything in scope for an item: its project, its epic, its labels, and the item itself.

- **Authority:** `owner` or `agent`.
  - Agents publish with `authority=agent`.
  - The owner publishes with `authority=owner`, or **confirms** an agent record, which sets `authority=owner` and `confirmed_at`.
  - **Owner records are authoritative.** Agents can't supersede or withdraw them (`forbidden`). To challenge one, an agent uses `ask_owner`.
- **Superseding:**
  - an agent may publish a record that supersedes an *agent* record;
  - the owner may supersede anything;
  - the old record becomes `superseded`, and both remain readable.
- **Withdrawing:** an agent may withdraw its own agent records, and the owner any record. Withdrawn records drop out of context bundles but stay in history.
- Every change is an event (`decision.published`, `.confirmed`, `.superseded`, `.withdrawn`) on the scope item, or on the project for project-scope records.
- **Not a Needs-you item.** The owner sees records where they apply (UI_SPEC §6.3) and confirms or withdraws them there.

### 5.15 Context bundle
`get_context` assembles what an agent needs to *work on* an item in one bounded, read-only response, so agents stop stitching it together over several calls. Contents, in priority order:
1. the item's essentials: title, status, outcome, acceptance, open question and answer, and a **count** of unread owner notes (`get_item` delivers them and marks them read; `get_context` never does);
2. active decision records in scope, owner records first;
3. the epic's outcome/brief, and the briefs of the item's labels;
4. blockers and dependents: ID, title, status, cleared or not, and the first line of each one's outcome;
5. the project's **Workflow** notes (decision 29), current version, truncated last among sections 1–5;
6. for Markdown planning documents on the item and its epic, the newest version of each. Text is included until the budget runs out; after that, only names and versions;
7. the latest review round's decisions and notes, if any.

**Budgets** (approximate tokens, counted as characters ÷ 4): `small` 1,000, `medium` 3,000 (the default), `large` 8,000. Sections are filled in the order above. Truncation is marked inline ("…truncated; read pantry-prd.md v3 with get_item"), never silently.

### 5.16 Recovery: workspaces, briefs, resources, parking
Owner decision 26, after an Orca crash pruned worktrees that held in-flight work. The aim: a crashed orchestrator or worker restarts **without guessing**, and nothing is left running unnoticed. Task Lite only **records**; the coordinator acts (Principle I).

- **Workspace.**
  - Set on `claim_lead` and `start_run`; patched by `heartbeat`.
  - `report_commit` with `pushed: true` sets `pushed_sha`.
  - `head_sha` comes from the latest reported commit or heartbeat.
  - **Derived state per worktree path:**
    - `in_use`: an open run;
    - `parked`: a parked run;
    - `at_risk`: no open run, and `dirty`, or `head_sha` ≠ `pushed_sha`, or unreleased resources; **or** a run ended unexpectedly (`lease_expired`, `service_restart`, `owner_released`) and its item is still open with no newer lead run, because that work is still in flight even if it's clean and pushed (B10 resolution);
    - `safe_to_prune`: all runs ended, pushed, clean, resources released, and no interrupted work waiting to be picked up again;
    - `unknown`: not enough data.
- **Brief.** `claim_lead` and `start_run` accept the brief as text (≤ 20,000 characters), stored as an immutable document of kind `brief` named `brief-<run_id>.md` on the item, or as a `document_version_id`. It's linked from the run. A restart re-sends it unchanged.
- **Parking.**
  - `park_run` sets `state = parked` with a reason and `waiting_on`. While parked the run never goes stale, its lease is suspended, its workspace counts as `in_use`, and it keeps its claim.
  - Any later call with the `run_id` resumes it (events `run.parked` and `run.resumed`).
  - `resume_ready` is true when every `waiting_on.items` entry is done or cleared, or `until` has passed.
  - **Problems:**
    - "Parked for 24h" after `PARK_MAX`;
    - "Ready to resume, unattended" after `RESUME_UNATTENDED` with `resume_ready` true.

    Neither releases the claim; the owner can *Release lead claim* as usual.
- **Resources.**
  - Declared and released through `heartbeat` (`resource.declared` and `resource.released` events).
  - `finish_run` warns about unreleased resources and unpushed commits.
  - When a run ends for any reason, its unreleased resources stay listed. After `ORPHAN_AFTER` they show as "Orphaned resources" under Problems until a later run of the item, or the owner, marks them released.
- **End reasons.**
  - Every run that ends records an `end_reason`: `finished` and `failed` (`finish_run`), `released` (`release_lead`), `lease_expired` (sweeper), `owner_released` (*Release lead claim*), `service_restart` (boot sweep) or `canceled` (owner cancel).
  - **"Unpushed work may be lost"** shows under Problems when any run ends (including `finished` and `failed`) while `dirty` is true or `head_sha` ≠ `pushed_sha` (B10 resolution, matching MCP_SPEC §10 test 20). It clears when a later run reports a pushed commit, or the owner marks it *Handled*.
- **`recovery_report`** (MCP_SPEC §5.9) is read-only and assembles the restart list. The coordinator's recovery procedure is in the [`tasklite-coordinator` skill](../skills/tasklite-coordinator/SKILL.md).
- **Limits.** Task Lite never checks folders, stops processes or prevents pruning: it has no host access, by design (the one exception is the opt-in agent-files push folder, §5.17). The coordinator does those things using this record.

### 5.17 Agent setup: agent files, workflow notes, install (decision 29)
- **Files.** The agent files are each `skills/<name>/SKILL.md` and the AGENTS.md block (`docs/templates/AGENTS-tasklite.md`). At startup the server loads the copies in the image into the **bundled** layer. When the bundled content changes on upgrade, a new bundled version is added; owner edits are never overwritten.
- **Layers and resolution.** For a project, the effective version of each file is its project override, else the service-wide edit, else bundled. Each edit is a new immutable version with author and note. *Revert* creates a version equal to the layer below (or removes the override). If a file was edited while the bundled version was X and the bundled version is now Y, it's flagged "bundled version updated", with a three-way view (bundled X → bundled Y, and the owner's edit). B23: *Revert* removes the edit or override from use (its versions stay as history), so the layer below applies again and later upgrades reach it. Only the shipped files can be edited. Diffs are line diffs computed in the browser from the versions the GET routes return. Editing again, even with the same text, re-bases the edit on the current bundled version and clears the flag.
- **How the UI presents the layers (B25).** The storage model above is unchanged; the Agent files screen (UI_SPEC §6.7b) shows two ideas instead of three layers. The **default** is what every project uses: the service-wide edit if there is one, else bundled ("Task Lite's version"); *Reset to Task Lite's version* is the revert of the service layer. **<Project>'s copy** is the project override, shown only for a project that has one; *Customize for <project>* creates it from the current default (a PUT of the project layer with `expected_version` 0), and *Use default* is the revert of the project layer. A copy is flagged "the default changed" when the server's bundled-updated flag is on its project layer, or when the service edit's current version is newer than the copy's (computed in the browser from the versions the GETs return). "Customized in" (All projects) comes from listing each project's files; no route was added. The screen follows the project switcher and never says bundled, layer, override or service-wide.
- **Workflow notes** are per project, versioned, ≤ 10,000 characters, and included in `get_context` (§5.15). B25: the old block's project questions moved into a Workflow notes starter (`docs/templates/WORKFLOW-starter.md`, bundled into the web build), each with a suggested answer, which *Start from template* loads into the editor unsaved. The shipped AGENTS.md block is generic and has no `{{…}}` placeholders; `{{KEY}}` is still filled for a project's repo install if an owner's edit uses it.
- **Install bundle.** A tar.gz of the effective files laid out for the client and target:
  - Claude Code: `.claude/skills/<name>/SKILL.md` in a repo, or `~/.claude/skills/<name>/SKILL.md` user-wide;
  - Codex: `.codex/skills/` and `~/.codex/skills/`, per verification V7;
  - the AGENTS.md block is inserted between `<!-- tasklite:begin -->` and `<!-- tasklite:end -->` in `AGENTS.md` (Codex) or `CLAUDE.md` (Claude Code), appended with markers if absent, and nothing outside the markers changes;
  - a `.tasklite-manifest.json` lists each file's key, version ID and sha256, plus the install ID.
- **Command install.** `POST /api/installs` returns a single-use download token, valid 10 minutes and loopback only, and PowerShell and bash one-liners that download `GET /install/:token` and unpack it into the target. The install is logged when the token is used.
- **Push install** (opt-in; FR-125): only when `TASKLITE_PUSH_ROOT` is set and writable.
  - The target path must be inside the push root.
  - The server writes only the skill folders, the manifest and the marked AGENTS.md section, and never deletes or overwrites other files.
  - Settings shows a *Test* that writes and removes a probe file.
- **Check.**
  - **With push:** `POST /api/installs/:id/check` reads the installed files and diffs them against the manifest's versions (changed, missing, extra skill folders).
  - **Without push:** the install response also carries a check one-liner that hashes the local files against the manifest and prints the differences.
- **Never** run anything on the host, follow symlinks out of the push root, or read outside it.
- **B24 resolutions** (install and check; agreed with the coordinator):
  - **Layout** (`installLayout` in `shared/src/install.ts`), relative to the base (the repo, or home for user-wide): `.claude/skills/<name>/SKILL.md` or `.codex/skills/<name>/SKILL.md`; the block in `CLAUDE.md`/`AGENTS.md` (repo) or `.claude/CLAUDE.md`/`.codex/AGENTS.md` (user-wide); the manifest at `.claude/.tasklite-manifest.json` or `.codex/.tasklite-manifest.json`. A user-wide install from the UI sends the service-wide set (no project).
  - **The block as installed:** the template's leading HTML comment is stripped, and `{{KEY}}` is filled with the project key for a project's repo install only. The Install dialog warns when `{{…}}` placeholders remain (*Edit block*, *Install anyway*).
  - **The marked section:** replaced between the markers, or appended after a blank line (the old text stays an exact prefix), or a new file. A missing or repeated marker refuses the install, and nothing is written.
  - **The manifest's `sha256`** is the installed content's with CR bytes removed: a skill's equals its version's sha256; the block's is the rendered block's. The check hashes the same way (the block is the text between the markers, less one newline at each end), so Git's line endings on Windows aren't edits.
  - **Command install:** `record` appends `install.recorded` with `data.stage: "command_issued"` ("Install command created: …"); the download appends a second with stage `downloaded` ("Installed by command: …", actor system). Push appends one with stage `pushed`. The log lists push installs and downloaded command installs. The token is kept out of the write path's arguments, rows, events and logs (tested by grep).
  - **The one-liners** download into a temporary folder, unpack with `tar` (Windows' own `tar.exe` from PowerShell), and run the bundle's dependency-free install step (`install.sh` / `install.ps1`, ASCII). A repo install refuses a folder without `.git` before it uses the token. PowerShell runs the step as a script block, so it works under the Restricted execution policy. Tested for real with bash, PowerShell 7 and Windows PowerShell 5.1.
  - **Push paths:** a host path under `TASKLITE_PUSH_HOST_PATH` (any case and slashes for a Windows path), a container path under the root, or a path relative to the root. The base folder must already exist. Each escape is blocked in `server/src/domain/push-root.ts`.
  - **Check:** *extra* means a `tasklite-*` skill folder that isn't in the manifest; other skill folders are the owner's own. A symlinked installed file reads as *edited* (never followed). **Contract change (B24):** each edited file of a push check carries `local_content` (≤ 50,000 characters; for the block, the text between the markers), so the UI diffs it against the version sent. The command check prints each file's state with the version ID sent.

### 5.18 Help center (decision 29)
Articles are Markdown files in `docs/help/<slug>.md`, with front matter `title`, `summary` and `anchors` (the screens and states that link to them). They're bundled into the web build: no API, no database. The UI lists them at `/help`, renders them at `/help/:slug`, includes them in palette results, and shows a "?" link wherever an anchor applies. Content changes ship as normal PRs.

---

### 5.19 Agent proposals and drift (decision 30)
- **Reading.** `get_agent_files {project}` returns the files and Workflow notes in effect for that project (content, version ID, sha256, and where each comes from), so an agent edits the current text.
- **Proposing.** `propose_agent_file_change {project?, file, content, reason, based_on_version_id}` stores a **pending proposal**. `file` is a skill key, `agents_block` or `workflow`. With `project`, it targets that project's copy; without it, the default. It changes nothing. The write checks (secrets, item references) apply. At most 5 pending proposals per file and project; a newer proposal from the same run replaces its own older one.
- **Deciding.** The owner approves (saved as a new version of the target, author "proposed by <client · label> · approved by owner"), edits then approves, or declines with an optional note. If the target changed since `based_on_version_id`, the review shows a three-way view. Every decision is an event, and approval is undoable like any owner edit.
- **Agents can't write agent files directly** (FR-130). The owner routes stay owner-only.
- **Instruction reports.**
  - **From agents:** `claim_lead` accepts `instructions?: { install_id?, files: [{ key, sha256, content? }] }`. The installed `tasklite-check` script produces it, and includes `content` (≤ 50,000 characters) only for files whose hash differs from the manifest. The report is stored on the run.
  - **From the push folder:** a scheduled check (`TASKLITE_DRIFT_CHECK_INTERVAL`, default 15 min, and at startup) runs the B24 check on every push install's location.
- **Drift.** A report that differs from the install's manifest raises a drift record per location: changed, missing and extra files. The owner sees a Problems row, "Agent files changed outside Task Lite · <project> · <file>", with the diff when content is available, and three remedies:
  - *Adopt*: save the local content as the project's copy, as an owner edit;
  - *Restore*: reinstall Task Lite's version (push, or show the command);
  - *Keep local*: accept it; no new alert until the content hash changes again.
- **Runs** show "Instructions: tasklite-worker · Recipe App's copy v2", with ⚠ "edited locally" when the reported hash differs from what was sent.

## 6. MCP tool contract

**Overview only.** [MCP_SPEC.md](MCP_SPEC.md) is authoritative for the server instructions, every tool's description text, input and output schemas, error messages and worked flows. It defines 40 tools (38, plus `get_agent_files` and `propose_agent_file_change` from decision 30), including `unlink_items`, `update_check` and `update_human_review`, which are paired with their siblings below.

Tools are snake_case, with input and output schemas defined in `shared/` with zod, and every result returns `structuredContent`. Lists are paginated with `cursor` and `limit` (default 25, max 50) (A02).

- **Mutating tools:**
  - take an optional `expected_version`; a mismatch returns `conflict` with the current record (A07);
  - take an optional `idempotency_key`; a replay with the same key and arguments returns the original result, while a replay with different arguments returns `validation`.
- **Every call carrying `run_id` is a signal** (§5.4).
- **Lean responses** (MCP_SPEC §3): `get_item` takes `view: summary|standard|full`, and read tools take `fields` to return only what's asked. The text block of every result is a complete compact rendering of the result (MCP_SPEC §3.1), not JSON, while `structuredContent` carries the JSON. Contract tests enforce token budgets.
- **Errors** return `isError: true` and `structuredContent: {code, message, details?, current?}`, where `code` is one of `validation`, `conflict`, `not_found`, `forbidden`, `unavailable`, `internal` (A10). The message is one sentence that says what to do next.

| Tool | Purpose | Key inputs → output | Req |
|---|---|---|---|
| `whoami` | Connection check | → `{client, session_id, server_version, limits, time}` | A01, A10 |
| `list_projects` | | → `[{key, name, counts}]` | A02 |
| `search_items` | Bounded search | `project?, text?, status?[], type?[], label?, epic?, filter?: ready_to_start\|resumable\|blocked\|waiting_for_review\|mine\|deferred_review, include_archived?=true, cursor?, limit?` → items with `id, title, type, status, priority, blocked_by[], lead, run_state, version` | A02, A05 |
| `get_item` | Full item | `id, view?, fields?` → fields, acceptance, labels, links (blocks/blocked_by/relates, each with status), checklist (work with plan version, agent checks, human review with states), lead and recent runs, open question and answer, `unread_owner_notes` (marked read), documents (latest versions), packets (summary), commits, artifacts, 20 most recent events | A02, H13 |
| `create_item` | | `project, type, title, description?, outcome?, acceptance?[], priority?=2, epic?, labels?[], status?: inbox\|planning (default inbox), planned_start?, planned_end?, effort?` → item | A03 |
| `update_item` | Edit fields | `id, expected_version, title?, description?, outcome?, acceptance?[], priority?, epic?, labels?[], planned_start?, planned_end?, effort?` → item. Dates record `dates_set_by` = the caller. | A03, A18 |
| `set_status` | Transition | `id, status, reason?` → item, or `validation` listing the allowed transitions | §5.1 |
| `link_items` / `unlink_items` | | `from, to, type: blocks\|relates, satisfied_when?: done\|merged\|verified` → link (calling it again on an existing link updates `satisfied_when`); a cycle returns `validation` with the path | A04, §5.2 |
| `upsert_label` | Agents may create labels | `project, name, brief?` → label | decision 13 |
| `claim_lead` / `release_lead` | | `id, agent_label?, workspace?, orchestrator?, brief? \| brief_document_version_id?, external?` → `{run_id, lease_expires_at}`, or `conflict` with the claimant / `id, run_id, reason?` | A15 |
| `start_run` | Child run under a lead | `id, parent_run_id, agent_label?` → `{run_id}` | A06 |
| `heartbeat` | Explicit signal, run updates | `run_id, current_step_id?, note?, workspace?, resources_started?, resources_released?, external?` → `{run_state, lease_expires_at, resources}` | A06, §5.16 |
| `park_run` | Wait without losing the claim | `run_id, reason, waiting_on?` → `{run_state, resume_ready}` | §5.16 |
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
| `recovery_report` | Restart list after a crash | `project?, since?, include_briefs?` → interrupted, stale and parked runs, workspaces, orphaned resources | decision 26 |
| `get_context` | Working context in one call | `id, budget?: small\|medium\|large` → bundle (§5.15), including the project's Workflow notes (decision 29) | decisions 19, 29 |
| `publish_decision` | Record a decision | `project, scope: {kind, id?}, title, decision, rationale?, supersedes?` → record (`authority=agent`) | decision 19 |
| `list_decisions` | Read decisions | `project, scope?, include_inactive?=false` → records | decision 19 |
| `withdraw_decision` | Withdraw an agent decision | `decision_id, reason` → record | decision 19 |

**Tool descriptions** (the text agents read) must state the workflow in one or two sentences each:
- claim from Ready;
- publish the plan as checklist Work steps, not as new tickets;
- declare human review during Planning when the owner must verify something;
- report commits for the ticket they belong to;
- submit a packet when the work is built and the agent's own checks pass;
- start each item with `get_context`, and respect owner decisions.

These descriptions are the agents' only manual, so write and review them as product copy.

---

## 7. UI JSON API

Every route requires the owner session (§3). JSON bodies **and query strings** are validated with the shared zod schemas, strictly: unknown keys get `validation` with the same did-you-mean message as MCP. **Request and response shapes are authoritative in `shared/src/api`**, which B4 derived from this table and UI_SPEC. Errors use one envelope, `{error: {code, message, details?}}`, with the MCP error codes; unimplemented routes answer `501` with code `unavailable`. Responses carry the version numbers the client needs for its next write. List endpoints accept `scope` (`all` or a project key).

**Receipt writes:** heartbeats, run signals and delivery receipts ("notes delivered") change run or delivery state **without** appending events, through a separate receipt path (B4). Every other mutation goes through the event-appending write path.

| Method & path | Used by |
|---|---|
| `POST /api/session/unlock` `{key}` · `POST /api/session/lock` · `POST /api/session/rotate-key` | Unlock screen, Settings. Rotate-key writes a new owner key (0600), ends every owner session including the caller's, clears the cookies, and returns `{rotated: true}`. It never returns the key; the owner reads it with `tasklite owner-key` (decided in B2). |
| `GET /api/bootstrap` | Shell: projects, labels, sidebar counts, settings, health |
| `GET /api/needs-you?scope` | Needs you: `for_you_now[]` (packets, questions), `problems[]`, `deferred[]`, `planning_queue[]`, `agent_counts{}` |
| `GET /api/work?scope&epic&label&filter&layout` | Work board/list/map; Timeline adds dates and forecast. Each item carries `lead_parked: {waiting_on, since, resume_ready} \| null` (optional; B20), so a parked card's run line says what it waits on |
| `GET /api/burndown?scope&epic&label` | Timeline burn-down card |
| `GET /api/items/:id` | Ticket or epic page (all four tabs; small enough to load at once). An epic's `children[]` carry `lead_parked` (optional; B20) for the Tickets list's run line |
| `POST /api/items` | Quick capture: `{title, type, project, epic?, notes?}` → item in Inbox |
| `PATCH /api/items/:id` | `{expected_version, priority?, status?: planning\|ready, title?, description_md?, outcome_md?, acceptance?: string[]}`. Text edits use the same limits, secret checks and conflict handling as agents, are undoable, and are recorded with `actor_kind=owner` (decision 22). |
| `GET /api/diagnostics/calls?days=7` | Settings → *Download diagnostic log*: JSONL of agent calls (time, tool, client, label, run, duration, result code), never arguments or results (FR-108) |
| `POST /api/items/:id/archive` · `/unarchive` · `POST /api/archive` `{ids[]}` | Archive, Archive all |
| `POST /api/items/:id/cancel` `{expected_version, reason?}` | *Cancel item…* (owner decision 23); returns a `mutation_id` for Undo |
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
| `GET /api/agents?scope` | Agents → Active now and Recent. Each row carries `lead_parked` (optional; B20): what a parked run waits on. UI API only; agents read `Run.parked` through `get_item` |
| `GET /api/settings` · `GET /api/settings/agent-token` → `{token}` · `PATCH /api/projects/:key` `{default_satisfied_when}` · `DELETE /api/projects/:key` `{confirm_key}` | Settings. The agent-token route backs *Reveal token*: owner session only, `Cache-Control: no-store`, and the value is never written to any log. |
| `GET /api/decisions?project&scope_kind&scope_id&include_inactive` · `POST /api/decisions` · `POST /api/decisions/:id/confirm` · `POST /api/decisions/:id/withdraw` `{reason}` | Decisions sections (ticket, epic, label, Settings → project) |
| `GET /api/search?q` | Command palette (items, labels, views). Items include archived ones, each with `archived: boolean` for the palette's *Archived* tag (UI_SPEC §4). |
| `GET /api/documents/:versionId/content` | Document viewer, attachments |
| `POST /api/import/jira/dry-run` · `GET /api/import/jira/:id` · `POST /api/import/jira/:id/commit` · `DELETE /api/import/jira/:id` | Jira import (§9) |
| `POST /api/mutations/:id/undo` | Undo toast |
| `GET /api/workspaces?scope&state` | Agents → Workspaces (decision 26): every recorded worktree with its state, branch, item, last activity and unreleased resources |
| `GET /api/agent-files?project` · `GET /api/agent-files/:key?project` · `PUT /api/agent-files/:key` `{layer, project?, content, expected_version, note?}` · `POST /api/agent-files/:key/revert` `{layer, project?}` | Agent files (§5.17; UI_SPEC §6.7b): the effective set, each layer, history and diffs, the bundled-updated flag |
| `GET /api/projects/:key/workflow` · `PUT /api/projects/:key/workflow` `{content_md, expected_version, note?}` | The project's Workflow notes. Each version carries its `wf_…` `id` (optional; B27a), the ID `get_agent_files` and proposals name, so the proposal review finds its base |
| `POST /api/installs` `{client, target_kind, project?, path?, method}` → `{install_id, command?, check_command?, result?}` · `GET /api/installs?project` · `POST /api/installs/:id/check` · `GET /api/push-target` · `POST /api/push-target/test` | Install, the install log, local-edit checks, the push folder status |
| `GET /install/:token` (no session; single-use, 10 min, loopback) | The install bundle the copy-paste command downloads. No session, CSRF or bearer: the token (32 random bytes, base64url) is the credential, behind the Host and Origin guards; unknown, expired and used tokens all answer `404` (B21) |
| `GET /api/agent-file-proposals?project&state` · `POST /api/agent-file-proposals/:id/approve` `{content?, note?}` · `POST /api/agent-file-proposals/:id/decline` `{note?}` | Proposals on Agent files and in Needs you (decision 30) |
| `GET /api/drift?project&state` · `POST /api/drift/:id/adopt` · `POST /api/drift/:id/restore` · `POST /api/drift/:id/keep-local` | Drift review and remedies (decision 30). Shapes in `shared/src/api/agent-proposals.ts` (B26). *Approve* and *Adopt* are undoable; *Decline*, *Restore* and *Keep local* are not. Needs you gains `agent_file_proposals` (a count), Problems a kind `agent_files_drift` (with `drift_id`), and the ticket `run_instructions`, all optional. |
| `POST /api/resources/:id/release` `{note?}` · `POST /api/runs/:runId/unpushed-handled` | Problems actions: *Mark released* on an orphaned resource; *Handled* on "Unpushed work may be lost" |
| `GET /api/stream` | SSE: `event: change`, `id: <seq>`, `data: {seq, type, objects:[{kind, id}], for_you}`, where `for_you` is true only for `packet.submitted` and `question.asked` (used for desktop notifications; specs/001-task-lite-v1/contracts/events.md). The client invalidates matching TanStack Query keys. Supports `Last-Event-ID`. Sends a heartbeat comment every 25 s. |
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
- **`packets{}`** → `packets` and `review_decisions`: `rounds[].decided.verdicts[]` uses `k` for kind.
- **`changes[]`:** historical events. "Since you looked" was removed from the UI, so use them only as Activity rows.
- **Decision records:** not in `sample-data.json`. The loader adds these three, so the decision UI, `get_context` examples and token budgets have data:
  - `dec_1`: epic RCP-1, owner, "Units are metric internally; convert on display";
  - `dec_2`: project DOC, agent (codex), "API reference pages show one request and one response example per endpoint";
  - `dec_3`: label `ui-refresh`, agent (claude), "Use design tokens v2 spacing (8 px grid)", active.
- **Blocker rules:** every project defaults to `done`. Set the `RCP-19 → RCP-16` link to `merged`, so the stricter-dependency examples have data.

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
- Jira mapping of every row in §9;
- `satisfied_when` (done, merged and verified; project default vs link override; verified with deferred items; re-evaluation on change);
- decision records (scope inheritance, authority rules, supersede and withdraw);
- context bundle ordering and budgets;
- recovery (§5.16): parking (no stale; lease suspended; resume_ready; PARK_MAX), derived workspace states, end reasons for every path, orphan and unpushed Problems, and `recovery_report` after a simulated restart.

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
- **Decisions:**
  - a ticket's Details lists the decisions in scope;
  - an agent record can be confirmed and becomes "Owner";
  - withdrawing hides it from Details but keeps it in Activity;
  - recording a decision on an epic shows it on its child tickets.
- **Stricter dependencies:**
  - setting a project to "PR merged" turns a done-but-unmerged blocker back into a blocking one, with the chip "Blocked by RCP-12 (needs merge)";
  - reporting the merge clears it.
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
  - every visit starts at All projects (a new browser context sees scope All);
  - **notifications** (with the permission granted in the browser context): a new packet and a new question each produce exactly one notification, a click opens the right place, the tab title shows `(N) Task Lite`, and already-pending items don't notify on load;
  - **inline editing:** edit and save an outcome, see it in `get_context`, and undo it; a conflicting agent edit shows the conflict callout.

### Smoke test with real clients (O07)
`docker/smoke/` holds a script and a checklist. For each surface (installed Codex, installed Claude Code, an Orca worker running Codex, and an Orca worker running Claude):
1. Configure the client with the snippet from Settings.
2. Run `whoami`.
3. Claim a disposable sample ticket, publish a plan, log a step and read it back.
4. Confirm that the UI shows the client name correctly and the run as live.

Record the results in the Settings compatibility matrix. A surface that can't connect gets "Not verified" and a note. Do not build a bridge unless a required surface fails.

---

## 11. Milestones for the integration agent

The milestones below group *capabilities*. The **execution order** is the batch plan under "How to run the build" in [specs/001-task-lite-v1/tasks.md](../specs/001-task-lite-v1/tasks.md). It runs **contracts first** (constitution v1.1): setup, platform, then the whole MCP, API and UI contract surface as stubs and shells, then one user-story slice per batch. Each batch is one agent session, one branch and one PR, merged through the Mergify queue after the owner's review.

| # | Deliverable | Done when |
|---|---|---|
| M0 | Workspace scaffold, lint, typecheck, Vitest, Dockerfile, compose, `/healthz` and `/readyz`, and the GitHub Actions CI workflow (§2 Stack) | `docker compose up` serves "Task Lite is running"; the CI check is green on the M0 PR, and Mergify waits for it |
| M1 | Schema and migrations, domain services for §5 (including `satisfied_when`, decision records and the context bundle), event log, idempotency, undo, seed loader | Unit tests for every §5 rule pass; the seed loads deterministically |
| M2 | MCP server per [MCP_SPEC.md](MCP_SPEC.md): auth, Host/Origin guards, identity, server instructions, all 40 tools with the exact description text, compact text rendering, structured errors, sweeper, restart handling | The MCP_SPEC §10 contract tests pass, including the description snapshot and token budgets; two simultaneous SDK clients work |
| M3 | Owner session and CSRF, UI API (§7, including owner text edits and the diagnostic log), SSE stream | API contract tests pass; the unlock flow works |
| M4 | Web shell, tokens, Needs you, Work board and list, ticket and epic pages (four tabs, checklist editing, Decisions sections), open-item tabs, palette, quick capture | The e2e groups for Needs you, Tickets and epics, and Shell pass |
| M5 | Packet screen and decisions, deferrals, questions and notes, archive, undo toasts, inline editing, desktop notifications and the tab-title count | The e2e groups for Packets and Work (archive) pass |
| M6 | Progress map (epic, label, Work → Map), Timeline, Label pages (with Decisions), Agents, Settings (including blocker rules and project decisions), document viewer | The e2e groups for Map, Labels and cross-cutting pass |
| M7 | Burn-down and forecast, Jira import (dry run and import), backup/restore CLI, delete project. Stretch: `tasklite export` | Unit tests for forecast and mapping pass; a dry run against a test Jira project produces a report |
| M8 | O07 smoke with real clients, an accessibility pass, dark mode and 1024 px checks, a README quick start | The smoke matrix is filled in; axe is clean; the README walks through from an empty machine to a connected agent in under 10 minutes |

---

## 12. Things to verify during the build

These can't be settled on paper. Each one has a default already, so none of them blocks starting.

| # | Question | Default until verified | Where |
|---|---|---|---|
| V1 | Do Codex and Claude Code keep their MCP session open, and do they answer server `ping`? This decides whether *live* is reachable or every run shows as *reported*. | The §5.4 rules. If pings aren't answered, *live* relies on requests alone, and the UI is still truthful. | M2, M8 |
| V2 | Does an Orca worker running Claude inherit the user's MCP configuration? (The Codex one was verified in discovery.) | Show "Not verified" in Settings until the smoke test passes. | M8 |
| V3 | Client config. Checked against the docs on 2026-11-07 (MCP_SPEC §11): Codex `bearer_token_env_var` and the Claude `mcp add --transport http --header` form are confirmed. Still open: whether Claude expands `${TASKLITE_TOKEN}` in user-scope config (it does in a project's `.mcp.json`). | Use the user-scope `mcp add` form, which stores the expanded token. | M8 |
| V4 | Field IDs for start date and story points on the owner's Jira site. | Detect them by field name, and let the dry-run report show which field was used. | M7 |
| V6 | Which part of a tool result each client gives the model: the text block, `structuredContent`, or both. This decides where the token savings land. | The text block is a complete compact rendering, so a text-only client loses nothing. If a client forwards both, measure, and consider an option to send a short text block. | M2, M8 |
| V5 | SQLite WAL performance on a Docker Desktop named volume on Windows. | Named volume (not a bind mount). If writes are slow, measure before changing anything. | M1 |
| V7 | Where each client loads skills from (Claude Code `~/.claude/skills/`; Codex `~/.codex/skills/` and its project path), and whether an Orca worker sees user-wide skills. | Document the paths that work in `skills/README.md`; fall back to pasting the skill into the worker's brief. | M8 |

### Results (B18, 2026-11-17)

What ran unattended on the build machine (Windows 11, Docker Desktop 29.9, installed Claude Code 2.1.318), and what is still the owner's. Each owner step is in `docker/smoke/OWNER-CHECKLIST.md`. Nothing below was run with the owner's own client configuration or data.

| # | Status | What was observed |
|---|---|---|
| V1 | **Partly; owner to verify** | Headless Claude Code (`claude -p`) showed *live* while it ran, from request activity. Its session ends with the process, so headless can't say whether an interactive session stays open and answers `ping`. Owner: interactive Claude Code and Codex, idle past the 2-minute live window. |
| V2 | **Owner to verify** | Needs an Orca worker running Claude from the owner's account. |
| V3 | **Partly; owner to verify** | `"Authorization": "Bearer ${TASKLITE_TOKEN}"` in an `--mcp-config` file (the `.mcp.json` format) is expanded from the environment. Still open: what user scope (`claude mcp add --scope user`) stores. |
| V4 | **Fixture only** | Field-ID detection (start date, story points) is verified against the synthetic Jira fixture (`docker/compose.jira-fixture.yaml`, B17), not a real Jira site. The dry-run report shows which field was used. Owner: a dry run on their own site before the pilot (ROADMAP §1.4). |
| V5 | **Verified** | SQLite WAL on a Docker Desktop named volume on Windows: in the container's call log, every write tool had p50 ≈ 1 ms and p95 ≤ 5 ms over 280 writes. At scale (20 projects, 5,000 items, 100,000 events) every owner view rendered in under 1 s against the container (T143). The named volume stays. |
| V6 | **Resolved by owner decision 28 (B19): text-only results for Claude Code** | B18 found, from the stream-json transcripts of headless Claude Code 2.1.318, that the model's tool result is the `structuredContent` JSON, not the text block: on typical reads about 3.5× the compact text's tokens (6,494 against 1,836 over eight calls; a 25-item search 2,045 against 325). So clients that do this now get text-only results: no `outputSchema`, no `structuredContent` (MCP_SPEC §3 Results). Claude Code sends `clientInfo.name` `claude-code`, the default of `TASKLITE_TEXT_ONLY_CLIENTS` (§2). Measured in B19 with headless Claude Code 2.1.318 (sonnet) on a throwaway instance, through the SC-001 opening (`search_items`, `claim_lead`, `get_context` on RCP-17): from Claude Code's usage, the three results added 1,246 tokens to the model's context before and 659 after, per-call framing included; the results themselves fell from 2,219 characters of JSON (≈ 555 tokens) to 944 of compact text (≈ 236), the text-block budget. Codex: still to verify which part it forwards; it stays structured until then. |
| V7 | **Partly; owner to verify** | Claude Code loads skills from a project's `.claude/skills/` (the B18 eval: `tasklite-worker` and `tasklite-coordinator` invoked headless). Still open: `~/.claude/skills/`, Codex's paths, and whether Orca workers see user-wide skills. |

**Settings compatibility matrix:** every surface stays *Not verified* (`server/src/domain/compat.ts`). Claude Code's note says the headless smoke passed and that the user-scope setup is still to verify. Since B19 it also shows each surface's result mode (MCP_SPEC §3 Results): text-only for Claude Code, structured for Codex.

---

## 13. Definitions the UI and MCP share

These must be byte-for-byte the same on both sides, so put them in `shared/`:
- status names and order;
- run-state names and one-line meanings;
- provenance kinds and labels;
- item types;
- filters and their agent-query strings: `status:planning`, `status:ready -is:blocked`, `is:blocked`, `needs:human`, `has:human-review`, `review:deferred`, `run:live`, `is:archived`, and the agent-only `status:progress -has:lead` (`resumable`). Each saved filter's tooltip shows its query, and `search_items` accepts the same filters;
- the MCP description strings and result-summary templates (`shared/mcp-copy.ts`, MCP_SPEC §9);
- end reasons, workspace states and resource kinds (§5.16), with their UI labels;
- the compact text renderers (MCP_SPEC §3.1). The UI uses none of them, but they live in `shared/` so tests can render seed data;
- `satisfied_when` labels (Done / PR merged / Verified by you) and decision authority labels (Owner / Agent).

---

## 14. Decisions log

Owner decisions are marked **(owner)**. Every other entry is a technical choice made in this spec. Change one by editing this table and the section it points to.

| # | Decision | Section |
|---|---|---|
| 14 **(owner)** | Stack: TypeScript end to end. Node 22, the official MCP SDK, Hono, SQLite with Drizzle, React with Vite. | §2 |
| 15 **(owner)** | Requirement O11 (project-level approval policies) is **superseded** by decision 13. Gates are per-ticket human review items declared according to the project's workflow, and the tracker enforces only "can't close while a review item is undecided". H06's "project with a required owner gate" becomes "ticket with human review items". | §5.1, §5.6 |
| 16 **(owner)** | One agent bearer token. Identity comes from the MCP `clientInfo`, plus an optional `agent_label`. | §3 |
| 17 **(owner)** | V1 also includes the Timeline layout, Label pages, burn-down and forecast, and the Jira import (dry run and import). | §1, §5.9, §9 |
| 18 **(owner)** | Task Lite coordinates; it doesn't dispatch. Orca, or the owner, starts agents (decision 2 reaffirmed after the 2026-11-14 "control plane" review). Revisit after the pilot (ROADMAP.md). | §1 |
| 19 **(owner)** | V1 adds four coordination features: the context bundle, decision records, lean responses, and stricter dependency rules. | §1, §5.2, §5.14, §5.15, MCP_SPEC §3 |
| 20 **(owner)** | TERSL / Tourbillon is a reference to learn from, not a dependency: no TERSL format or TERSL/DB in V1. The learnings applied are in ROADMAP.md. | ROADMAP.md |
| T16 | Blocker satisfaction is `done`, `merged` (agent-reported) or `verified` (all human review approved), as a project default with a per-link override. | §5.2 |
| T17 | Decision records: owner records are authoritative and can't be changed by agents; agents can supersede or withdraw only agent records; nothing goes to Needs you. | §5.14 |
| T18 | Tool results: the text block is a complete compact rendering, and `structuredContent` is JSON. | MCP_SPEC §3.1 |
| T19 | Context bundle budgets of 1k, 3k and 8k tokens, with visible truncation. | §5.15 |
| T20 | CI runs on GitHub Actions hosted runners. The repo went public on 2026-11-14, so standard runners are free, and no Namespace runners are needed. | §2 |
| 21 **(owner)** | Opt-in desktop notifications for new for-you events only (packet ready, question asked), plus the for-you count in the tab title. Browser-generated, nothing off-machine. | UI_SPEC §6.7a |
| 22 **(owner)** | The owner edits an item's title, description, outcome and acceptance criteria inline. Dates, effort and blocker links stay agent-edited in V1. | §7, UI_SPEC §6.3 |
| T21 | Diagnostic call log: JSONL, one line per MCP call without arguments, rotated daily, kept 7 days, downloadable from Settings. | §2 volume layout, §7 |
| 26 **(owner)** | Recovery support: runs record their workspace, orchestrator IDs, brief and declared resources; runs can park; `recovery_report` gives the restart list; Problems flag orphaned resources and unpushed work. Prompted by an Orca crash that pruned worktrees holding in-flight work. Task Lite records; the coordinator acts. | §5.16, MCP_SPEC §3 and §5.9 |
| 27 **(owner)** | Ship five agent skills as plain files in `skills/`: `tasklite-worker` and `tasklite-coordinator` (core), `tasklite-planner`, `tasklite-review-packet` and `tasklite-lead-subagents` (optional). They teach workflow, never restate schemas, and are lint-checked against the tool contract in CI. Owners may edit them. Serving them as MCP prompts is on the roadmap. | `skills/README.md`, ROADMAP §2 |
| 28 **(owner)** | Per-client result modes: clients known to give the model `structuredContent` (by default Claude Code, `clientInfo.name` `claude-code`) get text-only results, with no `outputSchema` and no `structuredContent`, so the model reads the complete compact text; every other client keeps structured output. Configured by `TASKLITE_TEXT_ONLY_CLIENTS`. Resolves V6. | §2 Configuration, §12 V6, MCP_SPEC §3 Results and §11 |
| 29 **(owner)** | Help center and agent setup: Help articles in the app; the agent files (skills and AGENTS.md block) viewable and editable in three layers (bundled, service-wide, per project) with history; per-project Workflow notes in `get_context`; install by copy-paste command or opt-in push into a mounted host folder; every install logged with exact versions, and installed copies checked for local edits. Serving the files over MCP stays on the roadmap. | §5.17, §5.18, §7, UI_SPEC §6.10–6.11 |
| 30 **(owner)** | Agents change agent files only by proposing (`get_agent_files`, `propose_agent_file_change`); the owner approves, edits or declines, with proposer and approver recorded. Drift detection for edits made outside Task Lite: scheduled checks of push installs, and instruction hashes agents report on `claim_lead`; drift shows as a Problem with *Adopt*, *Restore* and *Keep local*; runs record their instruction versions. | §5.19, MCP_SPEC §5.10, UI_SPEC §6.7b |
| T22 | Parked runs keep their claim indefinitely and are only flagged after `PARK_MAX` (24 h); they are never auto-released. | §5.16 |
| T23 | Workspace state is derived per worktree path from reported data (`dirty`, `head_sha`, `pushed_sha`, resources), never by inspecting the host. | §5.16 |
| T24 | API errors use the envelope `{error:{code,message,details?}}`; queries are strict; `shared/src/api` holds the authoritative request and response shapes (from B4). | §7 |
| T25 | Event-less receipt writes for heartbeats, signals and delivery receipts (from B4). | §7 |
| T1 | One port (7420) for MCP, API and UI, published only on 127.0.0.1, with Host and Origin allowlists. | §2, §3 |
| 23 **(owner)** | The owner can cancel any open item from the UI, with an optional reason and Undo. | §5.1, UI_SPEC §6.3 |
| 24 **(owner)** | Backups stay in the data volume by default; the owner can opt in to an extra copy in a host folder. | §5.13, §2 Configuration |
| T2 | A separate owner key and browser session, so agents can't record human approval through the API. Confirmed by the owner in the 2026-11-14 clarification (30 days from last use). | §3 |
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
