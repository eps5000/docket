# Docket (formerly Task Lite): V1 build spec

Status: ready to build, 2026-11-07. This is the implementation contract for MVP V1. It is written for an integration agent working without the design conversation.

**Read in this order:**
1. This file: architecture, data model, rules, MCP tools, UI API, milestones and decisions.
2. [MCP_SPEC.md](MCP_SPEC.md): the full agent-facing contract. It holds the server instructions, every tool's final description text and schemas, errors, worked flows, contract tests and client setup. Agents are the primary users, so this is as important as the UI.
3. [UI_SPEC.md](UI_SPEC.md): screens, components, tokens, states and accessibility.
4. [design/prototype.html](../design/prototype.html): the visual and behavioural reference. Open `?selftest` to render every view.
5. [design/sample-data.json](../design/sample-data.json): the seed data, exported from the prototype.
6. [templates/AGENTS-docket.md](templates/AGENTS-docket.md): the block each project adds to its `AGENTS.md` or `CLAUDE.md`. Ship it in the repo; the README tells owners to use it.
   - [../skills/](../skills/README.md): the agent skills (owner decision 27). Ship them in the repo; CI lint-checks them against the tool contract.
7. [ROADMAP.md](ROADMAP.md): what is deliberately *not* in V1 (dispatching, GitHub-observed merges, contracts, a knowledge layer), the pre-pilot checklist, and the TERSL reference notes. Don't build anything from it.
8. Background only, not instructions: [REQUIREMENTS_DRAFT.md](REQUIREMENTS_DRAFT.md) (requirement IDs such as A05 and H04 cited below), [UI_DESIGN.md](UI_DESIGN.md) (design rationale and revision history) and [JIRA_RESEARCH.md](JIRA_RESEARCH.md).

