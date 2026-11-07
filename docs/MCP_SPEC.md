# Task Lite: MCP spec

Status: ready to build, 2026-11-07. This is the complete agent-facing contract: connection, conventions, the server instructions, every tool's description text and schemas, errors, and worked flows. [BUILD_SPEC.md](BUILD_SPEC.md) §5 defines the rules these tools enforce. Where the two disagree on a schema, this file wins; on a rule, BUILD_SPEC wins.

**Agents are the primary users of Task Lite.** The tool descriptions and server instructions below are the only manual most agents will ever read, so treat them as product copy:
- **Implement them verbatim.**
- **Change them deliberately:** edit this file first, and keep the contract tests in §10 in step with it.

Companion template: [templates/AGENTS-tasklite.md](templates/AGENTS-tasklite.md) is the block each project pastes into its `AGENTS.md` or `CLAUDE.md`.

---

## 1. Connection

| | |
|---|---|
| Endpoint | `http://127.0.0.1:7420/mcp` |
| Transport | MCP Streamable HTTP, protocol version per the SDK's latest stable. Stateful sessions (`Mcp-Session-Id`). The server accepts `GET` for the server→client stream and `DELETE` to end a session. |
| Auth | `Authorization: Bearer <TASKLITE_TOKEN>`. A missing or wrong token gets HTTP 401 before any MCP handling. |
| Server info | `name: "tasklite"`, `version` = the app version |
| Capabilities | `tools` (with `listChanged: false`). No resources or prompts in V1. Everything an agent needs comes from tools, and the server instructions point to the tools. |
| Client identity | `clientInfo.name` from `initialize`, normalised (BUILD_SPEC §3). Agents add `agent_label` on `claim_lead` and `start_run`. |
| Liveness | The server pings each session that has an open run every 60 s. Answering pings is what lets a run show as *live* (BUILD_SPEC §5.4). |

Client setup commands are in §11.

---

## 2. Server instructions

The server returns this text as `instructions` in the `initialize` result. Clients show it to the model as standing guidance. Implement it verbatim, substituting nothing.

```
Task Lite is the owner's work tracker. Use it to find work, record your plan and progress, and hand finished work to the owner for review. The owner reads it in a web UI; keep entries short and factual.

Workflow: Inbox → Planning → Ready → In progress → Review → Done.
- Only start work that is Ready (search_items filter "ready_to_start") or was sent back to you (filter "resumable"). Claim it first with claim_lead; if someone else holds it, pick something else.
- Planning belongs to the owner. You may draft planning documents (put_document) and move an item to Ready only when the project's workflow (AGENTS.md / CLAUDE.md) says you may.
- Your plan is the item's checklist, not new tickets: set_plan with one-line steps, update_step as you go. Split work into a new Story or Task only when a step needs its own blocker, owner or review.
- Record what you verify yourself with set_checks. Record subagent work with log_subagent; say whether you observed it or are relaying it.
- If the owner must verify something by hand, declare it with declare_human_review, ideally during Planning. The item cannot close while any human review item is undecided.
- Report each commit for the item it belongs to (report_commit). When the work is built and your checks pass, hand off with submit_packet. If there is no human review, close it with set_status "done".
- If you need a decision from the owner, ask_owner and stop; the answer arrives in get_item.
- Pass run_id on every call while you are working; it keeps your claim alive and shows you as live. Call finish_run when you stop.
- Read get_item before you start and after any pause: it includes the owner's notes, answers and review decisions.

Errors are structured (code: validation | conflict | not_found | forbidden | unavailable | internal). On conflict, read the current state in the error and retry only if your change still makes sense.
```

---

## 3. Conventions

### IDs
| Object | Format | Example |
|---|---|---|
| Item | `<PROJECT>-<n>` | `RCP-14` |
| Project | 2–5 uppercase letters | `RCP` |
| Work step, check, human review item, run, question, link, document, document version, packet, event cursor | Prefix + ULID: `wst_`, `chk_`, `hr_`, `run_`, `q_`, `lnk_`, `doc_`, `dv_`, `pkt_`. Cursors are opaque strings. | `hr_01JC9V…` |

### Types
- **Time:** ISO-8601 UTC strings. Dates (`planned_start`, `planned_end`) are `YYYY-MM-DD`.
- **Text:** plain text, except fields named `*_md`, which are Markdown. Trim whitespace. Length limits:

  | Field | Limit |
  |---|---|
  | `title` | 200 |
  | step, check and human review item text | 500 |
  | `note`, `outcome` (summary lines) | 4,000 |
  | `question` | 2,000 |
  | `description_md`, `outcome_md` | 20,000 |
  | `brief_md` | 10,000 |

  Over the limit returns `validation`.
- **Enums** are lowercase snake_case strings:

  | Enum | Values |
  |---|---|
  | `status` | `inbox`, `planning`, `ready`, `progress`, `review`, `done`, `canceled` |
  | `type` | `Epic`, `Story`, `Task`, `Bug` |
  | `priority` | 1 (high), 2, 3 |
  | `run_state` (derived) | `live`, `reported`, `stale`, `needs_input`, `failed`, `finished`, `interrupted` |
  | `provenance` | `agent` (you assert it), `observed` (a child run you started produced it), `relayed` (you are passing on what a subagent told you), `ci` |

### Versions
Items and human review items carry `version`. Mutating tools that change an item accept `expected_version`.
- **When you pass it** and it doesn't match, the call returns `conflict`, with the current record in `current`.
- **When you omit it,** the change applies on top of the current state. Use this only for additive changes: notes, logs, commits, heartbeats.

### Idempotency
Every mutating tool accepts `idempotency_key` (≤ 100 characters, unique per logical operation, kept 24 h).
- **Same key, same arguments:** returns the original result, marked `"replayed": true`.
- **Same key, different arguments:** returns `validation`.
- **Use one** for anything you might retry after a timeout.

### Runs as signals
Pass `run_id` on every call you make while working.
- **What it does:** renews your lead lease and keeps you *live*.
- **Calls without it** are attributed to your client but don't touch any run.

### Pagination
List tools return `{ items|events: [...], next_cursor: string|null }`. Pass `cursor` to continue. `limit` defaults to 25, and the maximum is 50 (200 for `get_changes`).

### Tool annotations
These are MCP hints:

| Tools | Hint |
|---|---|
| Read tools | `readOnlyHint: true` |
| `get_item` | `readOnlyHint: false`, because it marks owner notes and answers as delivered |
| Retry-safe mutating tools: `heartbeat`, `report_commit`, `update_step`, `update_check` | `idempotentHint: true` |
| None | `destructiveHint` (agents can't delete) |

### Results
Every tool returns `structuredContent` matching its output schema, plus one `text` content block holding a one-line summary (for example "Claimed RCP-14 as lead (run_01J…); lease until 12:02 UTC."). Clients that ignore structured content still get something useful.

---

## 4. Shared types

TypeScript notation. The zod source of truth lives in `shared/`.

```ts
type ItemSummary = {
  id: string; project: string; type: 'Epic'|'Story'|'Task'|'Bug'; title: string;
  status: Status; priority: 1|2|3; epic: string|null; labels: string[];
  blocked: boolean; blocked_by: string[];            // unresolved blockers only
  lead: { client: string; label: string|null; run_id: string; run_state: RunState } | null;
  human_review: { declared: number; ready: number; approved: number; deferred: number };
  planned_start: string|null; planned_end: string|null; effort: number|null;
  archived: boolean; jira_key: string|null; version: number; updated_at: string;
};

type Item = ItemSummary & {
  description_md: string; outcome_md: string; acceptance: string[];
  links: { blocks: LinkRef[]; blocked_by: LinkRef[]; relates: LinkRef[] };
  checklist: {
    plan_version: number;
    work: WorkStep[]; checks: Check[]; human_review: HumanReviewItem[];
    reviewed_with_epic: string|null;                  // epic id when this item has none and its epic does
  };
  runs: Run[];                                        // open runs first, then the last 5 ended
  open_question: Question|null;
  unread_owner_notes: { id: string; text: string; at: string }[];   // returned once, then marked read
  documents: { document_id: string; name: string; kind: DocKind; latest: DocVersionRef }[];
  packets: { packet_id: string; round: number; state: 'open'|'decided'|'withdrawn'; stale: boolean; built_from_commit: string; created_at: string }[];
  commits: { sha: string; branch: string|null; at: string }[];     // newest first, max 20
  artifacts: { kind: string; label: string; url: string|null; state: string|null }[];
  dates_set_by: string|null; closed_by: 'owner'|'agent'|'imported'|null;
  recent_events: EventRow[];                          // 20 newest
};

type LinkRef = { link_id: string; id: string; title: string; status: Status; project: string };
type WorkStep = { id: string; text: string; state: 'todo'|'current'|'done'|'blocked'|'skipped';
  was_text: string|null; change_reason: string|null; added_by: 'owner'|'agent';
  from_review: { round: number; hr_item_id: string } | null;
  subagents: { name: string; outcome: string; evidence: string|null; provenance: 'observed'|'relayed'; child_run_id: string|null; at: string }[];
  state_by: string|null; state_at: string|null };
type Check = { id: string; text: string; state: 'todo'|'pass'|'fail'|'skipped'; evidence: string|null;
  provenance: 'agent'|'observed'|'relayed'|'ci'; added_by: 'owner'|'agent' };
type HumanReviewItem = { id: string; text: string; state: 'declared'|'ready'|'approved'|'deferred';
  added_by: 'owner'|'agent'; locked: boolean; version: number;
  last_decision: { kind: 'approve'|'changes'|'defer'; note: string|null; round: number; at: string; result_ref: string|null } | null;
  follow_up_item_id: string|null };
type Run = { run_id: string; parent_run_id: string|null; client: string; label: string|null; is_lead: boolean;
  run_state: RunState; started_at: string; last_signal_at: string; lease_expires_at: string|null;
  current_step_id: string|null; summary: string|null; error: string|null };
type Question = { id: string; text: string; asked_at: string; answer: string|null; answered_at: string|null };
type DocKind = 'planning'|'packet_attachment'|'import_report'|'other';
type DocVersionRef = { document_version_id: string; version_no: number; mime: string; size: number; sha256: string; created_at: string; created_by: string };
type EventRow = { cursor: string; at: string; actor: string; item_id: string|null; type: EventType; summary: string };
type EventType =
  | 'item.created' | 'item.updated' | 'item.status_changed' | 'item.archived' | 'item.unarchived'
  | 'link.added' | 'link.removed' | 'label.upserted'
  | 'plan.updated' | 'step.updated' | 'subagent.logged' | 'checks.updated' | 'check.updated'
  | 'human_review.declared' | 'human_review.updated' | 'human_review.removed'
  | 'claim.granted' | 'claim.rejected' | 'claim.released' | 'run.started' | 'run.ended'
  | 'packet.submitted' | 'packet.stale' | 'packet.withdrawn' | 'review.decided'
  | 'question.asked' | 'question.answered' | 'owner_note.added' | 'note.added'
  | 'document.added' | 'commit.reported' | 'artifact.linked';

type ToolError = { code: 'validation'|'conflict'|'not_found'|'forbidden'|'unavailable'|'internal';
  message: string; details?: Record<string, unknown>; current?: unknown };
```

---

## 5. Tools

The format for each tool below:
- **Description:** the exact `description` string to register;
- **Input:** fields, where `?` means optional; `run_id?` and `idempotency_key?` are accepted by every mutating tool and not repeated;
- **Output** and **Errors**;
- notes, where needed.

### 5.1 Orientation

#### `whoami`
**Description:** "Check your connection to Task Lite. Returns how the server identifies you, server limits and the server time. Call it once at the start of a session."
- **Input:** none.
- **Output:** `{ client, session_id, server_version, server_time, limits: { page_max: 50, changes_max: 200, document_mcp_bytes: 26214400, text_limits: {...} }, live_window_s, stale_after_s, lease_s }`.

#### `list_projects`
**Description:** "List projects with item counts. Use the project key when creating items or searching."
- **Input:** none.
- **Output:** `{ projects: [{ key, name, counts: { open, ready_to_start, in_progress, review, blocked } }] }`.

### 5.2 Finding work

#### `search_items`
**Description:** "Find items. Filters: ready_to_start (Ready, unblocked, unclaimed: what you may start), resumable (In progress with no lead, usually sent back by the owner's review: resume it), blocked, waiting_for_review (handed off, waiting on the owner), mine (items you lead), deferred_review (owner deferred a check; cleanup). Combine with project, status, type, label, epic or text. Results are summaries; call get_item for details."
- **Input:** `project?`, `text?` (matches ID, title, description, labels and Jira key), `filter?`, `status?: Status[]`, `type?: Type[]`, `label?`, `epic?`, `include_archived?: boolean = true`, `cursor?`, `limit?`.
- **Output:** `{ items: ItemSummary[], next_cursor }`. See the sort-order note below.
- **Errors:** `validation` (unknown filter or value).
- **Note on sort order:** `ready_to_start` sorts by priority, then by the number of items it would unblock (most first), then by ID. Every other filter sorts by priority, then `updated_at` ascending.
- **Note on `mine`:** items where an open lead run belongs to the caller's client and `agent_label`. Pass `agent_label` to narrow it; otherwise every run from the client matches.

#### `get_item`
**Description:** "Get one item in full: description, acceptance criteria, blockers, checklist (your plan, your checks, human review), runs, the open question and its answer, the owner's unread notes, documents, packets and recent activity. Owner notes and answers are returned once and then marked as delivered, so read them now. Call this before starting and after any pause."
- **Input:** `id`, `agent_label?` (used to attribute delivery).
- **Output:** `{ item: Item }`.
- **Errors:** `not_found`.

#### `dependency_subgraph`
**Description:** "Show what blocks an item and what it blocks, with each item's status and planned dates. Set delay_days to see which downstream items a slip would push past their planned start."
- **Input:** `id`, `depth?: 1–5 = 2`, `direction?: 'up'|'down'|'both' = 'both'`, `delay_days?: number`.
- **Output:** `{ nodes: [{ id, title, status, blocked, planned_start, planned_end, date_source: 'entered'|'none', effort }], edges: [{ from, to, type: 'blocks' }], cycles: string[][], at_risk: [{ id, reason }] }`. `at_risk` lists items whose `planned_start` falls before a blocker's `planned_end`, after applying `delay_days` to the root.

#### `deferred_reviews`
**Description:** "List human review checks the owner deferred (not verified), with any follow-up test ticket and its status. Use during cleanup: finish the check, or propose a plan in a note."
- **Input:** `project?`, `cursor?`, `limit?`.
- **Output:** `{ items: [{ item_id, title, hr_item_id, text, note, deferred_at, follow_up: { id, status }|null }], next_cursor }`.

#### `get_changes`
**Description:** "Poll for changes since a cursor instead of re-reading items. Start without a cursor to get the latest cursor, then pass next_cursor each time. Watch for review.decided, question.answered and owner_note.added on items you work on."
- **Input:** `cursor?`, `project?`, `item_id?`, `types?: EventType[]`, `limit?: ≤200 = 100`.
- **Output:** `{ events: EventRow[], next_cursor }`. With no cursor: `{ events: [], next_cursor: <latest> }`.

### 5.3 Creating and editing items

#### `create_item`
**Description:** "Create an Epic, Story, Task or Bug. New items start in Inbox (or Planning if you are shaping it now). Put small steps in an item's checklist with set_plan rather than creating tickets for them."
- **Input:** `project`, `type`, `title`, `description_md?`, `outcome_md?`, `acceptance?: string[]`, `priority?: 1|2|3 = 2`, `epic?` (an Epic in the same project), `labels?: string[]` (created if missing), `status?: 'inbox'|'planning' = 'inbox'`, `planned_start?`, `planned_end?`, `effort?: number ≥ 0`, `blocked_by?: string[]` (creates `blocks` links; cycle-checked).
- **Output:** `{ item: ItemSummary }`.
- **Errors:** `validation` (bad epic, wrong project, cycle, limits), `not_found` (project).

#### `update_item`
**Description:** "Edit an item's fields. Pass expected_version from your last read. Dates you set are labelled as set by you. To change status use set_status; to change the plan use set_plan."
- **Input:** `id`, `expected_version`, and any of `title`, `description_md`, `outcome_md`, `acceptance`, `priority`, `epic` (`null` clears it), `labels` (replaces the set), `planned_start`, `planned_end` (`null` clears), `effort` (`null` clears).
- **Output:** `{ item: ItemSummary }`.
- **Errors:** `conflict` (version), `validation`.

#### `set_status`
**Description:** "Move an item to another status. Allowed moves: inbox→planning; planning↔ready; ready→progress; progress→ready (gives up the work); progress or review→done (only when no human review item is undecided); any open status→canceled (reason required); done→progress (reopen, reason required). Use submit_packet, not set_status, to hand off for review."
- **Input:** `id`, `status`, `expected_version?`, `reason?` (required for canceled and reopen).
- **Output:** `{ item: ItemSummary }`.
- **Errors:**
  - `validation`, with `details.allowed: Status[]` and `details.reason`, for example "2 human review items are undecided: hr_…, hr_…";
  - `conflict`.
- **Notes:** Moving to `done` ends your open lead run as `finished` if you haven't. Moving to `progress` doesn't claim the item; use `claim_lead`.

#### `link_items`
**Description:** "Link two items. type 'blocks' means from must finish before to can start; 'relates' is informational. A link that would create a dependency cycle is rejected with the cycle path."
- **Input:** `from`, `to`, `type: 'blocks'|'relates'`.
- **Output:** `{ link_id, from, to, type }`.
- **Errors:** `validation` (cycle: `details.cycle: string[]`; self-link), `not_found`.

#### `unlink_items`
**Description:** "Remove a link between two items."
- **Input:** `link_id` or (`from`, `to`, `type`).
- **Output:** `{ removed: true }`.
- **Errors:** `not_found`.

#### `upsert_label`
**Description:** "Create a label or update its brief. Use a label for an initiative that spans several epics; the brief holds the shared decisions."
- **Input:** `project`, `name` (lowercase, `a-z0-9-`, ≤ 40), `brief_md?`.
- **Output:** `{ project, name, brief_md }`.

### 5.4 Claiming and runs

#### `claim_lead`
**Description:** "Claim an item as its lead before you work on it. Works on Ready items (moves them to In progress) and on In progress items with no lead (resuming sent-back work). Returns your run_id: pass it on every later call. If someone else holds the claim you get a conflict with who holds it and until when; do not work on the item."
- **Input:** `id`, `agent_label?` (≤ 40, for example `orca-w3`).
- **Output:** `{ run_id, item: ItemSummary, lease_expires_at }`.
- **Errors:**
  - `conflict` with `current: { lead_client, lead_label, run_id, last_signal_at, lease_expires_at }`, recorded as a rejected claim the owner can see;
  - `validation`: the status isn't ready or progress, or the item is blocked (`details.blocked_by`).

#### `release_lead`
**Description:** "Give up the lead claim without finishing, for example when you are stopping before the work is done. The item returns to Ready so another agent can pick it up; your plan and notes stay."
- **Input:** `id`, `run_id`, `reason`.
- **Output:** `{ item: ItemSummary }`.
- **Errors:** `forbidden` (not your run), `not_found`.

#### `start_run`
**Description:** "Start a child run under your lead run when you delegate to a subagent that has its own Task Lite connection. The subagent passes the child run_id on its calls. For subagents without their own connection, use log_subagent instead."
- **Input:** `id`, `parent_run_id`, `agent_label?`.
- **Output:** `{ run_id }`.
- **Errors:** `validation` (the parent isn't an open lead run on this item).

#### `heartbeat`
**Description:** "Tell Task Lite you are still working when you have nothing else to record. Any call with run_id does the same, so you rarely need this. Optionally set your current step."
- **Input:** `run_id`, `current_step_id?`, `note?` (short; shown as the run's "doing" line).
- **Output:** `{ run_state, lease_expires_at }`.
- **Errors:** `not_found`, `conflict` (the run has ended: lease expired or released; `current` holds the item's lead).

#### `finish_run`
**Description:** "End your run. result 'finished' when you stopped normally, 'failed' with an error when something broke. Finishing a lead run releases the claim but does not change the item's status: hand off with submit_packet or close with set_status first."
- **Input:** `run_id`, `result: 'finished'|'failed'`, `summary` (≤ 500), `error?` (≤ 4,000; shown monospaced).
- **Output:** `{ run_state }`.
- **Note:** A failed lead run leaves the item In progress with no lead. The owner sees it under Problems and can *Return to Ready*.

### 5.5 Checklist

#### `set_plan`
**Description:** "Publish or revise your plan as one-line work steps. Send the whole list: steps with an id keep their identity (changing text records the old text and your reason), steps without an id are new, and agent steps you omit are removed. Owner-added steps are always kept. Every revision is kept as history."
- **Input:**
  - `id`, `reason` (required unless this is the first plan);
  - `steps: [{ id?, text, state?: StepState = 'todo', change_reason? }]` (≤ 30 steps).
- **Output:** `{ plan_version, work: WorkStep[] }`.
- **Errors:** `validation` (limits, unknown step id).

#### `update_step`
**Description:** "Update one work step's state as you go: current when you start it, done when finished, blocked or skipped with a note."
- **Input:** `id`, `step_id`, `state`, `note?` (required for blocked and skipped).
- **Output:** `{ step: WorkStep }`.

#### `log_subagent`
**Description:** "Record what a subagent contributed, as a short line under the step it worked on. provenance 'observed' if you saw its run or output directly, 'relayed' if you are passing on its report. This never creates a ticket."
- **Input:** `id`, `step_id?`, `name` (≤ 60), `outcome` (≤ 500), `evidence?` (≤ 500), `provenance`, `child_run_id?`.
- **Output:** `{ logged: true }`.

#### `set_checks`
**Description:** "Publish what you will verify yourself (tests, measurements, reviews), with state and evidence. Send the whole list, as with set_plan; owner-added checks are always kept."
- **Input:** `id`, `checks: [{ id?, text, state?: 'todo'|'pass'|'fail'|'skipped' = 'todo', evidence?, provenance?: Provenance = 'agent' }]` (≤ 30).
- **Output:** `{ checks: Check[] }`.

#### `update_check`
**Description:** "Update one check's state and evidence, for example when tests pass."
- **Input:** `id`, `check_id`, `state`, `evidence?`, `provenance?`.
- **Output:** `{ check: Check }`.

#### `declare_human_review`
**Description:** "Declare what the owner must verify by hand before this item can close, one plain instruction per item ('On your phone, drag a recipe between days. Does it feel right?'). Declare early, usually during Planning. For work shipped as one PR across an epic, declare it once on the epic instead of on each child. With no human review items, you may close the item yourself once your checks pass."
- **Input:** `id`, `items: string[]` (1–10, each ≤ 500).
- **Output:** `{ human_review: HumanReviewItem[] }`.

#### `update_human_review`
**Description:** "Edit or remove a human review item you declared. Items in an open packet are locked, and items the owner added can only be changed by the owner."
- **Input:** `id`, `hr_item_id`, `expected_version`, `text?` or `remove?: true`.
- **Output:** `{ human_review: HumanReviewItem[] }`.
- **Errors:** `forbidden` (owner-added or locked), `conflict`.

### 5.6 Evidence

#### `add_note`
**Description:** "Add a short progress note or comment to the item's activity. Use it for decisions you made, surprises and anything the owner should know. Keep it to a sentence or two."
- **Input:** `id`, `text` (≤ 4,000).
- **Output:** `{ event: EventRow }`.

#### `put_document`
**Description:** "Store a document on an item (or a project): planning docs (PRD, UX, TDD), packet attachments such as screenshots, or other files. Uploading the same name again creates a new version. Send Markdown or text as content_text; binary files as content_base64 (up to 25 MB; larger files: POST to /agent-upload and pass the returned document_version_id)."
- **Input:** `item_id?` or `project`, `name` (a file name, ≤ 120), `kind: 'planning'|'packet_attachment'|'other'`, `content_text?` or `content_base64?`, `mime?` (guessed from the name if omitted).
- **Output:** `{ document_id, version_no, document_version_id, sha256, size }`.
- **Errors:** `validation` (size, missing content).
- **Large files:** `POST /agent-upload` (multipart, bearer auth; fields `item_id` or `project`, `name`, `kind`, `file`) returns the same output. 500 MB maximum.

#### `link_artifact`
**Description:** "Link external evidence: a PR, CI run, deployment, test report or URL. A link is evidence, never approval."
- **Input:** `id`, `kind: 'pr'|'ci'|'deploy'|'test'|'url'`, `label` (≤ 120), `url?`, `state?` (for example `passed`, `merged`).
- **Output:** `{ artifact }`.

#### `report_commit`
**Description:** "Report a commit for the item it belongs to. Report every commit you make for an item, including fixes after a review. If a handoff packet was built from an older commit, it is marked out of date for the owner automatically."
- **Input:** `id`, `sha` (7–40 hex), `branch?`, `message?` (first line, ≤ 200), `pr_url?`.
- **Output:** `{ recorded: true, stale_packets: [{ item_id, packet_id, round }] }`.
- **Note:** Reporting the same SHA for the same item again is a no-op.

### 5.7 Review and the owner

#### `submit_packet`
**Description:** "Hand finished work to the owner for human review. Call it when the work is built, your checks pass and everything is committed and reported. The packet must let the owner verify without asking you anything: what to check, exact steps (URLs, builds, commands), what you already verified and how, known gaps, and attachments. The item moves to Review; read the decision later with get_review or get_item."
- **Input:**
  - `id`, `built_from_commit` (recorded with `report_commit` if not already), `estimate` (for example `"10 min"`);
  - `hr_item_ids?` (defaults to every declared item);
  - `how: string[]` (1–15 steps);
  - `checked: [{ text, provenance, evidence }]`;
  - `gaps?: string[]`;
  - `attachments?: [{ document_version_id, caption? }]`.
- **Output:** `{ packet_id, round, display_id: 'pkt-9c0e', item: ItemSummary }`.
- **Errors:** `validation`:
  - no declared human review items, so close with `set_status` instead;
  - a packet is already open;
  - a failed agent check exists without a gap explaining it;
  - the item is blocked.
- **Notes:**
  - Submitting doesn't end your run. Usually you call `finish_run` next and stop.
  - On an epic, this submits an epic-level packet.

#### `get_review`
**Description:** "Read the owner's review decisions for an item, round by round. 'changes' notes say what to fix; each became a checklist step or a new Bug (see result_ref). Approved items stay approved in later rounds. Deferred items are not verified; leave them alone unless you are doing cleanup."
- **Input:** `id`.
- **Output:** `{ rounds: [{ packet_id, round, state, stale, built_from_commit, submitted_at, decided_at, items: [{ hr_item_id, text, decision: { kind, note, into, follow, result_ref }|null }] }] }`.

#### `ask_owner`
**Description:** "Ask the owner a question you cannot answer yourself, such as a product decision. Ask one clear question with the options you see. Your run shows as needs input; stop work that depends on the answer. The answer appears in get_item (open_question) and as a question.answered event."
- **Input:** `id`, `question` (≤ 2,000).
- **Output:** `{ question_id }`.
- **Errors:** `validation` (a question is already open on this item).

---

## 6. Errors

Every error is returned as a tool result: `isError: true`, a `text` block holding the message, and `structuredContent: ToolError`. Messages are one or two sentences: what happened, then what to do.

| Code | When | Example `message` | Extras |
|---|---|---|---|
| `validation` | Bad input, a disallowed transition, limits, cycles | "Can't close RCP-14: 1 human review item is undecided. Submit a packet with submit_packet." | `details` (field errors, `allowed`, `cycle`) |
| `conflict` | Version mismatch, claim held, run ended | "RCP-15 is led by codex · orca-w1 (lease until 11:13 UTC). Pick another item." | `current` (record or claim) |
| `not_found` | Unknown ID, or deleted | "No item RCP-99. Check the ID with search_items." | — |
| `forbidden` | Owner-only operation, someone else's run, owner-added or locked item | "hr_01J… was added by the owner; only the owner can change it." | — |
| `unavailable` | Database busy past 5 s, disk full, maintenance (restore) | "Task Lite is busy; retry in a few seconds with the same idempotency_key." | `details.retry_after_s` |
| `internal` | Bug | "Unexpected error (ref e_01J…). It has been logged." | `details.ref` |

JSON-RPC protocol errors (malformed requests, unknown tool) follow the MCP spec and are separate from these.

---

## 7. Worked flows

Abbreviated calls: arguments shown as JSON, results trimmed with `…`.

### 7.1 Start a session and pick up work
```
whoami → { client: "claude", … }
search_items { project: "RCP", filter: "resumable" }            → []        (nothing sent back to resume)
search_items { project: "RCP", filter: "ready_to_start", limit: 5 } → [RCP-17, RCP-25, …]
get_item { id: "RCP-17" }                                        → item, version 4, no lead, checklist empty
claim_lead { id: "RCP-17", agent_label: "orca-w3" }              → { run_id: "run_01JA…", lease_expires_at: … }
```

### 7.2 Plan, work, verify, close (no human review)
```
set_plan { id: "RCP-17", run_id, steps: [
  { text: "Reproduce the jump after reload" },
  { text: "Persist the selected week in the URL" },
  { text: "Add a regression test" } ] }                          → plan_version 1
set_checks { id: "RCP-17", run_id, checks: [{ text: "Planner tests pass" }, { text: "Reload keeps the week (e2e)" }] }
update_step { id: "RCP-17", run_id, step_id: "wst_…1", state: "current" }
  … work …
report_commit { id: "RCP-17", run_id, sha: "4be1c09", branch: "rcp-17-week-reload" }
update_check { id: "RCP-17", run_id, check_id: "chk_…1", state: "pass", evidence: "vitest: 212 passed" }
update_step … state: "done"  (each step)
set_status { id: "RCP-17", run_id, status: "done" }                → done; lead run finished
```

### 7.3 With human review: packet, changes, second round
```
declare_human_review { id: "RCP-12", items: [
  "On your phone, drag recipes between days and meal slots. Does it feel right?",
  "Move a recipe using only the keyboard (Space, arrows, Enter)." ] }
  … work, checks, commits …
put_document { item_id: "RCP-12", run_id, name: "drag-phone.mp4", kind: "packet_attachment", content_base64: "…" } → dv_A
submit_packet { id: "RCP-12", run_id, built_from_commit: "7d21aa3", estimate: "10 min",
  how: ["Open the preview build at http://127.0.0.1:5173 (branch rcp-12-planner).", "…"],
  checked: [{ text: "214 unit and integration tests pass", provenance: "ci", evidence: "CI build #88" }],
  gaps: ["Not tested on Android."], attachments: [{ document_version_id: "dv_A" }] } → round 1, status review
finish_run { run_id, result: "finished", summary: "Built drag-and-drop; packet round 1 submitted." }

  (later, a new session)
search_items { filter: "resumable" } → [RCP-12]                    (the owner sent it back)
get_review { id: "RCP-12" } → round 1: item 1 changes "Drop targets are too small on my phone" → checklist step wst_…;
                              item 2 changes → bug RCP-17 (result_ref)
claim_lead { id: "RCP-12", agent_label: "orca-w3" }                → new run
get_item { id: "RCP-12" } → the work step "Drop targets are too small…" (from_review round 1); both human review items declared again
  … fix …
report_commit { id: "RCP-12", run_id, sha: "9c0e7f2" }
submit_packet { id: "RCP-12", run_id, built_from_commit: "9c0e7f2", … }  → round 2
```

### 7.4 A commit after handing off
```
report_commit { id: "RCP-19", sha: "c71e002" } → { stale_packets: [{ item_id: "RCP-19", round: 1 }] }
```
The owner sees "out of date" and may *Ask for a fresh packet*. If they do, the item returns to In progress (filter `resumable`), with an owner note asking for a new packet.

### 7.5 Question round trip
```
ask_owner { id: "DOC-4", run_id, question: "Document nutrition per serving or per 100 g? The API returns both; RCP-16 needs one. I'd use per serving with 100 g in a footnote." }
finish_run { run_id, result: "finished", summary: "Waiting on the owner: per serving vs per 100 g." }
  (later)
get_changes { cursor, item_id: "DOC-4", types: ["question.answered"] } → 1 event
get_item { id: "DOC-4" } → open_question.answer: "Per serving; put 100 g in a footnote." (now marked read)
```

### 7.6 Claim conflict
```
claim_lead { id: "RCP-15" } → conflict { current: { lead_client: "codex", lead_label: "orca-w1", last_signal_at: "…47 min ago", lease_expires_at: "…in 13 min" } }
```
Pick other work. Don't wait or retry in a loop. The owner sees the rejected claim and may release the stale one.

### 7.7 Subagents
```
start_run { id: "RCP-14", parent_run_id: "run_lead", agent_label: "units-worker" } → run_child   (subagent with its own connection)
  subagent: update_check { id: "RCP-14", run_id: "run_child", check_id: …, state: "pass", provenance: "observed", evidence: "31 tests" }
  subagent: finish_run { run_id: "run_child", result: "finished", summary: "Conversion table + 31 tests" }
log_subagent { id: "RCP-14", run_id: "run_lead", step_id: "wst_…2", name: "explorer", outcome: "Mapped 214 ingredient units in sample recipes", provenance: "relayed" }   (subagent without a connection)
```

### 7.8 Planning a new epic
```
create_item { project: "RCP", type: "Epic", title: "Pantry", status: "planning", outcome_md: "…" }
put_document { item_id: "RCP-2", name: "pantry-prd.md", kind: "planning", content_text: "…" }
create_item { project: "RCP", type: "Task", title: "Pantry inventory schema", epic: "RCP-2", status: "planning" }
create_item { …, title: "Pantry-aware recipe suggestions", epic: "RCP-2", blocked_by: ["RCP-15"], status: "planning" }
declare_human_review { id: "RCP-21", items: ["Suggest recipes with what's at home. Are the picks sensible?"] }
add_note { id: "RCP-2", text: "Broken into 3 items; ready for your review in Planning." }
```
Moving to Ready happens only if the project's workflow lets the agent do it.

### 7.9 Cleanup of deferred checks
```
deferred_reviews { project: "RCP" } → [{ item_id: "RCP-11", text: "Sign in from a second browser…", follow_up: { id: "RCP-29", status: "inbox" } }]
```
Either work the follow-up ticket like any other, or `add_note` on the original with a proposed plan.

---

## 8. Owner-side effects agents should expect

| Owner action (UI) | What the agent sees |
|---|---|
| Approves every item | `review.decided`; the item is `done` with `closed_by: owner` |
| Sends back | `review.decided`; the item is `progress` with no lead (`resumable`); new work steps with `from_review`, or new Bug items (Ready) linked by `relates` |
| Defers an item | `review.decided`; the item is `deferred`; with a follow-up, a new Task in Inbox titled "Verify: …" |
| Asks for a fresh packet | `packet.withdrawn` and `owner_note.added`; the item is `progress`, `resumable` |
| Answers a question | `question.answered`; the answer shows in `get_item` once |
| Leaves a note | `owner_note.added`; it shows in `get_item.unread_owner_notes` once |
| Adds checklist or review items | `plan.updated`, `checks.updated` or `human_review.declared`, with `added_by: owner` |
| Releases a stale claim | `claim.released`; the old run is `interrupted`; the item is back to `ready`; calls with the old `run_id` get `conflict` |
| Moves to Ready, or back to Planning | `item.status_changed` |
| Archives | `item.archived` (agent queries still include archived items) |

---

## 9. Implementation notes

- **Session and run binding.** Record the MCP session ID on each run. A *session* signal (BUILD_SPEC §5.4) requires the call's session to match the run's. Calls naming a run from a different session count as *report*.
- **Tool registration.** Generate the MCP `inputSchema` and `outputSchema` from the zod schemas in `shared/` (e.g. with `zod-to-json-schema`). Descriptions come from one `shared/mcp-copy.ts` file whose strings match this document; a unit test compares them.
- **Summaries.** The one-line `text` result for each tool comes from a template in the same file.
- **Transactions.** Each tool call is one transaction (BUILD_SPEC §2). `get_item` marks deliveries in a separate short write after the read.
- **Concurrency.** better-sqlite3 is synchronous. Run tool handlers on the main thread, never awaiting inside a transaction. Use `BEGIN IMMEDIATE` for writes, and a `busy_timeout` of 5 s before returning `unavailable`.
- **Logging.** Log one line per call: tool, client, label, run, duration, result code. Never log arguments that may contain document content or secrets.

---

## 10. Contract tests

These are part of M2 (BUILD_SPEC §11). Use the official MCP client SDK against a seeded server.

1. `initialize` returns the server instructions verbatim, and the tool list matches §5: names, descriptions and schemas (snapshot test).
2. A wrong or missing token gets 401. A bad `Origin` gets 403. A bad `Host` gets 421.
3. Every tool's happy path, from the worked flows in §7, runs end to end in one test.
4. Every error code is reachable and well-formed: validation (cycle, transition, limits), conflict (version, claim, ended run), not_found, forbidden (owner-added item, someone else's run), unavailable (simulated lock).
5. Idempotent replay returns the same result with `replayed: true`; a different payload under the same key gets `validation`.
6. Two clients race `claim_lead`: exactly one wins, and the other gets `conflict` with `current`.
7. Run states: *live* within the window with pings answered; *reported* when calls come from a different session; *stale* after `STALE_AFTER`; lease expiry → `interrupted` and the item back to Ready; restart → `interrupted`.
8. `get_item` delivers owner notes and answers exactly once.
9. `report_commit` after `submit_packet` marks the packet stale (ticket-level and epic-level).
10. `get_changes` pages through events in order with no gaps, and an empty cursor returns the latest.

---

## 11. Client setup

The commands below were checked against the clients' current documentation on 2026-11-07. The real-client smoke test (BUILD_SPEC §10) is still the final check.

### Token
- **Where it comes from:** Settings → Connections → *Reveal token* (or `docker compose exec tasklite tasklite agent-token`).
- **Put it in the environment** the agent clients run in, as `TASKLITE_TOKEN`. On Windows: `setx TASKLITE_TOKEN "<token>"`, then open a new terminal. Orca workers must see the same variable (BUILD_SPEC §12, V2).
- **Watch for whitespace:** a trailing newline in the token breaks auth, and Claude Code warns about hidden whitespace.

### Codex
Source: Codex MCP docs, `learn.chatgpt.com/docs/extend/mcp?surface=cli`.
- **Where:** add this to `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`). The token is read from the environment on every connection and never stored in the file:
  ```toml
  [mcp_servers.tasklite]
  url = "http://127.0.0.1:7420/mcp"
  bearer_token_env_var = "TASKLITE_TOKEN"
  ```
- **Flags:** none needed; Streamable HTTP isn't behind an experimental flag.
- **No CLI form:** `codex mcp add` has no documented bearer-token flag for HTTP servers, so use the config file.

### Claude Code
Source: `code.claude.com/docs/en/mcp`. Flags come before the name, and the name before the URL.
- **For every project (user scope; recommended):**
  ```bash
  claude mcp add --transport http --scope user tasklite http://127.0.0.1:7420/mcp \
    --header "Authorization: Bearer $TASKLITE_TOKEN"
  ```
  PowerShell: `--header "Authorization: Bearer $env:TASKLITE_TOKEN"`.

  **Caveat:** your shell expands the variable when you run this, so Claude Code stores the token itself in its user config. That's acceptable for a loopback-only service. If you rotate the token, run the command again.
- **One repo only (project scope):** add `.mcp.json` at the repo root. Claude Code expands `${TASKLITE_TOKEN}` in this file, so the token isn't stored. The first time, it shows as "Pending approval" until you approve it in an interactive `claude` session.
  ```json
  {
    "mcpServers": {
      "tasklite": {
        "type": "http",
        "url": "http://127.0.0.1:7420/mcp",
        "headers": { "Authorization": "Bearer ${TASKLITE_TOKEN}" }
      }
    }
  }
  ```
  Note: `type` must be `http`. An entry with a `url` but no `type` is treated as stdio and skipped.
- **Check it:** `claude mcp list` should show `tasklite … ✔ Connected`. Inside Claude Code, `/mcp` shows the status.

### Orca workers
Orca launches the installed Codex or Claude, so the configurations above apply as long as the worker inherits your user config and environment. That's verified for Codex workers; Claude workers are still to verify (BUILD_SPEC §12, V2). Settings shows "Not verified" until the smoke test passes.

### Settings snippets
The Client setup card in Settings (UI_SPEC §6.7) shows exactly the Codex TOML and the user-scope Claude command above, with the token as `$TASKLITE_TOKEN`, never the value.