**Where the docs disagree:** this file and UI_SPEC.md win over the requirements draft and UI_DESIGN.md. Where the prototype and UI_SPEC.md disagree, UI_SPEC.md wins. Every place this spec deliberately departs from the draft is listed in [Decisions](#14-decisions-log).

---

## 1. What V1 is

Docket is a local **agent coordination service** with a human supervision UI. It's the shared, enforced source of truth that agents work through: work items and their dependencies, eligibility to start, lead claims and leases, plans and evidence, decision records, and the owner's review gates. It runs as one Docker container on the owner's machine and serves three things on one port:

- an **MCP endpoint** (`/mcp`). Installed agent clients (Codex, Claude Code, and both launched as Orca workers) use it to plan, claim, update and hand off work;
- a **JSON API** (`/api`) for the web UI;
- the **web UI** (`/`). It exists so the owner can see what agents did, what they're doing, and what needs the owner.

The service never calls a model API and never launches an agent (O08). It is the **coordinator**, not the dispatcher (owner decision 18): it holds the authoritative record of what work exists, what is eligible to start, who holds it, and the rules (blocking, leases, review gates), and it enforces them on every call. Orca, or the owner, decides when to start an agent; the agent then asks Docket what to do.

### In scope for V1
All P0 requirements, plus four P1 items the owner pulled in: the Timeline layout, Label pages, burn-down and forecast (H14, A18), and the Jira import dry run and import (O05). The UI covers every screen in the prototype plus two screens that weren't prototyped: burn-down/forecast and Jira import. Those two are specified in UI_SPEC.md §9.

V1 also includes four coordination features from the 2026-11-14 review (owner decision 19):
- a **context bundle** for agents (`get_context`, §5.15);
- **decision records** that all agents can read (§5.14);
- **lean agent responses**: summary views, field selection and compact text results (MCP_SPEC §3);
- **stricter dependency rules**: a blocker can be required to be merged or verified, not just done (§5.2).

### Out of scope for V1
- Machine-readable full export (O06; a `docket export` CLI is a stretch goal, see M7).
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
┌─────────────────────────── docker container: docket ───────────────────────────┐
│  Node 22 process (TypeScript)                                                     │
│   ├─ Hono HTTP server on 0.0.0.0:7420 (published as 127.0.0.1:7420 only)          │
│   │   ├─ /mcp     MCP Streamable HTTP (bearer token)        ─┐                    │
│   │   ├─ /api/*   UI JSON API + /api/stream SSE (owner session)├─ domain services  │
│   │   ├─ /healthz /readyz                                    ─┘   (one write path)│
│   │   └─ /*       static React build (SPA fallback to index.html)                 │
│   ├─ scheduler: run-state sweeper (every 30 s), nightly backup (03:00 local)      │
│   └─ SQLite (better-sqlite3, WAL) + document store on /data                       │
└──────────────────────────────────── volume: docket-data → /data ───────────────┘
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
| Container | Multi-stage build, `node:22-bookworm-slim`, non-root user `docket` (uid 10001) |
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
| `DOCKET_TOKEN` | (generated) | Agent bearer token for `/mcp`. If unset, generated on first boot into `/data/secrets/agent-token` (mode 0600) and shown in Settings. Never logged. |
| `DOCKET_PORT` | `7420` | Listen port inside the container. |
| `DOCKET_ALLOWED_HOSTS` | `127.0.0.1:7420,localhost:7420` | Host header allowlist (DNS-rebinding guard). |
| `DOCKET_LIVE_WINDOW` | `2m` | Run counts as *live* if its session showed signs of life within this window. |
| `DOCKET_STALE_AFTER` | `30m` | Open run with no signal for this long is *stale*. |
| `DOCKET_LEASE` | `60m` | Lead claim lease, renewed by any signal from the run. Suspended while the run is parked. |
| `DOCKET_PARK_MAX` | `24h` | How long a run may stay parked before it shows under Problems. It keeps its claim either way. |
| `DOCKET_RESUME_UNATTENDED` | `30m` | How long a parked run may sit `resume_ready` before it shows under Problems as "Ready to resume". |
| `DOCKET_ORPHAN_AFTER` | `15m` | How long a resource may stay unreleased after its run ends before it shows as an orphaned resource. |
| `DOCKET_PUSH_ROOT` | unset | Opt-in push install (decision 29): the container path of a host folder the owner mounts, for example `/host-code`. Unset means push install is off. |
| `DOCKET_PUSH_HOST_PATH` | unset | The same folder's path on the host, for example `C:/Users/me/code`, so the UI can show and accept host paths. |
| `DOCKET_DRIFT_CHECK_INTERVAL` | `15m` | How often push-folder installs are checked for files edited outside Docket (decision 30). |
| `DOCKET_PROTECTED_MODE` | `off` | Decision 32. `on` restores the owner unlock and the agent bearer token. |
| `DOCKET_BACKUP_AT` | `03:00` | Local time for the nightly backup. |
| `DOCKET_BACKUP_KEEP` | `14` | Days of backups kept, in every location. |
| `DOCKET_BACKUP_EXTRA_DIR` | (unset) | Opt-in extra backup location: the path *inside the container* of a host folder bind-mounted by the owner (e.g. `/backups-extra`). When it's set and writable, each nightly backup is also copied there (owner decision 24). |
| `DOCKET_TEXT_ONLY_CLIENTS` | `claude-code` | MCP clients whose sessions get text-only tool results (MCP_SPEC §3 Results; owner decision 28): exact `clientInfo.name`s, comma-separated, ignoring case. `none` gives every client structured results. The default is the name Claude Code sends. |
| `DOCKET_SEED` | (unset) | `sample` loads the sample data into an empty database. |
| `DOCKET_SEED_STRESS` | `0` | Tests only (B35). With `DOCKET_SEED=sample`, `1` also loads the stress project `STR` (§8). The e2e instance and CI set it. |
| `TZ` | host TZ | Display time zone. Storage is always UTC. |

`docker/compose.yaml` publishes `127.0.0.1:7420:7420` only (O02), mounts the named volume `docket-data:/data` (plus a commented-out, opt-in bind mount for the extra backup folder, e.g. `~/DocketBackups:/backups-extra`), sets `restart: unless-stopped`, and has a healthcheck on `/healthz`.

### Volume layout

```
/data/docket.db (+ -wal, -shm)
/data/docs/<PROJECT_KEY>/<document_id>/v<n>/<filename>
/data/secrets/agent-token  /data/secrets/owner-key
/data/logs/calls-YYYYMMDD.jsonl   (diagnostic call log, kept 7 days)
/data/backups/docket-YYYYMMDD-HHMM.tar.gz
```

---

## 3. Security and identity

- **Network.** Only `127.0.0.1:7420` is published. Every request's `Host` must be in `DOCKET_ALLOWED_HOSTS`, otherwise 421. Requests with an `Origin` header must have an allowed origin (the MCP spec requires this), otherwise 403. Other devices and containers are out of scope. A container-network path is documented as off by default (O02).
- **Trust mode** (owner decision 32). `DOCKET_PROTECTED_MODE` (default `off`).
  - **Local trust (default):** no owner unlock and no agent token. The network and Host/Origin rules above still apply, so only processes on this machine reach Docket. Owner API requests record their origin: `actor_kind=owner` plus `via=browser` (same-origin page with the CSRF cookie) or `via=script` (anything else, with its user agent), shown in Activity.
  - **Protected mode (`on`):** the owner session and the agent bearer token below are required, as before decision 32.
  - **What a request needs in local trust (B31, `server/src/api/session.ts`).** The Host and Origin guards run first, in both modes. Then, on `/api`:
    - reads (`GET`, `HEAD`, `OPTIONS`) need nothing more;
    - a mutation **from a browser** needs the CSRF double submit: `X-Docket-CSRF` equal to the `docket_csrf` cookie, which is the session's value or a signed local value (`<nonce>.<hmac>`, keyed from the owner key, so rotating the key invalidates it). A browser without one gets it on its first `/api` response or page load (Path=/, SameSite=Strict, not HttpOnly). A request counts as from a browser when it carries `Origin`, `Sec-Fetch-Site` or a non-empty `X-Docket-CSRF`; browsers send `Origin` on every POST, PUT, PATCH and DELETE, same-origin included, so a page can't skip the check, and a foreign `Origin` (or `null`) never gets this far;
    - a mutation with none of those headers is **a script** (curl, an agent's shell): it needs nothing more, and is recorded as `via: script` with the first token of its `User-Agent` (printable ASCII, ≤ 40 characters; `unknown` without one; `redacted` if the header looks like a secret);
    - `/mcp` and `/agent-upload` need no token, and ignore one if sent; `GET /unlock` redirects to `/`; *Reveal token* (`GET /api/settings/agent-token`) is refused (403), so nothing on the machine can read the token ahead of a switch to protected mode. An unlocked session still works (its CSRF value is accepted); *Lock* without one is `validation`.
  - **`via` on owner events:** every owner mutation's events carry `data.via` (`browser` or `script`) and, for a script, `data.user_agent`; no schema change. Event rows show the actor as `owner (script: curl/8.4.0)` (Activity, and agents' event reads). In protected mode every owner mutation has the session and CSRF, so it is `browser`.
  - **The mode is configuration only:** read once at startup from `DOCKET_PROTECTED_MODE` (`on`, `off`, `true`, `false`; its pre-rename name still works, with the B28 warning). No route or tool changes it; Settings → Connections shows it (`connections.protected_mode`, and `endpoint.auth` `none` or `bearer`).
- **Agents.** In protected mode, `/mcp` requires `Authorization: Bearer <DOCKET_TOKEN>`; one token serves all clients (owner decision 16). In local trust, no token is needed; a token, if sent, is ignored.
  - **Who is calling:** the client name comes from the MCP `initialize` handshake (`clientInfo.name`), normalised: contains `codex` → `codex`; contains `claude` → `claude`; anything else is used as is. Agents add an optional `agent_label` (for example `orca-w3`) on `claim_lead` and `start_run`.
  - **Display:** the actor shows as `claude · orca-w3`.
  - **Storage:** events store `actor_kind=agent`, `client`, `label`, `session_id` and `run_id`.
- **Owner (protected mode).** The browser gets an **owner session**, and agents never get its credential. Without this, any local agent could `curl` the API and record a human approval, which breaks H06. How it works:
  - On first boot the server writes `/data/secrets/owner-key`: 32 random bytes, base32-encoded.
  - The first visit in a browser shows a one-field "Unlock Docket" screen. The owner pastes the key, printed by `docker compose exec docket docket owner-key`.
  - The server then sets the `docket_owner` cookie: HttpOnly, SameSite=Strict, Path=/, 30-day sliding expiry. It's a signed session ID, and sessions are stored in the database.
  - `/api/*` requires that cookie. Mutating API calls also need the header `X-Docket-CSRF`, which must match the `docket_csrf` cookie (double submit).
  - Settings → Connections has *Lock this browser* (ends the session) and *Rotate owner key* (ends all sessions).
- **Secrets.** Tokens, keys and Jira API tokens are never written to task content, events or logs, and logs redact `Authorization` headers. The Jira API token lives only in memory for the import session (§9).
- **What agents cannot do through MCP:** record review decisions, answer their own questions as the owner, write owner notes, archive or unarchive, delete projects, or release another agent's claim. Those are owner actions, available only through `/api`.

---

## 4. Data model

SQLite tables. Every row has `id`, `created_at` and `updated_at`; all timestamps are UTC ISO-8601. Mutable entities also carry an integer `version` (starting at 1, incremented on every change) for optimistic concurrency (A07).

| Table | Key columns | Notes |
|---|---|---|
| `projects` | `key` (2–5 uppercase letters, unique), `name`, `short_name`, `color`, `next_seq`, `default_satisfied_when` (done\|merged\|verified, default done), `deleted_at`, `created_by` (nullable: the agent that created it through `onboard_project`; null for the owner, the seed or a Jira import; B29) | Item IDs are `<KEY>-<n>`. `next_seq` increments inside the creating transaction. |
| `items` | `id` (`RCP-14`), `project_key`, `type` (Epic\|Story\|Task\|Bug), `title`, `description_md`, `outcome_md`, `status`, `priority` (1–3), `epic_id` (nullable; must be an Epic in the same project), `planned_start`, `planned_end`, `dates_set_by`, `dates_set_at`, `effort` (number, nullable), `effort_unit` ('pts'), `closed_by` (owner\|agent\|imported), `closed_at`, `archived_at`, `jira_key`, `imported` (bool), `from_review` (JSON: `{item_id, round, hr_item_id}`), `version` | `status`: inbox, planning, ready, progress, review, done, canceled. Decision 36 adds `shared_none_at`. B40 adds the reported branch (`branch`, `branch_by`, `branch_at`) and what the radar found (`radar_branch`, `radar_branch_matches`) (§5.21). |
| `acceptance_criteria` | `item_id`, `position`, `text` | Ordered list. |
| `labels` | `project_key`, `name`, `brief_md`, `brief_by`, `brief_at` | Unique per project. |
| `item_labels` | `item_id`, `label_id` | |
| `links` | `from_id`, `to_id`, `type` (blocks\|relates), `satisfied_when` (null = the blocked item's project default; done\|merged\|verified), `created_by` | For `blocks`, `from` blocks `to`. Creating a link that closes a cycle is rejected (A04). |
| `plan_versions` | `item_id`, `version_no`, `reason`, `created_by` | The Work checklist history (A16). Each `set_plan` writes a version. |
| `work_steps` | `item_id`, `plan_version_no`, `position`, `text`, `state` (todo\|current\|done\|blocked\|skipped), `was_text`, `change_reason`, `from_review` (JSON), `added_by`, `state_by`, `state_at`, `details_md` (≤ 10,000, nullable; decision 33), `source` (≤ 100, nullable), `details_version` | The current plan is the latest `plan_version_no`. |
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
| `agent_files` | `id` (`af_…`), `key` (`skill:<name>`, `agents_block`, or exactly `guide:onboarding`, the onboarding guide; B30 migration 0007), `layer` (bundled\|service\|project), `project_key` (project layer only), `current_version_id`, `bundled_hash_at_edit` | One row per key, layer and project. Unique `(key, layer, project_key)`. §5.17. |
| `agent_file_versions` | `id` (`afv_…`), `file_id`, `version_no`, `content` (≤ 50,000, B21), `sha256`, `author`, `note`, `created_at` | Immutable. |
| `project_workflows` | `project_key`, `version_no`, `content_md` (≤ 10,000), `author`, `note`, `created_at` | Versioned; the newest is current. Delivered in `get_context` (§5.15). |
| `installs` | `id` (`ins_…`), `at`, `client` (claude\|codex), `target_kind` (repo\|user), `project_key` (nullable), `path` (nullable; required for push), `method` (command\|push), `manifest` (JSON: key → `{version_id, sha256}`), `token_sha256`, `token_expires_at`, `token_used_at` | §5.17. A command install keeps only its token's sha256 and expiry, never the token (B21). |
| `agent_file_proposals` | `id` (`afp_…`), `project_key` (nullable), `file_key`, `content`, `reason`, `based_on_version_id`, `run_id`, `proposed_by`, `state` (pending\|approved\|declined), `decided_at`, `decided_note`, `result_version_id` | §5.19. `based_on_version_id` is an `afv_…` or `wf_…` ID (not a foreign key), null for Workflow notes that didn't exist yet. |
| `instruction_reports` | `id` (`irp_…`), `source` (agent\|push_check), `run_id` (nullable), `install_id` (nullable), `project_key`, `location`, `files` (JSON: key → `{sha256, content?}`), `at` | §5.19. |
| `drift` | `id` (`dft_…`), `install_id`, `project_key` (nullable: a user-wide install), `file_key`, `change` (edited\|missing\|extra), `state` (open\|adopted\|restored\|kept_local), `local_sha256` (null when missing), `report_id` (the instruction report that found it), `detected_at`, `resolved_at` | One open row per install and file; *Keep local* stores the accepted hash. B26 added `change` and `report_id`. A report without an `install_id` is stored but raises no drift. |
| `onboarding_sessions` | `id` (`onb_…`), `project_key`, `started_by`, `client`, `run_id` (nullable), `started_at`, `state` (in_progress\|ready_for_review\|reviewed), `summary`, `questions` (JSON), `finished_at`, `reviewed_at` | §5.20. Events written during a session carry `data.onboarding_session`. One session in progress per project. B29 added `client` (only the client that started a session may resume or finish it) and `run_id`; `summary` is set (≤ 4,000) once finished, and `questions` is an array of at most 20. |
| `shared_parts` | `id` (`spt_…`), `project_key`, `key` (kind-prefixed, normalised; ≤ 200; unique per project), `kind` (table\|model\|endpoint\|file\|other), `paths` (JSON globs, ≤ 20), `single_writer`, `note` (≤ 1,000), `created_by` (`owner` or the agent), `archived_at`, `version` | §5.21 (decision 36; B38). Archiving is the owner's remove. |
| `item_shared_changes` | `id` (`isc_…`), `item_id`, `part_key`, `change` (add\|change\|remove), `note` (≤ 500), `declared_by`, `declared_at` | §5.21. Unique per item and part. `items.shared_none_at` marks an item that declared none. |
| `part_overlaps` | `id` (`pov_…`), `project_key`, `item_a` < `item_b`, `claimed_first`, `parts` (JSON), `state` (open\|sequenced\|compatible\|resolved), `note`, `link_id`, `raised_at`, `decided_by`, `decided_at`, `version` | §5.21. One live row per pair; the row is the owner question (B38). |
| `part_leases` | `id` (`pls_…`), `project_key`, `part_key`, `item_id`, `run_id`, `taken_at`, `expires_at`, `ended_at`, `end_reason` (released\|owner_released\|done\|handed_off\|expired) | §5.21. One live lease per part. |
| `undeclared_holds` | `id` (`udh_…`), `item_id`, `packet_id` (nullable), `via` (submit_packet\|set_status), `parts` (JSON), `files` (JSON, ≤ 2,000), `state` (open\|added\|sent_back), `note`, `decided_by`, `decided_at`, `version` | §5.21 (B38 resolution). One open per item; the row is the owner question. |
| `radar_findings` | `id` (`rdf_…`), `project_key`, `branch_a`, `branch_b`, `item_a`, `item_b` (null for the main branch), `source_a`, `source_b` (reported\|discovered; B40), `files` (JSON), `seen_at`, `cleared_at` | §5.21. One open finding per branch pair. |
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
- **Step details** (decision 33): each step may carry `details_md` and a `source`. `set_plan` sets them per step (patch semantics: omitted means unchanged); `update_step` can replace `details`; the owner edits them in the step dialog with `expected_version` on `details_version`. Details carry over unchanged when a plan revision keeps the step. Owner-added steps keep owner-set details. The write checks (secrets, item references) apply.
- **Imported steps take added details** (decision 34; B36): a step the Jira import wrote (an owner step with a `source`, on an item with `imported` set; the owner's own routes never set a source) accepts details from agents through `set_plan` and `update_step` when they set details where there are none or extend them (the current text, less trailing whitespace, stays at the start). Rewriting or clearing them is `forbidden`, as are its text and source; its state is open to agents like every owner step. Owner-typed steps stay fully protected. The events carry `details_added: true` and the step history reads "details added by <agent>". Nothing new is stored.
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
    - **With a note** (decision 35): `note` is optional (≤ 4,000), and `keep` (`item` by default, `epic` or `project`) is accepted only with a note on approve. The note is stored on the verdict and in `last_decision`, and the server posts an owner note on the item, "Approved with a note: <note>" (event `owner_note.added`, delivered like other owner notes, §5.7). The packet shows it in the round, and the item's Activity shows it.
    - **`keep=epic`** (refused with `validation` when the item has no epic) **or `keep=project`:** the server also publishes an owner decision (§5.14) in that scope: title = the note on one line, ≤ 120 characters, cut at a word boundary with an ellipsis; `decision_md` = the full note; `rationale_md` = "From your review of <ITEM>, round <n>: <finding text>"; `authority=owner`. The verdict's `result_ref` holds the decision's ID ("→ decision for the epic's future tickets" on the packet). `decision.published` logs on the epic or the project as usual, with `data.from_review`; the item's `review.decided` event lists it in `data.kept` and `objects`, and its Activity row links it. It's written in the same transaction as the verdict, so Undo reverts both. Agents on future tickets get it through `get_context` and `get_item` (decisions in scope); no MCP tool changes.
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
  - `docket backup now`;
  - `docket checksums`: prints item, event and document checksums, to compare a restore with its backup (B15);
  - `docket restore <file>`: refuses while the server is running. Run it with `docker compose run --rm docket docket restore …` after stopping the service. It verifies the archive before replacing anything.
- **Extra location** (owner decision 24): if `DOCKET_BACKUP_EXTRA_DIR` is set, the finished archive is also copied there, with the same retention. A failed or missing extra copy never fails the default backup; it shows as a Problem, "Extra backup copy failed: <reason>", until a later copy succeeds. `docket restore` accepts an archive from either location.
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
   - 4b. the **current step** (decision 33; B34): the step in state `current`, else the first `todo`, with its source and details. The details count in the budget and are cut inline with "…truncated; read it with get_step RCP-14 wst_…"; when not even its header line fits, it's left out with a marker naming `get_step`;
5. the project's **Workflow** notes (decision 29), current version, truncated last among sections 1–5;
6. for Markdown planning documents on the item and its epic, the newest version of each. Text is included until the budget runs out; after that, only names and versions;
7. the latest review round's decisions and notes, if any.

**Budgets** (approximate tokens, counted as characters ÷ 4): `small` 1,000, `medium` 3,000 (the default), `large` 8,000. Sections are filled in the order above. Truncation is marked inline ("…truncated; read pantry-prd.md v3 with get_item"), never silently.

### 5.16 Recovery: workspaces, briefs, resources, parking
Owner decision 26, after an Orca crash pruned worktrees that held in-flight work. The aim: a crashed orchestrator or worker restarts **without guessing**, and nothing is left running unnoticed. Docket only **records**; the coordinator acts (Principle I).

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
- **`recovery_report`** (MCP_SPEC §5.9) is read-only and assembles the restart list. The coordinator's recovery procedure is in the [`docket-coordinator` skill](../skills/docket-coordinator/SKILL.md).
- **Limits.** Docket never checks folders, stops processes or prevents pruning: it has no host access, by design (the one exception is the opt-in agent-files push folder, §5.17). The coordinator does those things using this record.

### 5.17 Agent setup: agent files, workflow notes, install (decision 29)
- **Files.** The agent files are each `skills/<name>/SKILL.md` and the AGENTS.md block (`docs/templates/AGENTS-docket.md`). At startup the server loads the copies in the image into the **bundled** layer. When the bundled content changes on upgrade, a new bundled version is added; owner edits are never overwritten.
- **Layers and resolution.** For a project, the effective version of each file is its project override, else the service-wide edit, else bundled. Each edit is a new immutable version with author and note. *Revert* creates a version equal to the layer below (or removes the override). If a file was edited while the bundled version was X and the bundled version is now Y, it's flagged "bundled version updated", with a three-way view (bundled X → bundled Y, and the owner's edit). B23: *Revert* removes the edit or override from use (its versions stay as history), so the layer below applies again and later upgrades reach it. Only the shipped files can be edited. Diffs are line diffs computed in the browser from the versions the GET routes return. Editing again, even with the same text, re-bases the edit on the current bundled version and clears the flag.
- **How the UI presents the layers (B25).** The storage model above is unchanged; the Agent files screen (UI_SPEC §6.7b) shows two ideas instead of three layers. The **default** is what every project uses: the service-wide edit if there is one, else bundled ("Docket's version"); *Reset to Docket's version* is the revert of the service layer. **<Project>'s copy** is the project override, shown only for a project that has one; *Customize for <project>* creates it from the current default (a PUT of the project layer with `expected_version` 0), and *Use default* is the revert of the project layer. A copy is flagged "the default changed" when the server's bundled-updated flag is on its project layer, or when the service edit's current version is newer than the copy's (computed in the browser from the versions the GETs return). "Customized in" (All projects) comes from listing each project's files; no route was added. The screen follows the project switcher and never says bundled, layer, override or service-wide.
- **Workflow notes** are per project, versioned, ≤ 10,000 characters, and included in `get_context` (§5.15). B25: the old block's project questions moved into a Workflow notes starter (`docs/templates/WORKFLOW-starter.md`, bundled into the web build), each with a suggested answer, which *Start from template* loads into the editor unsaved. The shipped AGENTS.md block is generic and has no `{{…}}` placeholders; `{{KEY}}` is still filled for a project's repo install if an owner's edit uses it.
- **Install bundle.** A tar.gz of the effective files laid out for the client and target:
  - Claude Code: `.claude/skills/<name>/SKILL.md` in a repo, or `~/.claude/skills/<name>/SKILL.md` user-wide;
  - Codex: `.codex/skills/` and `~/.codex/skills/`, per verification V7;
  - the AGENTS.md block is inserted between `<!-- docket:begin -->` and `<!-- docket:end -->` in `AGENTS.md` (Codex) or `CLAUDE.md` (Claude Code), appended with markers if absent, and nothing outside the markers changes;
  - a `.docket-manifest.json` lists each file's key, version ID and sha256, plus the install ID.
- **Command install.** `POST /api/installs` returns a single-use download token, valid 10 minutes and loopback only, and PowerShell and bash one-liners that download `GET /install/:token` and unpack it into the target. The install is logged when the token is used.
- **Push install** (opt-in; FR-125): only when `DOCKET_PUSH_ROOT` is set and writable.
  - The target path must be inside the push root.
  - The server writes only the skill folders, the manifest, the `docket-check` scripts next to it (decision 30, B27b) and the marked AGENTS.md section, and never deletes or overwrites other files, except folders Docket itself installed and recorded, when unmodified (below).
  - Settings shows a *Test* that writes and removes a probe file.
- **Check.**
  - **With push:** `POST /api/installs/:id/check` reads the installed files and diffs them against the manifest's versions (changed, missing, extra skill folders).
  - **Without push:** the install response also carries a check one-liner that hashes the local files against the manifest and prints the differences.
- **Never** run anything on the host, follow symlinks out of the push root, or read outside it.
- **Never deletes, except folders Docket itself installed and recorded, when unmodified (B28).** The rename from Task Lite left installs with `tasklite-*` skill folders, a `.tasklite-manifest.json` and `<!-- tasklite:begin/end -->` markers. Both install methods:
  - treat the old marker pair as a valid section (not damaged markers) and replace it with the `docket` markers; a file with both pairs is refused;
  - read the previous manifest at the location (`.docket-manifest.json`, else `.tasklite-manifest.json`), and remove each `tasklite-*` skill folder it lists, but only while the folder holds nothing but its `SKILL.md` and that file still matches the recorded sha256 (CR bytes removed). This is the one deletion: folders Docket wrote and recorded, unmodified;
  - keep an edited old folder and report it ("old name, edited locally"); the check and `docket-check` list it as extra under its old key, and Agent files offers *Adopt* (as the `docket-*` file, its frontmatter name updated) or *Keep local*. *Restore* can't remove it;
  - leave the old manifest and `tasklite-check` scripts in place (never deleted).
  `docket-check` and the drift check read either manifest name and either marker pair, and reports or proposals that still use `skill:tasklite-*` keys are mapped to `skill:docket-*`. Migration 0005 renamed the stored keys; an old install's manifest entries record the folder they were written to (`installed_as`).
- **B24 resolutions** (install and check; agreed with the coordinator):
  - **Layout** (`installLayout` in `shared/src/install.ts`), relative to the base (the repo, or home for user-wide): `.claude/skills/<name>/SKILL.md` or `.codex/skills/<name>/SKILL.md`; the block in `CLAUDE.md`/`AGENTS.md` (repo) or `.claude/CLAUDE.md`/`.codex/AGENTS.md` (user-wide); the manifest at `.claude/.docket-manifest.json` or `.codex/.docket-manifest.json`. A user-wide install from the UI sends the service-wide set (no project).
  - **The block as installed:** the template's leading HTML comment is stripped, and `{{KEY}}` is filled with the project key for a project's repo install only. The Install dialog warns when `{{…}}` placeholders remain (*Edit block*, *Install anyway*).
  - **The marked section:** replaced between the markers, or appended after a blank line (the old text stays an exact prefix), or a new file. A missing or repeated marker refuses the install, and nothing is written.
  - **The manifest's `sha256`** is the installed content's with CR bytes removed: a skill's equals its version's sha256; the block's is the rendered block's. The check hashes the same way (the block is the text between the markers, less one newline at each end), so Git's line endings on Windows aren't edits.
  - **Command install:** `record` appends `install.recorded` with `data.stage: "command_issued"` ("Install command created: …"); the download appends a second with stage `downloaded` ("Installed by command: …", actor system). Push appends one with stage `pushed`. The log lists push installs and downloaded command installs. The token is kept out of the write path's arguments, rows, events and logs (tested by grep).
  - **The one-liners** download into a temporary folder, unpack with `tar` (Windows' own `tar.exe` from PowerShell), and run the bundle's dependency-free install step (`install.sh` / `install.ps1`, ASCII). A repo install refuses a folder without `.git` before it uses the token. PowerShell runs the step as a script block, so it works under the Restricted execution policy. Tested for real with bash, PowerShell 7 and Windows PowerShell 5.1.
  - **Push paths:** a host path under `DOCKET_PUSH_HOST_PATH` (any case and slashes for a Windows path), a container path under the root, or a path relative to the root. The base folder must already exist. Each escape is blocked in `server/src/domain/push-root.ts`.
  - **Check:** *extra* means a `docket-*` skill folder that isn't in the manifest; other skill folders are the owner's own. A symlinked installed file reads as *edited* (never followed). **Contract change (B24):** each edited file of a push check carries `local_content` (≤ 50,000 characters; for the block, the text between the markers), so the UI diffs it against the version sent. The command check prints each file's state with the version ID sent.

### 5.17b Several clients, install state and the AGENTS.md import (decision 34)
- **Several clients in one install.** `POST /api/installs` takes `clients: ["claude", "codex"]` (1–2, no repeats) or, as before, `client`; exactly one of the two. The clients are installed in a fixed order, Claude Code first. Each client is its own install: its own `ins_…` ID, manifest, log row and `install.recorded` event (`data.clients` lists the group). The response keeps every earlier field (`install_id` is the first client's; push's `result.files` lists every client's files) and adds `clients: [{ client, install_id, files: [{ path, change?, note? }], check_command? }]`, the one summary the dialog shows. A command install's `files` are the paths it will write, without `change`.
- **Push:** every client is planned (each write's bytes, every target checked, every marker and connection file validated) before any client writes, so a damaged `AGENTS.md` stops the Claude Code files too.
- **Command:** one token for the group. A single client's row stores the token's sha256, as before; with several, each row stores the sha256 of `<token>:<client>` (the unique token index holds, no migration). The download finds every row of the token, builds one bundle with each client's step in `docket-install/<client>/` and a wrapper `install.sh`/`install.ps1` at the top, and marks each row used in one write. The wrapper first runs every client's step in check-only mode (`DOCKET_CHECK_ONLY=1`, or the PowerShell step's third argument `check`), which validates markers and connection files and writes nothing, then installs each client in turn. A single-client bundle is laid out exactly as before.
- **CLAUDE.md imports AGENTS.md:** a Claude Code repo install that creates `CLAUDE.md`, in a repo that already has `AGENTS.md`, writes `@AGENTS.md`, a blank line, then the marked section (`mergeMarkedSection`'s `importAgents`; the push and both install steps). "Already" means before this install: push plans Claude Code before Codex writes, and the command's wrapper runs Claude Code first. An existing `CLAUDE.md` never gets the line. It sits outside the markers, so the check and drift ignore it. The push summary notes it on `CLAUDE.md`.
- **Install state** (`GET /api/install-state?project&path`): per client, from the latest install at that target (the project's repo installs, or user-wide when `project` is omitted; push, or a command whose bundle was downloaded) and the open drift rows of that install, with nothing new stored:
  - `not_installed`: no such install;
  - `changed`: open drift on it ("Changed outside Docket");
  - `update_available`: `outdated` lists each key whose effective version differs from the version sent, each file added or removed since, and the connection file when the trust mode changed;
  - `up_to_date` otherwise.
  It also returns `markers` per client and `defaults`: when `path` is a repo folder inside a ready push folder, Docket looks (read-only, no symlinks followed) for `.claude/` or `CLAUDE.md` (Claude Code) and `.codex/`, `.agents/` or `AGENTS.md` (Codex); `defaults` are the clients with markers or an install there, else both. Otherwise `markers` is null.

### 5.18 Help center (decision 29)
Articles are Markdown files in `docs/help/<slug>.md`, with front matter `title`, `summary` and `anchors` (the screens and states that link to them). They're bundled into the web build: no API, no database. The UI lists them at `/help`, renders them at `/help/:slug`, includes them in palette results, and shows a "?" link wherever an anchor applies. Content changes ship as normal PRs.

---

### 5.19 Agent proposals and drift (decision 30)
- **Reading.** `get_agent_files {project}` returns the files and Workflow notes in effect for that project (content, version ID, sha256, and where each comes from), so an agent edits the current text.
- **Proposing.** `propose_agent_file_change {project?, file, content, reason, based_on_version_id}` stores a **pending proposal**. `file` is a skill key, `agents_block` or `workflow`. With `project`, it targets that project's copy; without it, the default. It changes nothing. The write checks (secrets, item references) apply. At most 5 pending proposals per file and project; a newer proposal from the same run replaces its own older one.
- **Deciding.** The owner approves (saved as a new version of the target, author "proposed by <client · label> · approved by owner"), edits then approves, or declines with an optional note. If the target changed since `based_on_version_id`, the review shows a three-way view. Every decision is an event, and approval is undoable like any owner edit.
- **Agents can't write agent files directly** (FR-130). The owner routes stay owner-only.
- **Instruction reports.**
  - **From agents:** `claim_lead` accepts `instructions?: { install_id?, files: [{ key, sha256, content? }] }`. The installed `docket-check` script produces it, and includes `content` (≤ 50,000 characters) only for files whose hash differs from the manifest. The report is stored on the run.
  - **From the push folder:** a scheduled check (`DOCKET_DRIFT_CHECK_INTERVAL`, default 15 min, and at startup) runs the B24 check on every push install's location.
- **Drift.** A report that differs from the install's manifest raises a drift record per location: changed, missing and extra files. The owner sees a Problems row, "Agent files changed outside Docket · <project> · <file>", with the diff when content is available, and three remedies:
  - *Adopt*: save the local content as the project's copy, as an owner edit;
  - *Restore*: reinstall Docket's version (push, or show the command);
  - *Keep local*: accept it; no new alert until the content hash changes again.
- **Runs** show "Instructions: docket-worker · Recipe App's copy v2", with ⚠ "edited locally" when the reported hash differs from what was sent.
- **B27 resolutions** (agreed with the coordinator, or settled in the build and listed in the PRs):
  - **Proposals:** the target must be a file Docket ships (or `workflow`), and `based_on_version_id` a version of it (any layer) or of the project's notes. A newer proposal from the same run removes its own older pending one (the event says so). *Approve* saves through the owner's edit path with the author "proposed by <client · label> · approved by owner" ("edited and approved" when the owner changed the text); the note is the owner's, else the agent's reason. A decided proposal can't be decided again (`conflict`). Workflow notes versions carry their `wf_…` `id` (optional, B27a).
  - **`docket-check`:** `docket-check.sh` and `docket-check.ps1`, written next to the manifest by both install methods. It hashes like B24's check, prints one line of JSON (`install_id`, and each present file's `key` and `sha256`, plus `content` for a file that differs, ≤ 50,000 characters), leaves missing files out, lists extra `docket-*` skill folders, and stops at 20 files. The PowerShell version prints non-ASCII as `\uXXXX`.
  - **Reports and drift:** an unknown `install_id` is stored as no install. Text is kept only for files that differ. Against the manifest: *edited* (another hash), *missing* (not reported), *extra* (a `docket-*` skill the install didn't write); other keys are unknown and only listed on the run. A later report updates an open record when the hash or kind moves on, and resolves it as `restored` when the file matches again. A newer install at the same location (client, target, path) resolves an older install's open records. A record resolved by *Keep local* or *Adopt* accepts its hash. A quiet push check writes nothing (no report row, no event); the push check uses the latest push install per location. **Reporting never blocks claiming** (gate review): a reported file whose text looks like a secret keeps its key and sha256 and loses its text before the write check (`claim_lead`'s adapter, and the push check), and the report and the drift record say `content_withheld: secret` (`driftSchema` gains it, optional). The text is never stored or logged; *Adopt* is then unavailable with that reason.
  - **Remedies:** *Adopt* needs the local text and a shipped key; a missing file can't be adopted. *Restore* reinstalls the install's current effective files (push writes them; command returns a new command) and resolves every open record of that install; an extra folder can't be restored (Docket never deletes). The Problems row's reason is "<file> edited|missing|added outside Docket · <project short name or user-wide> · <where> · found by the scheduled check | reported by <agent> on <item>", with `drift_id` and no item.

### 5.17a Connection files (decision 32)
The agent-files install (§5.17) also writes each client's **project connection file** into the repo:
- Claude Code: `.mcp.json` with `{"mcpServers": {"docket": {"type": "http", "url": "http://127.0.0.1:7420/mcp"}}}`. In protected mode it adds `"headers": {"Authorization": "Bearer ${DOCKET_TOKEN}"}`, expanded by Claude Code from the environment.
- Codex: `.codex/config.toml` with `[mcp_servers.docket]` `url = "http://127.0.0.1:7420/mcp"`, plus `bearer_token_env_var = "DOCKET_TOKEN"` in protected mode.

**Merging:** an existing file is merged, adding or replacing only the `docket` entry; other servers and settings are kept, and invalid files are refused with a clear message, never overwritten. The files are in the manifest, so *Check* and drift cover them. They never contain a secret. The client asks once (Claude Code: approve the project MCP server; Codex: trust the project), and the Install dialog says so. A user-wide connection remains available as a copy-paste command for owners who prefer it.

**B31 resolutions** (agreed with the coordinator, or settled in the build and listed in the PR):
- **docket-check leaves the connection file out of its `claim_lead` report** (coordinator): an agent that claims is connected, and the key isn't part of `claim_lead`'s contract, which is unchanged. The push *Check*, the scheduled drift check and the copy-paste check command cover it; agent reports neither raise nor resolve its drift records, and runs' instruction lists leave it out.
- **Manifest:** key `connection`, path `.mcp.json` or `.codex/config.toml`, version `connection:local` or `connection:protected` (the mode it was written in; a command bundle and *Restore* rewrite it in that mode), sha256 of the entry's canonical text. Repo installs only; a user-wide install writes none. The address is `http://<first DOCKET_ALLOWED_HOSTS entry>/mcp`.
- **Canonical text, compared by every check:** JSON, the `docket` value with the whitespace outside strings removed; TOML, the `[mcp_servers.docket]` table's lines from its header to the next header, each trimmed, without blank and comment lines. Other servers, and reformatting, aren't drift. A file that can't be scanned reads as *edited*; no `docket` entry reads as *missing*.
- **What is refused:** JSON that isn't one object, or has a trailing comma, a comment, a bad literal, a repeated `mcpServers` or `docket`, or a non-object `mcpServers`; TOML with a line that isn't blank, a comment, a table header or `key = value` (multi-line strings and arrays are followed), an unclosed string or bracket, a repeated `[mcp_servers.docket]`, or `docket` defined another way (a dotted key, or an inline table under `[mcp_servers]`). Push answers `validation`; the command's install step stops before writing anything.
- **Where it's inserted:** the entry replaces the old `docket` value in place; otherwise it goes first in `mcpServers` (or a new `mcpServers` first in the object); a TOML table replaces the old one up to its last non-blank, non-comment line, or is appended after a blank line.
- **Three scanners, one behaviour:** TypeScript (`shared/src/connection.ts`: push, push check, drift), awk (`CONNECTION_AWK`: the bash install step and check command; POSIX awk, `BINMODE` for Git Bash) and PowerShell (`CONNECTION_PS1`, which also runs as one line in the check command). `connection-shell.test.ts` runs all three over the same files.
- **Drift:** migration 0008 rebuilds `drift` so `file_key` may be `connection`. Its card offers *Restore* and *Keep local*; *Adopt* is refused (it isn't an agent file).
- **Checked with the real clients (B31):** `claude -p` (2.1.326), run in the repo with `--setting-sources project` and no `--mcp-config`, used the project's `.mcp.json` server without a prompt and called `whoami`; an interactive session asks once. `codex exec` (0.157) ignored `.codex/config.toml` until the folder was trusted (`[projects.'<path>'] trust_level = "trusted"`, lower-case with backslashes on Windows), then called `whoami`.

### 5.20 Onboarding (decision 31)
- **New project** (owner): `POST /api/projects` with key, name, colour and `default_satisfied_when`. It follows the key and tombstone rules (§5.12, US9).
- **`onboard_project {key, name?, color?}`** (agents):
  - if the key is free, it creates the project, with `created_by` set to the agent;
  - if the project exists, it adopts it;
  - either way it starts an onboarding session and returns `{project, session_id, guide, existing: {items, jira_items, documents}}`;
  - `guide` is the effective onboarding guide (agent file key `guide:onboarding`; default `docs/templates/ONBOARDING-guide.md`), with the project key filled in (`{{KEY}}`).
- **The guide as an agent file** (B30; contract change approved for B30): `guide:onboarding` is a bundled agent file, loaded at startup with the skills, and the owner edits it on Agent files as the default or per project (kind `guide`, "Onboarding guide"). The project's copy applies once the project exists; a free key gets the default. It is served by `onboard_project` and the `onboard` prompt, never installed: installs, drift, the check script and `get_agent_files` leave it out, and proposals can't name it. `AGENT_FILE_KEY_RE` and the `agent_files_key` CHECK allow exactly that key (migration 0007 rebuilds `agent_files`, rows unchanged).
- **The guide** (bundled, editable like the other agent files). Its steps:
  1. **Survey:** Spec Kit `specs/*/{spec,plan,tasks}.md`, the constitution, issues, TODOs, READMEs and docs.
  2. **Reconcile first:** `search_items` by Jira key, title and source path; enrich matches with `update_item` (acceptance, outcome) and links rather than creating duplicates.
  3. **Create the rest** in Planning: epics from features and specs, items from tasks, `blocked_by` from task dependencies, labels for cross-cutting areas, decisions from the constitution and ADRs, and specs and plans attached as planning documents.
  4. **Propose** Workflow notes with `propose_agent_file_change`.
  5. **Ask** open questions with `ask_owner` on the epic.
  6. **Finish** with `finish_onboarding`.
- **`finish_onboarding {session_id, summary, questions?}`** marks the session ready for review. Changes made during the session are tagged with `session_id`, so the review card can list them.
- **Tagging** (B30): every event an agent writes while its client has a session in progress on the event's project (its `project_key`, else its item's) carries `data.onboarding_session`. The match is by client only (`onboarding_sessions.client`, the normalised `clientInfo.name`); `agent_label` doesn't narrow it, since labels are optional and per call. Owner and system events are never tagged. The counts: **created**, items with a tagged `item.created`; **enriched**, other items with a tagged edit (`item.updated`, `item.status_changed`, `link.added`, `link.updated`, `document.added`, `human_review.declared`, `decision.published`, `note.added`); **documents**, distinct documents added; **decisions**, decisions published; **proposals**, `agent_file.proposed` (the latest Workflow one is `workflow_proposal_id`).
- **Never Ready** (B30): while a client's session is in progress, its `set_status` to `ready` on that project is `forbidden`; `create_item` only takes `inbox` or `planning` anyway.
- **The review card's links** (B30; contract change): `GET /api/work` takes `onboarding` (a session ID) and `onboarding_change` (`created` or `enriched`, both when omitted), limiting the items and the Epics row to that session's.
- **Calling `onboard_project` again** (B29): the same client, on a project where its own session is in progress, gets that session back (the same `session_id` and guide, `existing` counted again). Another client's session in progress is `forbidden`.
- **The MCP prompt `onboard`**, with arguments `project_key` and `project_name`, returns the same guide. It's the first MCP prompt; clients that don't support prompts use the tool. The server declares the `prompts` capability (`listChanged: false`), and text-only result mode doesn't affect prompts (MCP_SPEC §3).
- **Events:** `project.created`, `onboarding.started`, `onboarding.finished` (for you: it raises the badge) and `onboarding.reviewed` (contracts/events.md).
- **Contracts** (B29, T163): the schema, the two tools as stubs with their descriptions, the prompt (answering "Onboarding guide not available yet"), the server-instructions bullet, the routes as 501 placeholders, the events and the client. B30 (T164–T166) fills them.
- **Limits:** agents can't change project settings or delete projects (FR-140). An agent-created project shows "created by <agent> · review" until the owner marks one of its onboardings reviewed (the API's `created_by` is null from then on; the column keeps it).
- **Batches** (decision 34; B36; MCP_SPEC §5.13): `apply_batch` runs up to 100 operations (`create_item`, `update_item`, `link_items`, `upsert_label`, `set_plan`, `update_step`, `put_document`, `publish_decision`) in one call. Each is validated against its own tool's schema and run by its own handler through the write path in its own transaction (atomic per operation, never all-or-nothing), and reports its own result. `"$n"` arguments name an earlier operation's ID. Each operation's idempotency key is its own, or derived from the batch's key and its index (`batch:<sha256 of the key, 40 hex>#<index>`), so a retry replays what succeeded. Events are tagged with the onboarding session as for single calls. The onboarding guide and `docket-planner` tell agents to batch, and to add details to imported steps that a Spec Kit task matches instead of creating items.
- **The Jira import** writes `project.created` for the project it opens (B30; `project.updated` before), through the same insert as *New project* and `onboard_project`.

### 5.21 Shared changes and conflict guardrails (decision 36)

**Tables** (all project-scoped):
- `shared_parts`: `project`, `key` (kind-prefixed and normalised: `table:decks`, `model:Token`, `endpoint:POST /decks/{id}/export`, `file:src/Gameflow.Api/Data/Migrations/GameflowDbContextModelSnapshot.cs`, `other:<slug>`), `kind`, `paths` (JSON globs, repo-relative), `single_writer`, `note`, `created_by`, `archived_at`.
- `item_shared_changes`: `item_id`, `part_key`, `change` (add|change|remove), `note`, `declared_by`, `declared_at`; plus `items.shared_none_at`, set when an item declares none.
- `part_overlaps`: the pair (two item ids), the part key(s), `state` (open|sequenced|compatible|resolved), `decided_by`, `decided_at`. The row is the owner question (B38: no `question_id`; see the resolutions below).
- `part_leases`: `part_key`, `item_id`, `run_id`, `taken_at`, `expires_at`, `ended_at`, `end_reason`.
- `radar_findings`: the branch pair, `files` (JSON), `seen_at`, `cleared_at`.
- `undeclared_holds` (B38): the item, the held packet (null for `set_status` to `done`), the parts and files, `state` (open|added|sent_back), `decided_by`, `decided_at`.
- Also (B38): `packets.changed_files`, `packets.branch`, `packets.held_undeclared`; `projects.repo_path`, `projects.main_branch` (default `main`), `projects.radar_last_run_at`, `projects.radar_off_reason`.

**Rules:**
- **Ready gate:** `set_status ready` (agent or owner) is refused (`not_declared`) unless the item has declarations or `shared_none_at`. The owner may pass `override_reason`.
- **Overlap at claim:** `claim_lead` checks the item's parts against items that are In progress, In review, or Ready with a live claim. A shared key is an overlap unless that pair is `compatible`, or a `blocks` link already sequences them. On overlap, the claim fails with `seam_conflict` (`details: { with: [ids], parts: [keys] }`) and opens one `part_overlaps` row plus an owner question (Needs you, kind `overlap`). Re-claiming the same pair doesn't open a second question.
  - *Run one after the other* adds `blocks` (type `merged`) from the item claimed first to the other.
  - *They're compatible* records the pair as compatible, plus an optional note. That note is posted to both items as an owner note.
- **Declaring later:** declarations can change while an item is in progress. A new overlap found then flags both items ("Now overlaps GF-240 on model Token") and raises the question, but doesn't revoke the claim.
- **Leases:** a lease runs 2 hours by default (`DOCKET_LEASE_MINUTES`) and is renewable. It ends when the holder's item reaches Done or is handed off, when the holder releases it, or when it expires. Owner *Release lease* is in the item's Shared changes section.
- **Hand-off** is `submit_packet` (a packet for human review) or `set_status` to `done` (closing with no human review):
  - both accept `changed_files` (≤ 2,000 repo-relative paths);
  - Docket maps them through each part's `paths`;
  - any part that isn't declared holds the item and raises a question (kind `undeclared_parts`) with *Add to the declaration* or *Send back*. On `submit_packet`, a `held_undeclared` flag on the packet: the packet is created, but the human review gate stays closed. On `set_status` to `done`, the move is refused with `not_declared` (`details.undeclared`, `details.files`) and the item stays where it was;
  - if `changed_files` is missing, an item with declarations shows "Changed files not reported" on the packet.
- **Conflict radar:**
  - the project setting `repo_path` (inside `DOCKET_PUSH_ROOT`) and `main_branch` (default `main`);
  - `claim_lead`, `submit_packet` and `set_status` (to `done`) accept `branch`;
  - every 15 minutes, and on demand, Docket runs `git merge-tree --write-tree --name-only` for each in-flight branch against `main_branch`, and for each pair of in-flight branches whose items share a part or whose changed files intersect;
  - it uses a temporary object directory (`GIT_OBJECT_DIRECTORY` set to a temp dir, with the repo's objects as alternates), so **nothing is written to the repository**. No fetch: local refs only, which worktrees share;
  - findings go to `radar_findings`, to both items ("Heading for a conflict with GF-240: 3 files"), to Needs you (Problems), and to `get_context`. A finding clears when the trial merge is clean;
  - when git or the repo isn't available, the radar shows "Radar off: no repository" and the rest still works.
- **Context:** `get_context` adds `shared` with three parts:
  - the item's declarations;
  - overlapping in-flight declarations from other items (id, title, status, change, note);
  - up to 30 other in-flight declarations in the project.

  It also includes leases held, and radar findings for the item. All of this counts against the budget.
- **Activity:** events `shared.declared`, `overlap.raised|decided`, `lease.taken|ended`, `undeclared.held|decided`, `radar.found|cleared`, and `shared_part.saved` (B38: a part registered or edited).

**B38 resolutions** (contracts, T182; agreed with the coordinator, or settled in the build and listed in the PR):
- **Names:** earlier drafts said `submit_for_review` and `handoff`, which aren't Docket tools. Hand-off is `submit_packet` or `set_status` to `done` (coordinator). A refused close reuses `not_declared`, so there are three new codes.
- **Keys and paths** are normalised as MCP_SPEC §5.15 describes (`table` lowercased, `endpoint` as `METHOD /path`, `file` repo-relative with forward slashes, `other` a slug).
- **The owner question is the row:** an overlap (`part_overlaps`) or a hold (`undeclared_holds`) is the Needs you card itself, not a `questions` row, so it never takes the item's one open question (FR-022) and an agent can still `ask_owner`. Needs you gains the optional `overlaps`, `undeclared_holds` and `radar_findings`.
- **Holds have their own table** (`undeclared_holds`), since a `set_status` to `done` hold has no packet.
- **A declaration doesn't change the item's version**, so an agent's `expected_version` stays good; it's recorded as `shared.declared`. The owner's declaration and registry edits are undoable; overlap and hold decisions, lease release and the radar are not.
- **In flight** is Ready, In progress or Review (`IN_FLIGHT_STATUSES`), for overlaps, `list_shared_parts` and `get_context.shared`.
- **The Ready override** is `override_reason` on `PATCH /api/items/:id`, only with `status: ready`.
- **Parts in owner routes** are addressed by `spt_…` ID, since keys hold `:`, `/` and spaces. Key and kind are fixed once a part exists.
- **What B38 implements:** the registry, declarations (`declare_shared_changes`, the owner's route), `list_shared_parts`, the item's Shared changes section and the radar card's read, and `submit_packet` storing `changed_files` and `branch` as reported. **Placeholders for B39:** `take_lease` and `release_lease` (`unavailable`), the decisions, lease release and the radar's settings and run (501), the Ready gate, the overlap check at the claim, the changed-file check at hand-off, and `get_context.shared` (absent). B39 (T183–T185) built them; `us18-shared-contracts.test.ts` tests each.

**B39 resolutions** (T183–T185; settled in the build and listed in the PR):
- **The Ready gate** covers every move into Ready from Planning: `set_status`, the owner's `PATCH` (with `override_reason`, recorded in the `item.status_changed` summary and `data.override_reason`), and the label page's *Move N to Ready*, which refuses the whole move with `not_declared` and `details.items`. Giving work up (In progress → Ready, by the lead or on lease expiry) isn't gated: the item was Ready before.
- **The claim check** compares against items In progress or In review ("Ready with a live claim" is In progress: claiming moves it there), so two Ready items that declare the same part never refuse each other's first claim. A declaration's informational overlaps still include Ready items. The refused claim writes `claim.rejected` and the overlap in a write of its own (the claim's transaction rolls back), like a lease conflict. `search_items` `ready_to_start` leaves out an item whose overlap question is open while its other item is claimed, so unattended agents move on (SC-023).
- **"Claimed first"** is the item already claimed when the claim is refused; when an item declares later, it's the one whose lead claimed earlier. `overlap.raised` and `overlap.decided` are written on both items. An overlap becomes `resolved` when either item closes or is canceled, or, while undecided, when the two no longer declare a common part.
- **Leases:** a renewal moves the expiry outside the write path (no event, like a heartbeat). A lease also ends when its item is canceled (`released`, or `owner_released` for the owner's cancel). "Ends when the holder's PR merges" needs no rule of its own: Done and hand-off end it first.
- **Hand-off:** while a packet is held, deciding it is a `conflict` naming the parts. *Add to the declaration* adds each part as `change` with the note "Added by the owner at hand-off" and opens the packet. *Send back* withdraws a held packet, returns the item to In progress and posts the owner's note (or a default one). The packet view gains `shared` (changed files, branch, held parts, the hold, and `not_reported`).
- **Branches:** `claim_lead`'s `branch` goes into the run's workspace when one is reported, else into the `claim.granted` event's data. The radar reads an item's latest packet branch, then its lead run's workspace branch, then its latest claim's.
- **The radar** checks a pair when the items declare a common part or their changed files intersect (the packets' `changed_files` plus `git diff --name-only <main>...<branch>`). It reads local branches (`refs/heads/`, then `refs/remotes/origin/`), never fetches, and runs git with `GIT_OBJECT_DIRECTORY` set to a temporary folder, `GIT_OPTIONAL_LOCKS=0` and `gc.auto=0`. A run plans (git, outside any transaction), records findings (events), then stamps `radar_last_run_at` and `radar_off_reason` as bookkeeping. A missing main branch is "Radar off: no branch main". Saving the settings writes `project.updated`; changing the repository or turning the radar off clears its findings. `docker/Dockerfile` installs git (no recommended packages).
- **Context:** `get_context.shared` is section 4c: placed after the current step and before the Workflow notes when the budget is applied, rendered after them. Other in-flight declarations are cut first, then overlapping ones (`truncated`); failing that, it's left out with a marker.
- **Needs you:** overlap and hold cards count as for you (the tab title and sidebar counts) but raise no desktop notification (US2: only hand-offs and questions do). Radar findings are Problems rows of the new kind `radar_conflict`, ranked first (unattended branches keep moving toward the conflict). Work items gain optional `shared_flags` for the cards' "overlap" and "conflict ahead" markers.
- **Settings:** the registry and radar card are a page, `/settings/projects/<key>/shared-parts`, linked from each project row.

**B40: the radar sees in-flight branches.** Gameflow pilot feedback: items already In progress when decision 36 shipped had no recorded branch, so the radar couldn't see them until their next `claim_lead` or `submit_packet`. B40 stays within decision 36's design; these points were settled in the build and are listed in the PR:
- **Reporting a branch any time:** `declare_shared_changes` takes an optional `branch` (MCP_SPEC §5.15), so agents can report it while backfilling a declaration. The owner sets or clears it in the item's Shared changes section (`PUT /api/items/:id/shared/branch` `{branch | null}`, undoable). Both write `items.branch`, `branch_by` and `branch_at` without moving the item's version, and record the event `branch.reported`.
- **Which reported branch:** the newest of the item's own report (or clear), its latest packet's, its lead run's and its latest claim's. A clear counts as a report of no branch, so the radar then looks for one. (B39 read the packet's, then the run's, then the claim's, regardless of age.)
- **Discovery:** for an in-flight item with no reported branch, each run lists the local branches (`git for-each-ref refs/heads` and `git worktree list --porcelain`). It looks for a branch whose name holds the item's key or its Jira key as a whole token, in any case and with or without the hyphen: `gf-239`, `GF-239`, `gf239` and `gameflow-239` match, `gf-2390` doesn't. The rules are unchanged: local refs only, no fetch, a temporary object directory, and nothing written to the repository.
  - **One match** is used. The item shows "Branch found by the radar: <name>".
  - **Several matches:** the radar uses none. The item shows "Several branches match; report the branch", with their names.
  - **Precedence:** a reported branch always wins over a discovered one. Reporting a branch keeps what the radar found, so clearing the report falls back to it.
  - **Recording:** the run stores what it found on the item (`items.radar_branch`, `items.radar_branch_matches`). It records the event `branch.discovered` only when that changes, so a run that finds nothing new writes nothing.
- **Source:** findings carry `source_a` and `source_b`, either `reported` or `discovered` (`source_b` is null for the main branch, and a finding from before B40 reads as `reported`). The `radar.found` data carries the item's `source`. For a discovered branch, its summary adds "(branch found by the radar: <name>)". Migration `0011_radar_branches` adds the columns, without rebuilding any table.

## 6. MCP tool contract

**Overview only.** [MCP_SPEC.md](MCP_SPEC.md) is authoritative for the server instructions, every tool's description text, input and output schemas, error messages and worked flows. It defines 48 tools (38, plus `get_step` from decision 33, plus `get_agent_files` and `propose_agent_file_change` from decision 30, `onboard_project` and `finish_onboarding` from decision 31, `apply_batch` from decision 34, and `declare_shared_changes`, `list_shared_parts`, `take_lease` and `release_lease` from decision 36), and one prompt (`onboard`), including `unlink_items`, `update_check` and `update_human_review`, which are paired with their siblings below.

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
| `POST /api/session/unlock` `{key}` · `POST /api/session/lock` · `POST /api/session/rotate-key` | Unlock screen, Settings. Rotate-key writes a new owner key (0600), ends every owner session including the caller's, clears the cookies, and returns `{rotated: true}`. It never returns the key; the owner reads it with `docket owner-key` (decided in B2). |
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
| `POST /api/items/:id/work` · `DELETE …/work/:stepId` · `PATCH …/work/:stepId/details` `{details, expected_version}` | Owner work steps, and the step dialog's *Edit details* (decision 33): `expected_version` is the step's `details_version`, a stale one is `409` with `current`, and the edit is undoable |
| `GET /api/items/:id/work/:stepId` → `{step, history, jira_site}` | The step dialog's contents (decision 33; B34): the step with its details and its history, read by the same code as `get_step` (any step on the item, a removed one included; `404` otherwise), plus `jira_site`, the normalised origin (`https://host`, nothing else) that the project's latest Jira import recorded, or null, so a Jira key in `source` links to its issue. Read-only |
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
| `GET /api/install-state?project&path` → `{project, target_kind, clients: [{client, state, install, outdated, drift_ids, markers}], defaults}` | Each client's install state (decision 34; §5.17b): `not_installed`, `up_to_date`, `update_available` or `changed`, from the latest install and open drift; `markers` and the dialog's `defaults` from the repo folder when it's inside the push folder. Read-only |
| `GET /api/search?q` | Command palette (items, labels, views). Items include archived ones, each with `archived: boolean` for the palette's *Archived* tag (UI_SPEC §4). B35: a one-word query that appears as a whole token in a current-plan work step's `source` (a Jira sub-task key: "GAMEFLOW-227" matches "GAMEFLOW-227" and "Jira GAMEFLOW-227", not "GAMEFLOW-2270") also finds the parent item, with `matched: "step_source"` and `step: {id, text, source}`. Order: an exact item ID or `jira_key` match, then step-source hits, then full-text matches. The MCP `search_items` tool doesn't share this code and is unchanged. |
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
| `POST /api/projects` `{key, name, color?, default_satisfied_when?}` · `GET /api/onboarding?project&state` · `POST /api/onboarding/:id/reviewed` | New project; the onboarding review card (decision 31). Shapes in `shared/src/api/onboarding.ts` (B29); neither POST is undoable. Needs you gains `onboarding_reviews` (the sessions ready for review) and project rows `created_by`, both optional. |
| `GET /api/projects/:key/shared-parts?include_archived` · `POST /api/projects/:key/shared-parts` `{key, kind?, paths?, single_writer?, note?}` · `PATCH /api/shared-parts/:id` `{expected_version, paths?, single_writer?, note?, archived?}` · `GET`/`PUT /api/items/:id/shared` `{changes \| none, new_parts?}` · `PUT /api/items/:id/shared/branch` `{branch \| null}` (B40) · `POST /api/overlaps/:id/decide` `{decision: sequence\|compatible, note?}` · `POST /api/undeclared-holds/:id/decide` `{decision: add\|send_back, note?}` · `POST /api/leases/:id/release` · `GET`/`PUT /api/projects/:key/radar` `{repo_path, main_branch?}` · `POST /api/projects/:key/radar/run` | Shared changes and the conflict radar (decision 36; §5.21; UI_SPEC §6.3.6). Shapes in `shared/src/api/shared-changes.ts` (B38). Registry and declaration edits are undoable. `PATCH /api/items/:id` takes `override_reason` with `status: ready`. Needs you gains `overlaps`, `undeclared_holds` and `radar_findings`, all optional. |
| `POST /api/resources/:id/release` `{note?}` · `POST /api/runs/:runId/unpushed-handled` | Problems actions: *Mark released* on an orphaned resource; *Handled* on "Unpushed work may be lost" |
| `GET /api/stream` | SSE: `event: change`, `id: <seq>`, `data: {seq, type, objects:[{kind, id}], for_you}`, where `for_you` is true only for `packet.submitted`, `question.asked` and `onboarding.finished` (used for the badge and desktop notifications; specs/001-task-lite-v1/contracts/events.md). The client invalidates matching TanStack Query keys. Supports `Last-Event-ID`. Sends a heartbeat comment every 25 s. |
| `GET /healthz` (process up) · `GET /readyz` (database writable, docs dir writable, migrations current) | Compose healthcheck, sidebar health line |

---

## 8. Seed data

`design/sample-data.json` is the prototype's dataset in shorthand. The seed loader (`docket seed sample`, or `DOCKET_SEED=sample` when the database is empty) maps it into the schema:

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
  - `imported` → `imported`, with a made-up `jira_key` (or `jira`, its own key; B35).
- **`detail{}`:**
  - `outcome`, `acceptance`;
  - `work` → `work_steps`: `s` is state, `t` text, `who`/`when` the state author and time, `was`/`why` the revision, `from` the review link, and `contrib` → `subagent_logs` as `[provenance, name, source, outcome]`; `details` and `source` → the step details (B35);
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

**The stress project (B35).** The prototype data has short, tidy titles and few labels, so two board bugs from the Gameflow pilot (cards overflowing, empty epic bars) passed CI. With `DOCKET_SEED_STRESS=1` (the e2e instance and CI set it), the sample seed also loads `STR`, generated by `server/src/db/seed/stress.ts` with a fixed-seed generator (deterministic, and the RCP and DOC rows are unchanged):

- 300 items: 10 epics and 290 tickets, in every status except Planning;
- titles of about 120 characters, some with one long unbroken URL or path;
- every seventh card has 6 to 8 labels, including names of up to 37 characters;
- epics with 0 children (STR-1 In progress, STR-6 Inbox), 1 child (STR-2), and 30 or more in mixed states (STR-3, STR-5); STR-4 is In progress with every child still to do;
- blocked chains (STR-160 → STR-161 → … → STR-164; five blockers on STR-170; STR-18 → STR-19 → STR-20);
- steps with long Markdown details (about 2,500 characters);
- imported items STR-201 … STR-210 (Jira keys STRESS-101 … STRESS-110) whose sub-task steps carry their own keys as `source`; STR-203's step "Prove SVG admission…" is STRESS-227.

It never needs the owner: no runs, questions, packets, Planning items, canceled blockers, cycles or dates on blocked items, so Needs you is the same with or without it.

---

## 9. Jira import

O05; owner decision 17 puts it in V1.

**Flow** (UI in UI_SPEC.md §9.2):
1. The owner enters the Jira site URL, account email, API token, Jira project key, and a target Docket project (new key and name, or an existing empty project).
2. **Dry run:** the server reads the Jira Cloud REST v3 API (search with JQL `project = X ORDER BY key`, then issue links, comments, attachments metadata and fields). It builds the mapped records **in memory** and produces a report. It writes nothing except the report.
3. The owner reviews the report, then *Import* commits everything in one transaction. Attachment bytes download after the commit, and failures are reported per file.
4. The API token is held in memory for the import session only (expires after 1 hour or on cancel). It's never stored, logged or written into the report.

**Signing in** (B32). Atlassian has three kinds of credential: a personal API token (id.atlassian.com → *Create API token*), a personal API token with scopes (*Create API token with scopes*), and an organization API key (admin.atlassian.com → organization → API keys). Only the first two can read Jira. Scoped tokens are refused (401) on the site itself and must go through Atlassian's gateway, `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/…`, with the same Basic credentials. Organization keys are for the admin APIs only and never work for the Jira REST API.

- **The site address** is normalised first, in the dialog and again on the server: `https://` is added when missing, and any path (`/jira/…`, `/browse/…`), query, fragment and trailing slash is dropped, leaving the origin. It must then be `https`, with no user name and a dotted host name.
- **The probe,** in this order, before anything is read:
  1. `GET <site>/_edge/tenant_info`, **without credentials**, for the site's `cloudId`. Unreachable, not JSON, or no `cloudId` → "Site not found: check the URL (https://yoursite.atlassian.net)." Nothing else is sent anywhere.
  2. `GET <site>/rest/api/3/myself` with Basic auth. **200** → a classic personal token; the session stays on the site.
  3. On a **401**, the same request through the gateway: `GET https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/myself`. **200** → a scoped token, and the session's base URL becomes the gateway for **every** later call: the project, fields, count, search, comments and attachment downloads (`/rest/api/3/attachment/content/<id>?redirect=false`, built from the attachment's ID under the base, so the bytes come with the same credentials). A full URL that isn't under the session's base is refused.
- **The error mapping:**

  | Result | Message |
  |---|---|
  | tenant info fails or has no `cloudId` | Site not found: check the URL (https://yoursite.atlassian.net). |
  | 200 on the site | (signed in: classic token, site base) |
  | 401 on the site, 200 on the gateway | (signed in: scoped token, gateway base) |
  | 401 on both, and the token looks like an organization key | That looks like an organization API key from admin.atlassian.com. Those can't read Jira. Create a personal API token at id.atlassian.com instead. |
  | 401 on both, otherwise | Wrong email or API token. The token must belong to <email>'s Atlassian account. |
  | 403 (sign-in, the project or a later read), or the gateway's 401 "Unauthorized; scope does not match" | Signed in, but this account can't browse that project (or the token's scopes don't include reading Jira work items). Through the gateway it adds: A scoped token needs the read:jira-work and read:jira-user scopes. |
  | 404 on the project | Project ABC not found or not visible to this account. |

  "Looks like an organization key" uses only what can be checked: a value starting `Bearer ` (organization keys are Bearer tokens), or the `ATCTT` prefix (Atlassian's admin and access keys; personal API tokens, scoped or not, start `ATATT`). Length alone doesn't tell them apart, since current personal tokens are long too.
- **Egress:** only the owner-entered site and `api.atlassian.com`. The e2e fixture answers under both names on the test network (its certificate covers both), and the no-egress allowance lists both (`jira-fixture.test,api.atlassian.com`).
- **The token** is still never logged, stored or echoed: messages name the email, never the token; the log line for a failed dry run gives only the error kind and status.

**Mapping** (what changes appears in the report as "Imported with changes", grouped by these rows):

| Jira | Docket | Changes |
|---|---|---|
| Epic | Epic | — |
| Story, Task, Bug | same type | — |
| Sub-task | Work step on the parent (decision 33; built in B34): text = the title (≤ 500), state from the status category (To Do → todo, In Progress → current, Done → done; no category → todo, noted), `source` = its key, and `details_md` = a header line, a blank line, then its description through the ADF converter. The header is `Jira GF-123 · assignee Sam Lee · start Nov 2, 2026 · due Dec 4, 2026 · 3 pts`, leaving out parts the sub-task doesn't have (dates as `Mon D, YYYY`; `1 pt`). The description follows the item rules: secret-looking text is dropped and listed, and it's shortened to fit the 10,000-character details limit with the header, and listed. What the conversion simplified is listed and also noted inline, as a last line `---` / `From Jira: panel simplified or dropped in the description`. A sub-task with nothing beyond its key has no details; otherwise `details_version` = 1. Its comments, under the imported-comment rules (secret-looking ones dropped, each shortened to 4,000 characters, all listed), go to the parent as owner notes: "Comments from Jira sub-tasks", one section per sub-task headed `GF-123 Title`, each comment as `author · YYYY-MM-DD` and its text, packed into notes of at most 4,000 characters, numbered "(1 of 2)" when split, a carried-over section repeating its heading with "(continued)", nothing cut. They're unread owner notes (the agent's next `get_item` delivers them), with `owner_note.added` events "Note imported from Jira: …". An import always targets a new or empty project, so they can't be added twice | Always "Imported with changes": "n sub-tasks → checklist steps on their parent. Kept: title, done or not done, description and dates (in the step’s details), comments (in a note on the parent). Not kept: attachments, labels and links on sub-tasks (each one lists what it had)." Each sub-task's reason lists its real losses (`not kept: 1 attachment, labels, links`); its description, comment and date notes group under those reasons. *By field* counts a sub-task's description, comments, assignee, dates and story points as mapped, and its attachments, labels, links and other fields as skipped. A sub-task whose parent isn't imported is **skipped**, with the reason |
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
| Assignee, reporter, sprint, fix version, components, other custom fields | not mapped (a sub-task's assignee is kept in its step's header line) | Yes: counts appear in the report |

Every imported item keeps `jira_key`, which search finds, and has `imported = true`. Cycles found in Jira links are imported as they are and show up under Problems.

**The report** (JSON, also rendered in the UI) contains:
- counts by type, mapped, skipped and lossy, per field;
- the list of lossy items with reasons;
- detected cycles;
- the attachments total size;
- **B32:** `groups`, the changed and skipped issues grouped by reason, in the mapping table's order. Each has `outcome` (`changed` | `skipped`), `reason` (`subtask`, `other_type`, `status`, `priority`, `parent`, `link_type`, `link_dropped`, `title`, `labels`, `description`, `comments`, `attachments`, `dates`; `skip_subtask`, `skip_secret`, `skip_no_summary`), `summary` ("42 sub-tasks → checklist steps on their parent"), `kept` and `not_kept` (whole sentences; null for skips), `count` and the `items` (key, title, that issue's details).

The UI never says "lossy" (B32): it shows a legend, **Imported as is**, **Imported with changes** and **Skipped (not imported, with the reason)**. The JSON keeps its field names: `totals.lossy`, `lossy_items` and the `lossy` columns count "Imported with changes", every sub-task included. The stored report adds `legend` with those three phrases. The commit button and the summary name both what is created: "Import 328 items and 57 checklist steps".

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
  - at 1024×900, on the sample screens and on the stress project's (§8, B35), no page scrolls sideways, no element is wider than its container unless something between them scrolls or clips, board cards keep their text inside, and progress fills have height;
  - the UI sweep (`pnpm sweep`, `docker/smoke/ui-sweep.mjs`, B35) runs clean against the disposable instance, sends no writes, and each of its checks fails on a page built to fail it (`--self-test`);
  - every visit starts at All projects (a new browser context sees scope All);
  - **notifications** (with the permission granted in the browser context): a new packet and a new question each produce exactly one notification, a click opens the right place, the tab title shows `(N) Docket`, and already-pending items don't notify on load;
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
| M0 | Workspace scaffold, lint, typecheck, Vitest, Dockerfile, compose, `/healthz` and `/readyz`, and the GitHub Actions CI workflow (§2 Stack) | `docker compose up` serves "Docket is running"; the CI check is green on the M0 PR, and Mergify waits for it |
| M1 | Schema and migrations, domain services for §5 (including `satisfied_when`, decision records and the context bundle), event log, idempotency, undo, seed loader | Unit tests for every §5 rule pass; the seed loads deterministically |
| M2 | MCP server per [MCP_SPEC.md](MCP_SPEC.md): auth, Host/Origin guards, identity, server instructions, all 48 tools and the `onboard` prompt, with the exact description text, compact text rendering, structured errors, sweeper, restart handling | The MCP_SPEC §10 contract tests pass, including the description snapshot and token budgets; two simultaneous SDK clients work |
| M3 | Owner session and CSRF, UI API (§7, including owner text edits and the diagnostic log), SSE stream | API contract tests pass; the unlock flow works |
| M4 | Web shell, tokens, Needs you, Work board and list, ticket and epic pages (four tabs, checklist editing, Decisions sections), open-item tabs, palette, quick capture | The e2e groups for Needs you, Tickets and epics, and Shell pass |
| M5 | Packet screen and decisions, deferrals, questions and notes, archive, undo toasts, inline editing, desktop notifications and the tab-title count | The e2e groups for Packets and Work (archive) pass |
| M6 | Progress map (epic, label, Work → Map), Timeline, Label pages (with Decisions), Agents, Settings (including blocker rules and project decisions), document viewer | The e2e groups for Map, Labels and cross-cutting pass |
| M7 | Burn-down and forecast, Jira import (dry run and import), backup/restore CLI, delete project. Stretch: `docket export` | Unit tests for forecast and mapping pass; a dry run against a test Jira project produces a report |
| M8 | O07 smoke with real clients, an accessibility pass, dark mode and 1024 px checks, a README quick start | The smoke matrix is filled in; axe is clean; the README walks through from an empty machine to a connected agent in under 10 minutes |

---

## 12. Things to verify during the build

These can't be settled on paper. Each one has a default already, so none of them blocks starting.

| # | Question | Default until verified | Where |
|---|---|---|---|
| V1 | Do Codex and Claude Code keep their MCP session open, and do they answer server `ping`? This decides whether *live* is reachable or every run shows as *reported*. | The §5.4 rules. If pings aren't answered, *live* relies on requests alone, and the UI is still truthful. | M2, M8 |
| V2 | Does an Orca worker running Claude inherit the user's MCP configuration? (The Codex one was verified in discovery.) | Show "Not verified" in Settings until the smoke test passes. | M8 |
| V3 | Client config. Checked against the docs on 2026-11-07 (MCP_SPEC §11): Codex `bearer_token_env_var` and the Claude `mcp add --transport http --header` form are confirmed. Still open: whether Claude expands `${DOCKET_TOKEN}` in user-scope config (it does in a project's `.mcp.json`). | Use the user-scope `mcp add` form, which stores the expanded token. | M8 |
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
| V3 | **Partly; owner to verify** | `"Authorization": "Bearer ${DOCKET_TOKEN}"` in an `--mcp-config` file (the `.mcp.json` format) is expanded from the environment. Still open: what user scope (`claude mcp add --scope user`) stores. |
| V4 | **Fixture only** | Field-ID detection (start date, story points) is verified against the synthetic Jira fixture (`docker/compose.jira-fixture.yaml`, B17), not a real Jira site. The dry-run report shows which field was used. Owner: a dry run on their own site before the pilot (ROADMAP §1.4). |
| V5 | **Verified** | SQLite WAL on a Docker Desktop named volume on Windows: in the container's call log, every write tool had p50 ≈ 1 ms and p95 ≤ 5 ms over 280 writes. At scale (20 projects, 5,000 items, 100,000 events) every owner view rendered in under 1 s against the container (T143). The named volume stays. |
| V6 | **Resolved by owner decision 28 (B19): text-only results for Claude Code** | B18 found, from the stream-json transcripts of headless Claude Code 2.1.318, that the model's tool result is the `structuredContent` JSON, not the text block: on typical reads about 3.5× the compact text's tokens (6,494 against 1,836 over eight calls; a 25-item search 2,045 against 325). So clients that do this now get text-only results: no `outputSchema`, no `structuredContent` (MCP_SPEC §3 Results). Claude Code sends `clientInfo.name` `claude-code`, the default of `DOCKET_TEXT_ONLY_CLIENTS` (§2). Measured in B19 with headless Claude Code 2.1.318 (sonnet) on a throwaway instance, through the SC-001 opening (`search_items`, `claim_lead`, `get_context` on RCP-17): from Claude Code's usage, the three results added 1,246 tokens to the model's context before and 659 after, per-call framing included; the results themselves fell from 2,219 characters of JSON (≈ 555 tokens) to 944 of compact text (≈ 236), the text-block budget. Codex: still to verify which part it forwards; it stays structured until then. |
| V7 | **Partly; owner to verify** | Claude Code loads skills from a project's `.claude/skills/` (the B18 eval: `docket-worker` and `docket-coordinator` invoked headless). Still open: `~/.claude/skills/`, Codex's paths, and whether Orca workers see user-wide skills. |

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
| 18 **(owner)** | Docket coordinates; it doesn't dispatch. Orca, or the owner, starts agents (decision 2 reaffirmed after the 2026-11-14 "control plane" review). Revisit after the pilot (ROADMAP.md). | §1 |
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
| 26 **(owner)** | Recovery support: runs record their workspace, orchestrator IDs, brief and declared resources; runs can park; `recovery_report` gives the restart list; Problems flag orphaned resources and unpushed work. Prompted by an Orca crash that pruned worktrees holding in-flight work. Docket records; the coordinator acts. | §5.16, MCP_SPEC §3 and §5.9 |
| 27 **(owner)** | Ship five agent skills as plain files in `skills/`: `docket-worker` and `docket-coordinator` (core), `docket-planner`, `docket-review-packet` and `docket-lead-subagents` (optional). They teach workflow, never restate schemas, and are lint-checked against the tool contract in CI. Owners may edit them. Serving them as MCP prompts is on the roadmap. | `skills/README.md`, ROADMAP §2 |
| 28 **(owner)** | Per-client result modes: clients known to give the model `structuredContent` (by default Claude Code, `clientInfo.name` `claude-code`) get text-only results, with no `outputSchema` and no `structuredContent`, so the model reads the complete compact text; every other client keeps structured output. Configured by `DOCKET_TEXT_ONLY_CLIENTS`. Resolves V6. | §2 Configuration, §12 V6, MCP_SPEC §3 Results and §11 |
| 29 **(owner)** | Help center and agent setup: Help articles in the app; the agent files (skills and AGENTS.md block) viewable and editable in three layers (bundled, service-wide, per project) with history; per-project Workflow notes in `get_context`; install by copy-paste command or opt-in push into a mounted host folder; every install logged with exact versions, and installed copies checked for local edits. Serving the files over MCP stays on the roadmap. | §5.17, §5.18, §7, UI_SPEC §6.10–6.11 |
| 30 **(owner)** | Agents change agent files only by proposing (`get_agent_files`, `propose_agent_file_change`); the owner approves, edits or declines, with proposer and approver recorded. Drift detection for edits made outside Docket: scheduled checks of push installs, and instruction hashes agents report on `claim_lead`; drift shows as a Problem with *Adopt*, *Restore* and *Keep local*; runs record their instruction versions. | §5.19, MCP_SPEC §5.10, UI_SPEC §6.7b |
| 31 **(owner)** | Onboarding without installed files: *New project* in Settings; the MCP tools `onboard_project` (create or adopt, returning the guide) and `finish_onboarding`; the editable onboarding guide, also served as the first MCP prompt; reconcile-before-create with imported Jira items; everything created in Planning; one review card with *Install agent files*. Agents can't change project settings or delete projects. | §5.20, MCP_SPEC §5.11, UI_SPEC §6.7d |
| 32 **(owner)** | Local trust by default: no owner unlock and no agent token; Host and Origin guards kept; owner actions record browser or script. Opt-in protected mode restores both. The install writes secret-free project connection files (`.mcp.json`, `.codex/config.toml`), so connecting needs no commands. Supersedes the default-on parts of decision 16 and T2. | §3, §5.17a, constitution VI (v1.2.0) |
| 33 **(owner)** | Checklist steps carry `details_md` and `source`; a step dialog in the UI (no inline expansion); agents read one step in full with `get_step`, and item reads show a marker; the Jira import keeps sub-task descriptions in step details and collects their comments in one note on the parent. | §4, §5.5, §9, MCP_SPEC §4, §5.5, UI_SPEC §6.3.1a |
| 34 **(owner)** | Install and onboarding follow-ups from the Gameflow pilot: one install for several clients (checkboxes, defaults from the repo's markers, one summary; the API's `clients`, with `client` still accepted); each client's install state (up to date, update available, changed outside Docket, not installed) from the manifest and drift, with nothing new stored; a new `CLAUDE.md` imports an existing `AGENTS.md` with `@AGENTS.md`; the MCP tool `apply_batch` (up to 100 operations, atomic per operation) for large onboardings; agents may add details to steps imported from Jira. | §5.5, §5.17b, §5.20, §7, MCP_SPEC §5.5, §5.13, UI_SPEC §6.7b |
| 35 **(owner)** | Approve with notes: *Looks good* takes an optional note and `keep` (`item`, `epic` or `project`). The note is stored on the verdict and posted as an owner note; kept for the epic or the project it also becomes an owner decision there (title from the note, "From your review of …" rationale), in the same transaction, so Undo reverts it. *Needs changes* and *Defer* are unchanged. | §5.6, §5.14, UI_SPEC §6.4 |
| 36 **(owner)** | Shared changes and conflict guardrails: shared-part registry and per-item declarations (required for Ready); overlap check at claim (`seam_conflict`) with an owner question (sequence or compatible); single-writer leases; changed-file check at hand-off; a read-only conflict radar (git merge-tree with a temporary object directory); in-flight declarations in `get_context`. | §5.21, MCP_SPEC §5.15, UI_SPEC §6.3.6, §6.1 |
| R1 **(owner)** | The product is renamed Docket (formerly Task Lite; B28), mechanically: packages, CLI, `DOCKET_*` settings, MCP server name, Docker image, container and volume, skills, markers and manifest. Old names keep working: `TASKLITE_*` settings with a warning, the old markers and manifest, `skill:tasklite-*` keys, old backups and the old database file name. The one deletion is old skill folders Docket installed and recorded, when unmodified. The GitHub repo URL is unchanged. | §5.17 |
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
