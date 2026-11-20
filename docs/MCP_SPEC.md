# Docket: MCP spec

Status: ready to build, 2026-11-07. This is the complete agent-facing contract: connection, conventions, the server instructions, every tool's description text and schemas, errors, and worked flows. [BUILD_SPEC.md](BUILD_SPEC.md) §5 defines the rules these tools enforce. Where the two disagree on a schema, this file wins; on a rule, BUILD_SPEC wins.

**Agents are the primary users of Docket.** The tool descriptions and server instructions below are the only manual most agents will ever read, so treat them as product copy:
- **Implement them verbatim.**
- **Change them deliberately:** edit this file first, and keep the contract tests in §10 in step with it.

Companion template: [templates/AGENTS-docket.md](templates/AGENTS-docket.md) is the block each project pastes into its `AGENTS.md` or `CLAUDE.md`.

---

## 1. Connection

| | |
|---|---|
| Endpoint | `http://127.0.0.1:7420/mcp` |
| Transport | MCP Streamable HTTP, protocol version per the SDK's latest stable. Stateful sessions (`Mcp-Session-Id`). The server accepts `GET` for the server→client stream and `DELETE` to end a session. |
| Auth | Decision 32. **Local trust (default):** none; any process on this machine may connect (the Host and Origin guards still apply). **Protected mode:** `Authorization: Bearer <DOCKET_TOKEN>`, and a missing or wrong token gets HTTP 401 before any MCP handling. |
| Server info | `name: "docket"`, `version` = the app version |
| Capabilities | `tools` and `prompts`, each with `listChanged: false`. No resources. Everything an agent needs comes from tools, and the server instructions point to the tools. The one prompt, `onboard` (§5.11; decision 31), offers the onboarding guide to clients that support prompts; `onboard_project` returns the same guide to those that don't. |
| Client identity | `clientInfo.name` from `initialize`, normalised (BUILD_SPEC §3). Agents add `agent_label` on `claim_lead` and `start_run`. |
| Liveness | The server pings each session that has an open run every 60 s. Answering pings is what lets a run show as *live* (BUILD_SPEC §5.4). |

Client setup commands are in §11.

---

## 2. Server instructions

The server returns this text as `instructions` in the `initialize` result. Clients show it to the model as standing guidance. Implement it verbatim, substituting nothing.

```
Docket coordinates the owner's agent work. Use it to find work you may start, get its context, record your plan and progress, follow and record decisions, and hand finished work to the owner for review. It enforces claims, dependencies and review gates for you. The owner supervises in a web UI; keep entries short and factual.

Workflow: Inbox → Planning → Ready → In progress → Review → Done.
- Only start work that is Ready (search_items filter "ready_to_start") or was sent back to you (filter "resumable"). Claim it first with claim_lead; if someone else holds it, pick something else.
- Then call get_context: one call that gathers the item, the decisions you must follow, the epic and label briefs, blockers and planning docs.
- Follow active decision records. Owner decisions are authoritative; to challenge one, use ask_owner. Record decisions other agents must follow with publish_decision.
- Planning belongs to the owner. You may draft planning documents (put_document) and move an item to Ready only when the project's workflow (AGENTS.md / CLAUDE.md) says you may.
- To change your instructions for a project, propose it with propose_agent_file_change; don't edit installed files directly.
- To set up a new project or onboard a repo, call onboard_project and follow the guide it returns.
- Your plan is the item's checklist, not new tickets: set_plan with one-line steps, update_step as you go. Split work into a new Story or Task only when a step needs its own blocker, owner or review.
- Record what you verify yourself with set_checks. Record subagent work with log_subagent; say whether you observed it or are relaying it.
- If the owner must verify something by hand, declare it with declare_human_review, ideally during Planning. The item cannot close while any human review item is undecided.
- Report each commit for the item it belongs to (report_commit). When the work is built and your checks pass, hand off with submit_packet. If there is no human review, close it with set_status "done".
- If you need a decision from the owner, ask_owner and stop; the answer arrives in get_item.
- Pass run_id on every call while you are working; it keeps your claim alive and shows you as live. Call finish_run when you stop.
- Say where your work lives: pass workspace (worktree path, branch, base) to claim_lead, push work in progress at every checklist step, and report_commit with pushed true.
- If you must wait (on another item, the coordinator or a person), call park_run with what you are waiting on. Never just go quiet: a silent run looks stale and loses its claim; a parked run keeps it.
- Declare long-lived things you start (dev servers, sessions, containers) with heartbeat resources_started, and release them before finish_run. Coordinators: after a crash or restart, start with recovery_report, and never prune a workspace it lists as in use or at risk.
- After any pause, call get_item: it delivers the owner's notes, answers and review decisions, each once.
- Send only what changes. update_item, set_plan and set_checks patch: whatever you leave out stays as it is. Use get_item view "summary" when you only need status.

Errors are structured (code: validation | conflict | not_found | forbidden | unavailable | internal | seam_conflict | not_declared | lease_held). On conflict, read the current state in the error and retry only if your change still makes sense.
```

---

## 3. Conventions

### IDs
| Object | Format | Example |
|---|---|---|
| Item | `<PROJECT>-<n>` | `RCP-14` |
| Project | 2–5 uppercase letters | `RCP` |
| Work step, check, human review item, run, question, link, document, document version, packet, agent file proposal, onboarding session, event cursor | Prefix + ULID: `wst_`, `chk_`, `hr_`, `run_`, `q_`, `lnk_`, `doc_`, `dv_`, `pkt_`, `afp_`, `onb_`. Cursors are opaque strings. | `hr_01JC9V…` |

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
  | check `evidence` (`set_checks`, `update_check`, `submit_packet.checked[].evidence`), `how[]` steps, `gaps[]`, `checked[].text` | 500 |
  | `estimate` | 40 |
  | `link_artifact.url` | 2,000 |
  | `branch` | 200 |
  | artifact `state` | 40 |

  Over the limit returns `validation`.
- **Enums** are lowercase snake_case strings:

  | Enum | Values |
  |---|---|
  | `status` | `inbox`, `planning`, `ready`, `progress`, `review`, `done`, `canceled` |
  | `type` | `Epic`, `Story`, `Task`, `Bug` |
  | `priority` | 1 (high), 2, 3 |
  | `run_state` (derived) | `live`, `reported`, `stale`, `parked`, `needs_input`, `failed`, `finished`, `interrupted` |
  | `end_reason` | `finished`, `failed`, `released`, `lease_expired`, `owner_released`, `service_restart`, `canceled` |
  | `workspace_state` (derived) | `in_use`, `parked`, `at_risk`, `safe_to_prune`, `unknown` |
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
Pass `run_id` on every call you make while working. **Every tool accepts an optional `run_id`**, reads included. `idempotency_key` is accepted only by the 34 mutating tools (B3 resolution 1; 27 before decision 30 added `propose_agent_file_change`, 28 before decision 31 added `onboard_project` and `finish_onboarding`, 30 before decision 34 added `apply_batch`, and 31 before decision 36 added `declare_shared_changes`, `take_lease` and `release_lease`).
- **What it does:** renews your lead lease and keeps you *live*.
- **Calls without it** are attributed to your client but don't touch any run.

### Strict inputs
Unknown input keys are rejected with `validation` (JSON Schema `additionalProperties: false`), so a typo such as `expected_verison` can't silently skip a check. The error names each unknown key and, when one is close, the valid field it probably meant, in both the message and `details.unknown` / `details.fields`. For example: `Unknown field "expected_verison"; did you mean "expected_version"?` (B3 resolution 4).

### Workspaces, briefs and resources (recovery)
Docket records **where work lives and what was started for it**, so a crashed orchestrator or worker can be restarted without guessing (owner decision 26). It never touches the host: it can't check a folder, stop a process or protect a worktree. The coordinator does those things using what Docket records.
- **Workspace:** passed to `claim_lead` or `start_run` and updated through `heartbeat`. It holds the host, repo, worktree path, branch, base ref and base SHA, plus `head_sha`, `pushed_sha` and `dirty` (uncommitted changes, as the agent reports them).
- **Orchestrator reference:** an optional `{ name, dispatch_id, task_id, run_id }`, for example Orca's IDs, so a coordinator can match its own records.
- **Brief:** the exact instructions the run was given. Pass it as text (stored as an immutable `brief` document on the item) or as a `document_version_id`. On a restart it is re-sent unchanged.
- **Resources:** long-lived things a run starts (a process, dev server, session, container, temp directory or port), each with a `locator` precise enough to find it again. Declared and released through `heartbeat`.
- **External:** a namespaced map (≤ 2 KB of JSON, for example `{"orca": {...}}`). Stored as it is and never interpreted. Returned only in `get_item` view `full` and in `recovery_report`.
- **Workspace state** (derived per worktree path):
  - `in_use`: an open run;
  - `parked`: a parked run;
  - `at_risk`: no open run, but there are unpushed commits (`head_sha` ≠ `pushed_sha`), `dirty` is true, or resources are unreleased. **Also** when a run ended unexpectedly (`lease_expired`, `service_restart` or `owner_released`) and its item is still open and not yet led by a newer run: that work is in flight, even if it's clean and pushed (B10 resolution);
  - `safe_to_prune`: every run ended, everything pushed, `dirty` false, every resource released, and no interrupted work waiting to be picked up again;
  - `unknown`: not enough data.
- **Limits** (B5 resolutions, PR #13). Over a limit returns `validation`.

  | Field | Limit |
  |---|---|
  | `workspace.host`, `branch`, `base_ref` | 200 |
  | `workspace.repo` | 2,000 |
  | `workspace.path` | 1,000 |
  | `base_sha`, `head_sha`, `pushed_sha` | 7–40 hex, like any SHA |
  | `orchestrator.name` | 40 |
  | `orchestrator.dispatch_id`, `task_id`, `run_id` | 100 |
  | `brief` | 20,000; mutually exclusive with `brief_document_version_id` |
  | resource `label` | 120 |
  | resource `locator` | `pid`: a non-negative integer; `port`: 1–65535; `session_id`, `container`, `host`: 200; `path`: 1,000 |
  | `resources_started` | 10 per call |
  | release `note` (`resources_released[].note`, and the owner's release body) | 500 |
  | `waiting_on.items` | 20 item IDs; `until` is an ISO time |
  | `external` | keys 1–40 characters; 2,048 bytes of UTF-8 JSON in total |
  | `recovery_report` `limit` | default 25, maximum 50 (the usual pagination) |

### Pagination
List tools return `{ items|events: [...], next_cursor: string|null }`. Pass `cursor` to continue. `limit` defaults to 25, and the maximum is 50 (200 for `get_changes`).

### Tool annotations
These are MCP hints:

| Tools | Hint |
|---|---|
| Read tools, including `get_context` and `list_decisions` | `readOnlyHint: true` |
| `get_item` | `readOnlyHint: false`, because it marks owner notes and answers as delivered |
| Retry-safe mutating tools: `heartbeat`, `report_commit`, `update_step`, `update_check` | `idempotentHint: true` (and `false` on every other tool) |
| All tools | `destructiveHint: false`, set explicitly, because MCP defaults it to true for tools that aren't read-only and agents can't delete |

`readOnlyHint` is set explicitly on every tool: `true` for the 13 read tools (10 before decision 30 added `get_agent_files`, 11 before decision 33 added `get_step`, and 12 before decision 36 added `list_shared_parts`), `false` for `get_item` and all mutations. No tool sets `openWorldHint` (B3 resolution 6).

### Results
Every tool returns two things:
- `structuredContent`: JSON matching its output schema, for programs.
- One `text` content block: a **complete compact rendering** of the same result, for the model (§3.1). It is *not* a JSON dump, and *not* just a one-line summary. A client that forwards only the text loses nothing an agent needs.

**Result modes** (owner decision 28). Some clients give the model `structuredContent` rather than the text, which costs about 3.5 times the tokens (BUILD_SPEC §12, V6). So each session gets one of two modes, decided at `initialize` from `clientInfo.name`:
- **Text-only**, when the name is listed in `DOCKET_TEXT_ONLY_CLIENTS` (exact, ignoring case; BUILD_SPEC §2). The default lists `claude-code`. `tools/list` has no `outputSchema`, and results carry the text block alone. Errors still set `isError: true`, and their text holds the full ToolError (§6). Everything else is the same: descriptions, input schemas, annotations and behaviour. Long text truncated in lists (§3.1) is in full in `get_item` view `full`.
- **Structured**, for every other client: both, as above.

The budgets (§3.2) measure the text block, which is all a text-only client's model sees.

**Prompts** (§5.11) are not affected by the result mode: `prompts/list` and `prompts/get` are the same for both modes, because a prompt's messages are text already (B29).

Results may carry `warnings: string[]` (§3.4). These are rendered as `! …` lines at the end of the text. Every mutating tool's output schema allows an optional `replayed: boolean` and `warnings: string[]` (B3 resolution 5).

**Output schemas** are `{ type: "object", anyOf: [<success result>, ToolError] }`. The official SDK client validates any `structuredContent` against the tool's `outputSchema`, even when `isError` is set, so a success-only schema would make every §6 error throw on the client side (B3 resolution 8).

### 3.1 Compact text format
The format is inspired by TERSL's identity-first, low-punctuation layout (ROADMAP.md), but it is our own and is output only; agents never write it.

**Rules:**
- The ID comes first on every line that names an object. Then the title, then the facts separated by `·`.
- Bare words for flags and states (`blocked`, `live`, `archived`). `key: value` only where the key isn't obvious.
- Nested facts are indented two spaces. Lists use one line per entry.
- Checklist markers: `[ ]` todo, `[>]` current, `[x]` done, `[!]` blocked, `[-]` skipped. Checks show `[pass]`, `[fail]`, `[todo]` or `[skip]`.
- **Empty sections are omitted,** except the safety facts, which always appear as `none` so their absence is explicit: `blocked_by`, `question`, `notes_unread`.
- **Times:** `HH:MMZ` for today (UTC), `MM-DD` otherwise.
- **Long text** is truncated at 200 characters in lists, with `…`. Full text is in `structuredContent` and in `get_item` view `full`.
- **Mutations** render one line: what changed and the new version, e.g. `Claimed RCP-14 · run run_01JA… · lease until 12:02Z · v8`.

**Example:** `get_item RCP-14`, standard view, from the seed data:
```
RCP-14 Generate shopping list from week plan
  story · P1 · progress · epic RCP-1 Meal planning MVP · labels mobile · v7
  lead claude·orca-w3 live · run run_01JA… · lease until 12:02Z
  blocked_by: none · blocks: RCP-24 planning, RCP-27 planning
  outcome: When a week plan is saved, the user can produce one merged shopping list grouped by aisle and export it.
  acceptance:
  - Quantities for the same ingredient merge across recipes, with unit conversion
  - List is grouped by aisle and sorted
  - Export as a Markdown checklist
  work (plan v3 · 1/4 done):
  - [x] wst_a Define aggregation rules
  - [>] wst_b Implement unit merging (g/kg, ml/l, cups)
      observed units-worker: Added conversion table and 31 tests
      relayed explorer: Mapped 214 ingredient units in sample recipes
  - [ ] wst_c Export as a Markdown checklist · was: Export to Reminders app · why: Reminders API not reachable from the container
  - [ ] wst_d Group by aisle and sort
  checks (1/3 pass):
  - [pass] chk_a 31 unit-conversion tests pass · observed · child run r-77 test output
  - [todo] chk_b Aisle grouping snapshot tests
  - [todo] chk_c Export opens cleanly in a Markdown viewer
  human_review:
  - [declared] hr_a Export one week's list and check it reads well in your notes app. · by claude
  decisions: dec_1 Units are metric internally; convert on display (owner)
  question: none · notes_unread: none
  docs: aggregation-rules.md v1
```
**Search results** use one line per item: `RCP-17 Planner jumps back to the current week after reload · bug · P1 · ready · unblocks 2 · v4`.

### 3.2 Lean reads
- `get_item` takes `view`:
  - `summary`: the ItemSummary, checklist counts, and whether a question or unread notes exist, without delivering them;
  - `standard` (the default): everything an agent needs to work: the 5 latest events, the 3 latest commits, documents by name and version;
  - `full`: everything, including 20 events, all commits and every field.
  - Only `standard` and `full` deliver (and mark read) owner notes and answers.
- `get_item` and `search_items` take `fields: string[]`, which limits the output to those top-level fields. `id` and `version` are always included.
- **Output shapes** (B3 resolution 3): in `get_item`, `item` has every `Item` field optional except `id` and `version`. The summary view adds `counts: { work_done, work_total, checks_pass, checks_total }`, `has_open_question` and `unread_owner_notes_count`. `search_items` rows are `ItemSummary` with `id` and `version` required.

**Token budgets** are measured on the text block, as characters ÷ 4, against the seed data. Contract tests fail at more than 120% of these:

| Call | Budget |
|---|---|
| `get_item` `RCP-14` standard | 1,200 |
| `get_item` any item, summary | 300 |
| `search_items` with 25 results | 1,000 |
| `get_context` `RCP-14` medium | 3,000 |
| `get_agent_files` `RCP`, listing (no `file`) | 300 |
| `onboard_project` with the bundled guide (header line plus guide) | 1,400 |
| Any mutation result | 60 |
| `apply_batch` with n operations (decision 34) | 30 + 25 × n |
| `list_shared_parts` with 20 parts, 10 of them with an in-flight declaration (decision 36) | 1,100 |

`onboard_project` is exempt from the mutation budget: its text block carries the whole onboarding guide, verbatim, because a text-only client's model sees nothing else. Its own row (B30) is measured on the bundled `docs/templates/ONBOARDING-guide.md`, set at the measured size plus 20% (1,164 → 1,400), so the guide can't grow unnoticed. `finish_onboarding` is an ordinary mutation (≤ 60). `apply_batch` (§5.13) is exempt from the mutation budget too: its text block holds one line per operation, so its own row scales with n. Measured in B36 on 100 operations (an epic, 60 items, 39 documents) at 1,612 tokens, and on 60 (44 enrichments, 2 step details, 13 links, a failure) at 865. `declare_shared_changes`, `take_lease` and `release_lease` are ordinary mutations (≤ 60); `list_shared_parts` (§5.15) gets its own row, measured in B38 at 908 tokens and set at that plus 20% (908 → 1,100). `get_context`'s `shared` section (decision 36) counts against the `get_context` budget like every other section.

### 3.3 Patches: silence preserves
Writes change what you send and nothing else. This is the TERSL idea that "what you don't restate, you don't change".
- `update_item` changes only the fields present. `labels` replaces the set; `add_labels` and `remove_labels` adjust it.
- `set_plan` and `set_checks` default to `mode: "patch"`:
  - entries with an `id` are updated;
  - entries without one are added (at the end, or `after: <id>`);
  - nothing is removed unless it's listed in `remove: [ids]`.
- `mode: "replace"` restates the whole list, and agent entries you omit are removed. Owner-added entries are always kept.

### 3.4 Write checks
Checks on every write, inspired by tersl-memory's lint rules:
- **Secrets.** Text that looks like a secret is rejected with `validation` ("Looks like a secret (Bearer token); remove it and retry"). That covers:
  - the service's own tokens;
  - `Authorization:`/`Bearer` values;
  - PEM private keys;
  - common key prefixes such as `sk-`, `ghp_`, `github_pat_`, `xox`, `AKIA`.

  Nothing is stored or logged when a write is rejected.
- **References to items that don't exist.** Item IDs mentioned in text (`RCP-99`) that don't exist are accepted, with a warning: `! RCP-99 doesn't exist`. Rules (B11 resolutions):
  - only `<KEY>-<n>` where `KEY` is an existing project counts, so `UTF-8`, `SHA-256` or `XYZ-9` with no XYZ project never warn;
  - IDs inside inline code and fenced code blocks are skipped;
  - every text field is checked, except identifier and locator fields (`id`, `from`, `to`, `epic`, `blocked_by`, `link_id`, `run_id`, `url`, `branch`, `sha`, `path`, `workspace`, `locator`, `external`, `idempotency_key`);
  - the check runs inside the write's transaction after the change, so an item created by the same call counts as existing;
  - owner edits through the UI API get the same warnings, in `warnings` on the response, and the UI shows them in the save toast.

---

## 4. Shared types

TypeScript notation. The zod source of truth lives in `shared/`.

```ts
type ItemSummary = {
  id: string; project: string; type: 'Epic'|'Story'|'Task'|'Bug'; title: string;
  status: Status; priority: 1|2|3; epic: string|null; epic_title: string|null; labels: string[];
  unblocks: number;                                  // items this would unblock when finished (B3 resolution 9)
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
  resume: { workspace: Workspace|null; last_pushed_sha: string|null; brief_document_version_id: string|null;
            last_end_reason: EndReason|null; unreleased_resources: number } | null;   // set when the item is resumable or its last run was interrupted
  unread_owner_notes: { id: string; text: string; at: string }[];   // returned once, then marked read
  documents: { document_id: string; name: string; kind: DocKind; latest: DocVersionRef }[];
  packets: { packet_id: string; round: number; state: 'open'|'decided'|'withdrawn'; stale: boolean; built_from_commit: string; created_at: string }[];
  commits: { sha: string; branch: string|null; at: string }[];     // newest first, max 20
  artifacts: { kind: string; label: string; url: string|null; state: string|null }[];
  dates_set_by: string|null; closed_by: 'owner'|'agent'|'imported'|null;
  decisions: { id: string; title: string; authority: 'owner'|'agent' }[];   // active, in scope, owner first; titles only (B3 resolution 9)
  recent_events: EventRow[];                          // 20 newest
};

type LinkRef = { link_id: string; id: string; title: string; status: Status; project: string;
  satisfied_when?: 'done'|'merged'|'verified';      // blocks links only: the effective rule
  cleared?: boolean;                                 // blocks links only: true when this blocker no longer blocks
  waiting_for?: 'done'|'merge'|'verification'|null };

type DecisionRecord = { id: string; project: string;
  scope: { kind: 'project'|'epic'|'label'|'item'; id: string|null };
  title: string; decision_md: string; rationale_md: string|null;
  authority: 'owner'|'agent'; author: string; status: 'active'|'superseded'|'withdrawn';
  supersedes_id: string|null; superseded_by_id: string|null; created_at: string; confirmed_at: string|null; version: number };

type ContextBundle = {
  item: Pick<Item, 'id'|'title'|'type'|'status'|'priority'|'outcome_md'|'acceptance'|'open_question'|'version'> & { unread_owner_notes: number };
  decisions: DecisionRecord[];                       // active, in scope; owner first
  epic: { id: string; title: string; outcome_md: string } | null;
  labels: { name: string; brief_md: string }[];
  blockers: { id: string; title: string; status: Status; cleared: boolean; waiting_for: string|null; outcome_first_line: string }[];
  dependents: { id: string; title: string; status: Status }[];
  current_step?: { id: string; text: string; state: WorkStep['state']; source: string|null;
    details_md: string|null; details_version: number; truncated: boolean } | null;   // the step to work on, with its details (decision 33; B34)
  workflow: { project: string; version_no: number; content_md: string; truncated: boolean } | null;   // the project's Workflow notes (decision 29)
  shared?: ContextShared;                            // shared changes (decision 36; §5.15); absent until B39
  planning_docs: { name: string; version_no: number; content_md: string|null; truncated: boolean }[];
  last_review: { round: number; items: { text: string; kind: 'approve'|'changes'|'defer'; note: string|null }[] } | null;
  budget: 'small'|'medium'|'large'; truncated_sections: string[];
};
type WorkStep = { id: string; text: string; state: 'todo'|'current'|'done'|'blocked'|'skipped';
  was_text: string|null; change_reason: string|null; added_by: 'owner'|'agent';
  from_review: { round: number; hr_item_id: string } | null;
  subagents: { name: string; outcome: string; evidence: string|null; provenance: 'observed'|'relayed'; child_run_id: string|null; at: string }[];
  state_by: string|null; state_at: string|null;
  source: string|null; has_details: boolean;            // decision 33
  details_md?: string|null; details_version?: number };  // only in get_step, get_item view 'full', and get_context's current step
type Check = { id: string; text: string; state: 'todo'|'pass'|'fail'|'skipped'; evidence: string|null;
  provenance: 'agent'|'observed'|'relayed'|'ci'; added_by: 'owner'|'agent' };
type HumanReviewItem = { id: string; text: string; state: 'declared'|'ready'|'approved'|'deferred';
  added_by: 'owner'|'agent'; added_by_client: string|null;   // the agent client that declared it; null for the owner. Rendered "by <client>" or "by owner" (B3 resolution 9)
  locked: boolean; version: number;
  last_decision: { kind: 'approve'|'changes'|'defer'; note: string|null; round: number; at: string; result_ref: string|null } | null;
  follow_up_item_id: string|null };
type Run = { run_id: string; parent_run_id: string|null; client: string; label: string|null; is_lead: boolean;
  run_state: RunState; started_at: string; last_signal_at: string; lease_expires_at: string|null;
  current_step_id: string|null; summary: string|null; error: string|null;
  end_reason: EndReason|null;
  parked: { reason: string; waiting_on: WaitingOn; since: string; resume_ready: boolean } | null;
  workspace: Workspace|null; orchestrator: { name: string; dispatch_id: string|null; task_id: string|null; run_id: string|null } | null;
  brief_document_version_id: string|null;
  resources: Resource[];
  external?: Record<string, unknown> };                  // view 'full' and recovery_report only

type Workspace = { host: string|null; repo: string|null; path: string|null; branch: string|null;
  base_ref: string|null; base_sha: string|null; head_sha: string|null; pushed_sha: string|null; dirty: boolean|null;
  state: 'in_use'|'parked'|'at_risk'|'safe_to_prune'|'unknown'; updated_at: string };
type WaitingOn = { items?: string[]; orchestrator?: boolean; person?: boolean; until?: string };
type Resource = { id: string; kind: 'process'|'dev_server'|'session'|'container'|'temp_dir'|'port'|'other';
  label: string; locator: { pid?: number; port?: number; session_id?: string; container?: string; path?: string; host?: string };
  started_at: string; released_at: string|null; release_note: string|null };
type Question = { id: string; text: string; asked_at: string; answer: string|null; answered_at: string|null };
type DocKind = 'planning'|'packet_attachment'|'import_report'|'brief'|'other';   // 'brief' is written only by claim_lead/start_run; put_document accepts planning|packet_attachment|other
type DocVersionRef = { document_version_id: string; version_no: number; mime: string; size: number; sha256: string; created_at: string; created_by: string };
type EventRow = { cursor: string; at: string; actor: string; item_id: string|null; type: EventType; summary: string };
type EventType =
  | 'item.created' | 'item.updated' | 'item.status_changed' | 'item.archived' | 'item.unarchived'
  | 'link.added' | 'link.removed' | 'label.upserted'
  | 'plan.updated' | 'step.updated' | 'subagent.logged' | 'checks.updated' | 'check.updated'
  | 'human_review.declared' | 'human_review.updated' | 'human_review.removed'
  | 'claim.granted' | 'claim.rejected' | 'claim.released' | 'run.started' | 'run.ended'
  | 'run.parked' | 'run.resumed' | 'run.unpushed_handled' | 'resource.declared' | 'resource.released'
  | 'packet.submitted' | 'packet.stale' | 'packet.withdrawn' | 'review.decided'
  | 'question.asked' | 'question.answered' | 'owner_note.added' | 'note.added'
  | 'document.added' | 'commit.reported' | 'artifact.linked'
  | 'link.updated' | 'project.updated'
  | 'decision.published' | 'decision.confirmed' | 'decision.superseded' | 'decision.withdrawn'
  | 'agent_file.updated' | 'agent_file.reverted' | 'workflow.updated' | 'install.recorded'    // decision 29
  | 'agent_file.proposed' | 'agent_file.proposal_decided' | 'drift.detected' | 'drift.resolved'   // decision 30
  | 'project.created' | 'onboarding.started' | 'onboarding.finished' | 'onboarding.reviewed'    // decision 31
  | 'shared_part.saved' | 'shared.declared' | 'overlap.raised' | 'overlap.decided' | 'lease.taken' | 'lease.ended'
  | 'undeclared.held' | 'undeclared.decided' | 'radar.found' | 'radar.cleared';   // decision 36

// Decision 36 (§5.15; BUILD_SPEC §5.21).
type SharedPartKind = 'table'|'model'|'endpoint'|'file'|'other';
type SharedPart = { key: string; kind: SharedPartKind; paths: string[]; single_writer: boolean; note: string|null;
  created_by: string; archived: boolean };            // created_by: 'owner' or the agent, e.g. 'claude · orca-w3'
type InFlightChange = { id: string; title: string; status: Status; change: 'add'|'change'|'remove'; note: string|null };
type DeclaredChange = { part: string; kind: SharedPartKind; change: 'add'|'change'|'remove'; note: string|null };
type Declaration = { item_id: string; state: 'declared'|'none'|'not_declared'; changes: DeclaredChange[];
  declared_by: string|null; declared_at: string|null };
type ContextShared = {
  declaration: { state: Declaration['state']; changes: DeclaredChange[] };
  overlapping: (InFlightChange & { part: string })[];   // other in-flight items declaring the item's parts
  in_flight: (InFlightChange & { part: string })[];     // up to 30 other in-flight declarations in the project
  leases: { part: string; held_until: string }[];        // leases the item holds
  radar: { with: string|null; branch: string; files: string[] }[];   // with: the other item, or null for the main branch
  truncated: boolean };

type ToolError = { code: 'validation'|'conflict'|'not_found'|'forbidden'|'unavailable'|'internal'
    | 'seam_conflict'|'not_declared'|'lease_held';   // decision 36
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
**Description:** "Check your connection to Docket. Returns how the server identifies you, server limits and the server time. Call it once at the start of a session."
- **Input:** none.
- **Output:** `{ client, session_id, server_version, server_time, limits: { page_max: 50, changes_max: 200, document_mcp_bytes: 26214400, text_limits: {...} }, live_window_s, stale_after_s, lease_s }`.

#### `list_projects`
**Description:** "List projects with item counts. Use the project key when creating items or searching."
- **Input:** none.
- **Output:** `{ projects: [{ key, name, counts: { open, ready_to_start, in_progress, review, blocked } }] }`.

### 5.2 Finding work

#### `search_items`
**Description:** "Find items. Filters: ready_to_start (Ready, unblocked, unclaimed: what you may start), resumable (In progress with no lead, usually sent back by the owner's review: resume it), blocked, waiting_for_review (handed off, waiting on the owner), mine (items you lead), deferred_review (owner deferred a check; cleanup). Combine with project, status, type, label, epic or text. Results are summaries; call get_item for details."
- **Input:** `project?`, `text?` (matches ID, title, description, labels and Jira key), `filter?`, `status?: Status[]`, `type?: Type[]`, `label?`, `epic?`, `include_archived?: boolean = true`, `fields?: string[]`, `agent_label?` (≤ 40, narrows `mine`; B3 resolution 2), `cursor?`, `limit?`.
- **Output:** `{ items: ItemSummary[], next_cursor }`. See the sort-order note below.
- **Errors:** `validation` (unknown filter or value).
- **Note on sort order:** `ready_to_start` sorts by priority, then by the number of items it would unblock (most first), then by ID. Every other filter sorts by priority, then `updated_at` ascending.
- **Note on `resumable`** (B7 resolution, PR #19): In progress with no lead. An **Epic** counts only if it has ever had a lead run (it was claimed, for example for an epic-level packet, then sent back or interrupted). Epic status is set by hand, so an epic stays In progress while its children are worked, and a literal rule would offer every active epic as resumable work. `claim_lead` still accepts any In progress item with no lead, so the owner can hand an epic to an agent deliberately.
- **Note on `mine`:** items where an open lead run belongs to the caller's client and `agent_label`. Pass `agent_label` to narrow it; otherwise every run from the client matches.

#### `get_item`
**Description:** "Get one item: description, acceptance criteria, blockers, checklist (your plan, your checks, human review), runs, the open question and its answer, the owner's unread notes, documents, packets and recent activity. Owner notes and answers are returned once and then marked as delivered, so read them now. Use view 'summary' when you only need status, and get_context when starting work. Step details show as a '· details' marker unless view is 'full'; read one step in full with get_step."
- **Input:** `id`, `view?: 'summary'|'standard'|'full' = 'standard'`, `fields?: string[]`, `agent_label?` (used to attribute delivery).
- **Output:** `{ item: Item }`.
- **Step details** (decision 33; §5.12): `standard` shows each step's `source` and `has_details`, rendered as `· details`, and never the details text, so its budget (§3.2) is unchanged; `full` adds `details_md` and `details_version` to every step and prints the details under it.
- **Errors:** `not_found`.

#### `get_context`
**Description:** "Get everything you need to work on an item in one call: its outcome and acceptance, the decisions you must follow (owner decisions first), the epic and label briefs, blockers and what they are waiting for, the project's workflow notes, planning documents, and the last review's notes. Sized to a budget; anything cut is marked. Read-only: owner notes are counted here but delivered by get_item."
- **Input:** `id`, `budget?: 'small'|'medium'|'large' = 'medium'` (about 1k, 3k and 8k tokens).
- **Output:** `{ context: ContextBundle }`. The text block renders the bundle in the compact format, in the BUILD_SPEC §5.15 priority order, with `…truncated; …` lines where it was cut.
- **Note (decision 29):** the bundle includes the project's Workflow notes (`ContextBundle.workflow`, §4; BUILD_SPEC §5.15 section 5), rendered as a `workflow:` section after the blockers and dependents, before the planning documents (the §5.15 order), with a `…truncated` line when cut. Shipped in B21 (tasks T151): the description above names "the project's workflow notes", in `mcp-copy.ts` and the snapshot too. The server returns `workflow: null` until T157 fills it.
- **Note (decision 33; B34):** the bundle includes the step to work on (`ContextBundle.current_step`: the step in state `current`, else the first `todo`; null when none is open) with its details, rendered as a `step:` section after the blockers and dependents, before the workflow notes (BUILD_SPEC §5.15 section 4b): a header line `step: wst_… <text> · <state> · source GF-123 · details v2`, then the details indented. They count in the budget; when they don't fit they're cut inline, followed by `…truncated; read it with get_step RCP-14 wst_…`, and when not even the header fits, a `…truncated; current step wst_… and its details; read it with get_step RCP-14 wst_…` line takes its place. The description is unchanged; the output schema gains the optional field (snapshot, B34).
- **Note (decision 36; B38):** the bundle gains `shared` (`ContextBundle.shared`, §4; §5.15; BUILD_SPEC §5.21 Context): the item's declaration, other in-flight items' declarations of the same parts, up to 30 other in-flight declarations in the project, the leases it holds and radar findings, rendered as a `shared:` section after the Workflow notes, before the planning documents, and counted in the budget. Optional and absent until B39 (T183) fills it; the description is unchanged.
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
- **Input:** `id`, `expected_version`, and any of `title`, `description_md`, `outcome_md`, `acceptance`, `priority`, `epic` (`null` clears it), `labels` (replaces the set), `add_labels`, `remove_labels`, `planned_start`, `planned_end` (`null` clears), `effort` (`null` clears). Fields you leave out are unchanged (§3.3).
- **Output:** `{ item: ItemSummary }`.
- **Errors:** `conflict` (version), `validation`.

#### `set_status`
**Description:** "Move an item to another status. Allowed moves: inbox→planning; planning↔ready; ready→progress; progress→ready (gives up the work); progress or review→done (only when no human review item is undecided); any open status→canceled (reason required); done→progress (reopen, reason required). Moving to ready needs the item's shared changes declared first (declare_shared_changes), else not_declared. When you close an item as done, pass changed_files and branch. Use submit_packet, not set_status, to hand off for review."
- **Input:** `id`, `status`, `expected_version?`, `reason?` (required for canceled and reopen), `changed_files?: string[]` and `branch?` (decision 36: read only when moving to `done`; §5.15).
- **Output:** `{ item: ItemSummary }`.
- **Errors:**
  - `validation`, with `details.allowed: Status[]` and `details.reason`, for example "2 human review items are undecided: hr_…, hr_…";
  - `conflict`;
  - `not_declared` (decision 36; §5.15): moving to `ready` before the item has declared its shared changes, or closing as `done` with changed files that map to parts it didn't declare.
- **Notes:** Moving to `done` ends your open lead run as `finished` if you haven't. Moving to `progress` doesn't claim the item; use `claim_lead`.

#### `link_items`
**Description:** "Link two items. type 'blocks' means from must be finished before to can start; 'relates' is informational. For blocks, satisfied_when sets what 'finished' means: done (default, or the project's default), merged (done and a PR reported merged with link_artifact), or verified (done and every human review item approved). Calling it again on an existing link updates satisfied_when. A link that would create a dependency cycle is rejected with the cycle path."
- **Input:** `from`, `to`, `type: 'blocks'|'relates'`, `satisfied_when?: 'done'|'merged'|'verified'` (blocks only; omit to use the project default).
- **Output:** `{ link_id, from, to, type, satisfied_when, updated: boolean }`.
- **Errors:** `validation`:
  - a cycle (`details.cycle: string[]`), or a self-link;
  - `verified` on a blocker with no human review items ("Declare human review on X, or use done.");
  - `not_found`.

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
**Description:** "Claim an item as its lead before you work on it. Works on Ready items (moves them to In progress) and on In progress items with no lead (resuming sent-back or interrupted work). Pass workspace (where the work lives) and, if a coordinator briefed you, the brief, so the work can be restarted after a crash. Pass instructions with the output of the installed docket-check script, so the owner knows which instructions you work from. Pass branch, the branch you will work on, so conflicts are spotted early. Returns your run_id: pass it on every later call. If someone else holds the claim you get a conflict with who holds it and until when; do not work on the item. If its shared parts overlap another item in flight you get seam_conflict: the owner has been asked whether they can run together, so pick other work and leave this item until they decide."
- **Input:** `id`, `agent_label?` (≤ 40, for example `orca-w3`), `workspace?: { host?, repo?, path?, branch?, base_ref?, base_sha? }`, `orchestrator?: { name, dispatch_id?, task_id?, run_id? }`, `brief?` (text, ≤ 20,000) or `brief_document_version_id?`, `external?` (≤ 2 KB JSON), `instructions?: { install_id?, files: [{ key, sha256, content? }] }` (decision 30: the output of the installed `docket-check` script; `content` ≤ 50,000 only for files that differ from the manifest), `branch?` (decision 36: ≤ 200, the branch the conflict radar trial-merges; defaults to `workspace.branch`).
- **`instructions` limits** (B26 resolutions): strict; `files` holds 0–20 entries (empty, with `install_id`, means every installed file is missing); `key` is `agents_block` or `skill:<name>`; `sha256` is 64 hex characters, either case (compared lowercased); `content` is 0–50,000 characters, not trimmed. `start_run` doesn't take it.
- **Output:** `{ run_id, item: ItemSummary, lease_expires_at }`.
- **Errors:**
  - `conflict` with `current: { lead_client, lead_label, run_id, last_signal_at, lease_expires_at }`, recorded as a rejected claim the owner can see;
  - `validation`: the status isn't ready or progress, or the item is blocked (`details.blocked_by`);
  - `seam_conflict` (decision 36; §5.15) with `details: { with: string[], parts: string[] }`: the item's declared parts overlap another item in flight. The item stays Ready, and the owner is asked once per pair.

#### `release_lead`
**Description:** "Give up the lead claim without finishing, for example when you are stopping before the work is done. The item returns to Ready so another agent can pick it up; your plan and notes stay."
- **Input:** `id`, `run_id`, `reason`.
- **Output:** `{ item: ItemSummary }`.
- **Errors:** `forbidden` (not your run), `not_found`.

#### `start_run`
**Description:** "Start a child run under your lead run when you delegate to a subagent that has its own Docket connection. Pass its workspace and brief as for claim_lead. The subagent passes the child run_id on its calls. For subagents without their own connection, use log_subagent instead."
- **Input:** `id`, `parent_run_id`, `agent_label?`, `workspace?`, `orchestrator?`, `brief?` or `brief_document_version_id?`, `external?` (shapes as for `claim_lead`).
- **Output:** `{ run_id }`.
- **Errors:** `validation` (the parent isn't an open lead run on this item).

#### `heartbeat`
**Description:** "Tell Docket you are still working, and update what it knows about your run: your current step, your workspace (head and pushed commits, uncommitted changes), and long-lived resources you started or released. Any call with run_id keeps you live, so use this when you have nothing else to record or something changed."
- **Input:** `run_id`, `current_step_id?`, `note?` (short; shown as the run's "doing" line), `workspace?` (a patch: `head_sha?`, `pushed_sha?`, `dirty?`, `path?`, `branch?`), `resources_started?: [{ kind, label (≤ 120), locator }]` (≤ 10 per call), `resources_released?: [{ resource_id, note? }]`, `external?`.
- **Output:** `{ run_state, lease_expires_at, resources: [{ id, label }] }`, where the new resources have IDs `rsc_…`.
- **Note:** A heartbeat on a parked run resumes it.
- **Errors:** `not_found`, `conflict` (the run has ended: lease expired or released; `current` holds the item's lead).

#### `finish_run`
**Description:** "End your run. result 'finished' when you stopped normally, 'failed' with an error when something broke. Finishing a lead run releases the claim but does not change the item's status: hand off with submit_packet or close with set_status first."
- **Input:** `run_id`, `result: 'finished'|'failed'`, `summary` (≤ 500), `error?` (≤ 4,000; shown monospaced).
- **Output:** `{ run_state }`.
- **Note:** A failed lead run leaves the item In progress with no lead. The owner sees it under Problems and can *Return to Ready*.
- **Warnings:** finishing with unreleased resources, or with `head_sha` ≠ `pushed_sha`, succeeds but warns (`! 1 resource still declared: dev server :5173`; `! 2 commits not pushed`). The workspace then shows as `at_risk`.

#### `park_run`
**Description:** "Park your run when you must wait: on another item, on the coordinator to send you more work, or on a person. A parked run keeps its claim and its workspace stays marked in use, so it is never mistaken for finished or stale. Say what you are waiting on; Docket flags it as ready to resume when that clears. Any later call with your run_id resumes it."
- **Input:** `run_id`, `reason` (≤ 500), `waiting_on?: { items?: string[], orchestrator?: boolean, person?: boolean, until? }`.
- **Output:** `{ run_state: 'parked', resume_ready: boolean }`.
- **Errors:** `conflict` (the run has ended), `validation` (unknown item in `waiting_on.items`).
- **Rules:**
  - A parked run doesn't go stale, and its lease is suspended. After `DOCKET_PARK_MAX` (default 24 h) it shows under the owner's Problems but keeps its claim.
  - `resume_ready` becomes true when every `waiting_on.items` entry is done or cleared, or `until` passes. A run parked only on the orchestrator or a person stays false until it is resumed.

### 5.5 Checklist

#### `set_plan`
**Description:** "Publish or revise your plan as one-line work steps; steps may carry details (Markdown) and a source, such as a Jira key. By default this patches: steps with an id are updated (changing text records the old text and your reason), steps without an id are added, and nothing is removed unless you list it in remove. Use mode 'replace' to restate the whole plan. Owner-added steps are always kept; on steps imported from Jira you may add details, keeping the current text at the start. Every revision is kept as history."
- **Input:**
  - `id`, `reason` (required unless this is the first plan);
  - `mode?: 'patch'|'replace' = 'patch'`;
  - `steps?: [{ id?, text?, state?: StepState, change_reason?, after?: step_id, details?, source? }]`, where `details` is Markdown (≤ 10,000; `null` clears it) and `source` is ≤ 100 (`null` clears it); both patch (§5.12);
  - `remove?: step_id[]`;
  - at most 30 steps on the plan in total.
- **Output:** `{ plan_version, work: WorkStep[] }`.
- **Errors:** `validation` (limits, unknown step id).

#### `update_step`
**Description:** "Update one work step's state as you go: current when you start it, done when finished, blocked or skipped with a note. Pass details to replace the step's details (null clears them), with expected_details_version from get_step. On a step imported from Jira you may only add to its details: keep the current text at the start."
- **Input:** `id`, `step_id`, `state`, `note?` (required for blocked and skipped), `details?` (≤ 10,000; replaces them, and `null` clears them), `expected_details_version?` (the `details_version` you read; §5.12).
- **Output:** `{ step: WorkStep }`.
- **Errors:** `not_found` (step), `conflict` (`expected_details_version` is stale; `current` is the step with its details), `forbidden` (an owner step's details; an imported step's details rewritten or cleared).

**Imported steps** (decision 34; B36, T178): a step the Jira import wrote (it has a `source`, and its item was imported; owner-typed steps never have a source) takes details from agents through `set_plan` and `update_step`: they may set details where there are none, or extend them, keeping the current text (less trailing whitespace) at the start. Rewriting or clearing them is `forbidden` ("GF-12's step wst_… was imported from Jira; you may add to its details, keeping the current text at the start, but only the owner can rewrite or clear them. You may change its state."). Its text and source stay the owner's, and its state is open to agents as on every owner step. Owner-typed steps stay fully protected. The events carry `details_added: true`; the step's history entry has `note: "details added by <agent>"`, and `update_step`'s event reads "Details added by <agent> to “<step>” (v2)". Nothing new is stored: "imported" is read from `added_by`, `source` and the item's `imported` flag.


#### `log_subagent`
**Description:** "Record what a subagent contributed, as a short line under the step it worked on. provenance 'observed' if you saw its run or output directly, 'relayed' if you are passing on its report. This never creates a ticket."
- **Input:** `id`, `step_id?`, `name` (≤ 60), `outcome` (≤ 500), `evidence?` (≤ 500), `provenance`, `child_run_id?`.
- **Output:** `{ logged: true }`.

#### `set_checks`
**Description:** "Publish what you will verify yourself (tests, measurements, reviews), with state and evidence. Patches like set_plan: listed checks are updated or added, and nothing is removed unless listed in remove. Owner-added checks are always kept."
- **Input:** `id`, `mode?: 'patch'|'replace' = 'patch'`, `checks?: [{ id?, text?, state?: 'todo'|'pass'|'fail'|'skipped', evidence?, provenance?: Provenance = 'agent' }]`, `remove?: check_id[]` (at most 30 checks in total).
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
**Description:** "Report a commit for the item it belongs to. Report every commit you make for an item, including fixes after a review, and set pushed true once it is on the remote: an unpushed commit can be lost in a crash. If a handoff packet was built from an older commit, it is marked out of date for the owner automatically."
- **Input:** `id`, `sha` (7–40 hex), `branch?`, `message?` (first line, ≤ 200), `pr_url?`, `pushed?: boolean = false` (true once the commit is on the remote; it updates the run's `pushed_sha`).
- **Output:** `{ recorded: true, stale_packets: [{ item_id, packet_id, round }] }`.
- **Note:** Reporting the same SHA for the same item again is a no-op.

### 5.7 Review and the owner

#### `submit_packet`
**Description:** "Hand finished work to the owner for human review. Call it when the work is built, your checks pass and everything is committed and reported. The packet must let the owner verify without asking you anything: what to check, exact steps (URLs, builds, commands), what you already verified and how, known gaps, and attachments. Pass changed_files (every file your work changed) and branch: changes to shared parts the item didn't declare hold it for the owner. The item moves to Review; read the decision later with get_review or get_item."
- **Input:**
  - `id`, `built_from_commit` (recorded with `report_commit` if not already), `estimate` (for example `"10 min"`);
  - `hr_item_ids?` (defaults to every declared item);
  - `how: string[]` (1–15 steps);
  - `checked: [{ text, provenance, evidence }]`;
  - `gaps?: string[]`;
  - `attachments?: [{ document_version_id, caption? }]`;
  - `changed_files?: string[]` (decision 36: every file the work changed, repo-relative, ≤ 2,000) and `branch?` (§5.15).
- **Output:** `{ packet_id, round, display_id: 'pkt-9c0e', item: ItemSummary, held_undeclared?: string[] }`. `held_undeclared` (decision 36) lists the parts the changed files touch that the item didn't declare; it is present only when the packet is held for the owner.
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

### 5.8 Decisions

#### `publish_decision`
**Description:** "Record a decision that other agents must follow, such as a convention, a design choice or an interface rule, with a short rationale. Scope it as narrowly as it applies: an item, an epic, a label or the whole project. You can supersede an earlier agent decision; owner decisions can only be changed by the owner (use ask_owner to challenge one)."
- **Input:** `project`, `scope: { kind: 'project'|'epic'|'label'|'item', id? }` (`id` is required except for `project`), `title` (≤ 120), `decision` (≤ 4,000, Markdown), `rationale?` (≤ 4,000), `supersedes?: decision_id`.
- **Output:** `{ decision: DecisionRecord }` (`authority: 'agent'`).
- **Errors:**
  - `forbidden` (superseding an owner decision);
  - `validation` (scope doesn't exist or is in another project; limits; a secret);
  - `not_found` (`supersedes`).

#### `list_decisions`
**Description:** "List decision records for a project, optionally narrowed to one scope. Active records only unless include_inactive. get_context already includes the active decisions that apply to an item."
- **Input:** `project`, `scope?: { kind, id? }`, `in_scope_of?: item_id` (a top-level field; everything that applies to that item), `include_inactive?: boolean = false`, `cursor?`, `limit?`.
- **Output:** `{ items: DecisionRecord[], next_cursor }`, with owner records first, then newest.

#### `withdraw_decision`
**Description:** "Withdraw a decision you or another agent recorded when it no longer applies. Owner decisions can't be withdrawn by agents."
- **Input:** `decision_id`, `reason` (≤ 500).
- **Output:** `{ decision: DecisionRecord }`.
- **Errors:** `forbidden` (an owner decision), `not_found`.

### 5.9 Recovery

#### `recovery_report`
**Description:** "After a crash or restart, or before pruning worktrees, get the restart list: runs that were interrupted, went stale or are parked, each with its brief, workspace, last pushed commit, checklist progress and any open question; every workspace with whether it is in use, at risk or safe to prune; and resources left running. Re-dispatch from this instead of guessing, and never prune a workspace marked in use or at risk."
- **Input:** `project?`, `since?` (ISO time; default the last 7 days), `include_briefs?: boolean = false` (include the brief text; otherwise only document version IDs), `cursor?`, `limit?`.
- **Output:**
  ```ts
  { interrupted: [{ item: ItemSummary; run: Run; end_reason: EndReason; checklist: { done: number; total: number };
                    open_question: Question|null; brief?: string }];
    stale:       [{ item: ItemSummary; run: Run }];
    parked:      [{ item: ItemSummary; run: Run; resume_ready: boolean }];
    workspaces:  [{ path: string; branch: string|null; item_id: string; run_id: string; state: WorkspaceState;
                    head_sha: string|null; pushed_sha: string|null; dirty: boolean|null; unreleased_resources: number }];
    orphaned_resources: [{ resource: Resource; item_id: string; run_id: string; run_ended_at: string }];
    next_cursor: string|null }
  ```
- **Text rendering:** one block per section. An interrupted entry reads like `RCP-15 Pantry inventory schema · interrupted (service_restart) · 2/4 done · ws C:/…/rcp-15 @ 4be1c09 (pushed) · brief dv_…`.
- **Read-only.** It never changes state; the coordinator acts on it.

---

### 5.10 Agent files (decision 30)

Agents read the agent files and Workflow notes in effect for a project, and change them only by proposing (BUILD_SPEC §5.19; FR-128–FR-130). Shipped in B26 (tasks T159): the two descriptions below, `claim_lead`'s `instructions` (§5.4, with its description), and the server-instructions bullet (§2), in MCP_SPEC, `mcp-copy.ts` and the snapshot together. Both tools answer `unavailable` until B27 (T160) implements them.

#### `get_agent_files`
**Description:** "Read the agent files (skills and the AGENTS.md block) and Workflow notes in effect for a project, with each one's version_id and where it comes from. Pass file to get its full text. Read-only. Call it before propose_agent_file_change, and propose from this text, not your installed copy."
- **Input:** `project`, `file?` (one key: `agents_block`, `workflow` or `skill:<name>`; otherwise all).
- **Output:** `{ project, files: [{ key, kind: 'skill'|'agents_block'|'workflow', version_id: string|null, sha256, source: 'default'|'project', content: string|null }] }`.
- **Listing and full text** (B26, for token cost): without `file`, every file is listed with `content: null`, and the text block prints one header line per file. With `file`, only that file is returned, and its full `content` is printed after its header line.
- **Workflow notes** are always listed. A project with no notes yet has `version_id: null`, `content: ""` and the sha256 of the empty string. Their `source` is `project`.
- **Read-only.**
- **Errors:** `validation` (unknown file), `not_found` (project).

#### `propose_agent_file_change`
**Description:** "Propose new content for an agent file (a skill or the AGENTS.md block) or a project's Workflow notes, with a short reason. Nothing changes until the owner approves; they may edit or decline it. Send the whole new text and based_on_version_id from get_agent_files. Omit project to propose a change to the default."
- **Input:** `project?` (omit to propose a change to the default), `file` (a skill key, `agents_block` or `workflow`), `content` (≤ 50,000; Workflow ≤ 10,000), `reason` (≤ 500), `based_on_version_id` (the `version_id` you read; `null` for Workflow notes that don't exist yet), plus `run_id?` and `idempotency_key?`.
- **Limits** (B26 resolutions): `content` is not trimmed. A skill or the block is 1–50,000 characters; Workflow notes are 0–10,000, where empty clears them. `reason` is 1–500, trimmed. `workflow` needs `project`. Proposal IDs are `afp_…`.
- **Output:** `{ proposal_id, state: 'pending' }`.
- **Errors:** `validation` (limits, unknown file, a secret), `not_found` (project).
- **Not retry-safe** (`idempotentHint: false`): pass `idempotency_key` when you might retry.

### 5.11 Onboarding (decision 31)

An agent sets up a project, or onboards a repo into one, from a fresh install with no agent files installed: `onboard_project` returns the guide to follow, and `finish_onboarding` hands the result to the owner, who reviews it from one card (BUILD_SPEC §5.20; FR-135–FR-140). Contracts shipped in B29 (T163): the two descriptions below, the `onboard` prompt, and the server-instructions bullet (§2), in MCP_SPEC, `mcp-copy.ts` and the snapshot together. B30 (T164) implemented them.

- **The guide** is the agent file `guide:onboarding` (BUILD_SPEC §5.20): the project's copy once the project exists, else the default, with `{{KEY}}` filled in. Not loaded yet: `unavailable` ("The onboarding guide is not loaded yet; …").
- **The same client** (B30): `onboarding_sessions.client`, the normalised `clientInfo.name`. `agent_label` doesn't narrow it, so a reconnecting agent gets its session back even without a label.
- **Tagging:** every event the session's client writes on the project while it is in progress carries `data.onboarding_session`; `finish_onboarding` counts them (BUILD_SPEC §5.20).
- **Never Ready:** while its session is in progress, the client's `set_status` to `ready` on that project is `forbidden` ("You're onboarding GF: leave GF-3 in planning. The owner moves items to Ready after reviewing the onboarding.").

#### `onboard_project`
**Description:** "Set up a project, or onboard a repo into one. Creates the project when the key is free (pass name) or adopts the existing project with that key, starts an onboarding session, and returns its session_id, what the project already holds, and the onboarding guide. Follow the guide step by step; it works with no agent files installed. Not retry-safe: pass idempotency_key."
- **Input:** `key` (2–5 uppercase letters, the project key rule), `name?` (≤ 100; required when creating), `color?` (`#rrggbb`), plus `run_id?` and `idempotency_key?`.
- **Limits** (B29 resolutions): `name` is 1–100 characters, trimmed, and ignored when adopting; whether it is required depends on the key, so the service checks it (`validation`), not the schema.
- **Output:** `{ project: { key, name, created: boolean }, session_id, guide, existing: { items, jira_items, documents } }`.
- **Text rendering:** one header line, then the guide verbatim and unindented, so a text-only client's model reads all of it. Exempt from the mutation budget (§3.2).
- **Calling it again** (B29): when the same client calls it on a project where its own session is in progress, it returns that session: the same `session_id` and guide, with `existing` counted again. It doesn't start a second session. Only another client's session in progress is `forbidden`.
- **Errors:** `validation` (a bad key, or `name` missing when creating), `conflict` (a deleted project's cleanup hasn't finished), `forbidden` (another agent's session is in progress on this project; `current` names it).
- **Not retry-safe** (`idempotentHint: false`): pass `idempotency_key` when you might retry.

#### `finish_onboarding`
**Description:** "Finish an onboarding session and hand it to the owner for review, with a short summary and any open questions. Pass the session_id from onboard_project. The owner reviews everything you set up from one card; stop there and wait for them."
- **Input:** `session_id`, `summary` (≤ 4,000), `questions?: string[]` (≤ 20, each ≤ 500), plus `run_id?` and `idempotency_key?`.
- **Limits** (B29 resolutions): `summary` is 1–4,000 characters and each question 1–500, all trimmed. Session IDs are `onb_…`.
- **Output:** `{ session_id, state: 'ready_for_review', changes: { created, enriched, documents, decisions, proposals } }`.
- **Errors:** `validation` (limits, a secret), `not_found` (session), `forbidden` (another client's session), `conflict` (the session isn't in progress; `current` is the session).
- **Not retry-safe** (`idempotentHint: false`): pass `idempotency_key` when you might retry.

#### Prompt `onboard`
**Description:** "Onboard this repo into Docket: set up or adopt the project, then follow the onboarding guide."
- **Arguments:**
  - `project_key` (required): "Project key: 2–5 uppercase letters, like GF."
  - `project_name` (optional): "The project's name, if it is new."
- **Returns:** the same guide as `onboard_project`, as one user message (B30). A guide that isn't loaded is a JSON-RPC `InternalError` saying so. While the guide service is a stub (B29, and contract tests that stub it), the text is "Onboarding guide not available yet".
- **Errors** (B29): `prompts/get` with a missing or malformed `project_key`, or an unknown prompt name, is a JSON-RPC `InvalidParams` error (protocol errors, §6).
- **Result modes:** the same for text-only and structured sessions (§3 Results).

### 5.12 Step details (decision 33)

A checklist step can carry details (Markdown) and a source, such as a Jira key (BUILD_SPEC §5.5; FR-145–FR-148). Contracts shipped in B33 (T170), in MCP_SPEC, `mcp-copy.ts` and the snapshot together:
- **`set_plan`:** gains "steps may carry details (Markdown) and a source";
- **`update_step`:** gains `details`;
- **`get_item`:** says details show as a marker unless view is full;
- **the new `get_step`.**

B33 also stores details and source through `set_plan`, `update_step` and the owner's step dialog route (UI_SPEC §6.3.1a), and implements `get_step`. B34 (T171) adds the current step's details to `get_context`, as the optional `ContextBundle.current_step` (§4; the `get_context` note in §5.2).

#### Changes to existing tools
- **`set_plan`:** `steps[]` entries accept `details?` (≤ 10,000; `null` clears it) and `source?` (≤ 100). Patch semantics: omitted means unchanged.
- **`update_step`:** accepts `details?` (replace, or `null` to clear) and `expected_details_version?`.
- **`get_item`:** in `standard` view, steps show `has_details` and render as `· details`; in `full` view, details are included.
- **`get_context`:** includes the current step's details (the one in state `current`, else the first `todo`), counted in the budget and truncated with a marker.

**B33 resolutions:**
- **Versions:** `details_version` starts at 0 and goes up by one on every change to the details (set, replace or clear), whoever makes it. Writing the same text again changes nothing.
- **Empty clears:** `details` is trimmed, and an empty string clears the details like `null`. `source` also accepts `null`, to clear a wrong source.
- **Kept across revisions:** a step a plan revision keeps carries its details and source unchanged, in `patch` and `replace` mode alike; owner-added steps keep owner-set details.
- **`update_step` with details:** `state` stays required. When it equals the step's current state and `details` is sent, only the details change. `expected_details_version` is checked only when sent.
- **Write checks** (§3.4) cover `details` and `source` like any other text: secrets are rejected, and item IDs that don't exist warn.
- **Events:** details and source changes are recorded on the existing `plan.updated` and `step.updated` events, as versions (`details_version: { old, new }`), never the text.
- **History entries:** `change` is one of `added`, `text`, `state`, `details` or `source`; `from` and `to` are the old and new text, state, source, or details version (`v1`); `note` carries the reason for a wording change or the note on a state change.

#### `get_step`
**Description:** "Read one checklist step in full: its text, state, source, details (Markdown), history and subagent notes. Call it before you work on a step that get_item shows with '· details'. Read-only."
- **Purpose:** read one checklist step in full: title, state, source, details and history.
- **Input:** `id` (item), `step_id`, plus `run_id?`.
- **Output:** `{ step: WorkStep (with details_md and details_version), history: [{ at, by, change, from?, to?, note? }] }`.
- **Text rendering:** one header line (`wst_… <text> · <state> · on RCP-14 · source GF-123 · details v2`), the history and subagent notes indented, then the details verbatim and unindented, so an agent can edit from exactly that text.
- **Any step on the item:** a step a revision removed is still readable by its ID, with its history.
- **Read-only.**
- **Errors:** `not_found` (item or step).

### 5.13 Batches (decision 34)

The Gameflow onboarding (305 matches, 44 enrichments, 39 documents) didn't fit single calls, so the agent fell back to a script on a second MCP connection. `apply_batch` lets one session do it (BUILD_SPEC §5.20; FR-151–FR-153). Contracts shipped in B36 (T177), in MCP_SPEC, `mcp-copy.ts` and the snapshot together: the description below, the descriptions of `set_plan` and `update_step` (imported steps, §5.5), and the tool count (43 → 44).

#### `apply_batch`
**Description:** "Run up to 100 writes in one call, for large onboardings: each operation names a tool (create_item, update_item, link_items, upsert_label, set_plan, update_step, put_document or publish_decision) and its arguments, exactly as you would call it. Each operation runs the same checks as its single call and is applied on its own, in order: one that fails does not undo the others, and the result lists every operation with its ID or its error. "$1" in an argument means the ID operation 1 wrote. Pass idempotency_key, so a retry replays what succeeded and runs only the rest."
- **Input:** `operations: [{ op, args, idempotency_key? }]` (1–100), plus `run_id?` and `idempotency_key?`.
  - `op` is one of `create_item`, `update_item`, `link_items`, `upsert_label`, `set_plan`, `update_step`, `put_document`, `publish_decision`.
  - `args` are that tool's arguments as §5 defines them, without `run_id` (the batch's applies to every operation).
- **Output:** `{ applied, failed, results: [{ index, op, ok, id, version, text, replayed?, warnings?, error? }] }`, in the order sent. `index` is 1-based. `id` is what the operation wrote (the item for `create_item`, `update_item` and `set_plan`; the link, step, document or decision ID; the label name), null on failure. `version` is the item's version, the plan version, or the document's version number, when there is one. `text` is the single call's compact line (§3.1), or the error message. `error` is `{ code, message }`, the same code a single call would return (§6).
- **Text rendering:** a header line (`Batch: 98 applied · 2 failed · of 100`), then one line per operation in order: `#3 ` and the single call's line, or `#4 failed update_item · conflict: <message>` (the message truncated at 200 characters). Warnings are indented under their operation.
- **Atomic per operation, never all-or-nothing:** each operation is validated against its own tool's input schema, runs through the write path's checks (secrets, limits, versions, references) in its own transaction, and leaves no trace when it fails. Later operations still run.
- **`$n` references** (B36 resolution): an argument value that is exactly `"$n"` (anywhere in `args`, in arrays and nested objects too) is replaced by operation n's `id` before the operation is validated, so a batch can create an epic and its items (`epic: "$1"`). Naming this operation or a later one, or one that failed, fails this operation with `validation`.
- **Idempotency** (B36 resolution): each operation has its own key: its `idempotency_key` (on the operation, or in `args`), else one derived from the batch's key and its index. A retry with the same batch key replays the operations that succeeded (`replayed: true`) and runs the ones that failed; changing a successful operation's arguments under the same key fails it with `validation`, as for single calls. Without any key, a retry runs everything again.
- **Onboarding:** operations are tagged with the client's onboarding session like single calls (§5.11), and `set_status` isn't a batch operation.
- **Budget:** 30 tokens plus 25 per operation (§3.2).
- **Not retry-safe on its own** (`idempotentHint: false`): pass `idempotency_key`.
- **Errors** (the whole call): `validation` when `operations` is empty, has more than 100 entries, or names a tool that isn't listed. Everything else is per operation.

### 5.15 Shared changes (decision 36)

Parallel items declare the shared parts they will change (tables, models, endpoints, shared files), so Docket can stop overlapping work at the claim, hand out leases on single-writer parts, flag undeclared changes at hand-off, and warn when two branches are heading for a merge conflict (BUILD_SPEC §5.21; FR-158–FR-164). Contracts shipped in B38 (T182), in MCP_SPEC, `mcp-copy.ts` and the snapshot together:
- the four descriptions below;
- the descriptions of `claim_lead` (§5.4), `set_status` (§5.3) and `submit_packet` (§5.7);
- the three error codes (§6) and the server-instructions error line (§2);
- the tool count (44 → 48).

B38 implemented the registry, `declare_shared_changes` and `list_shared_parts`. B39 (T183) enforces the rest: the Ready gate, the overlap check at the claim, leases, the changed-file check at hand-off, and `get_context.shared`; BUILD_SPEC §5.21 lists its resolutions (the gate covers moves from Planning; the claim check compares against In progress and Review; `ready_to_start` leaves out an item waiting on the owner's overlap decision; a lease renewal writes no event).

**Hand-off** means `submit_packet` (a packet for human review) or `set_status` to `done` (closing an item with no human review). Earlier drafts named `submit_for_review` and `handoff`, which aren't Docket tools (B38 correction, agreed with the coordinator).

**B38 resolutions** (agreed with the coordinator, or settled in the build and listed in the PR):
- **Keys** are `<kind>:<name>`, where kind is `table`, `model`, `endpoint`, `file` or `other`, normalised so one part has one key:
  - `table` lowercases the name;
  - `model` keeps it as written;
  - `endpoint` is `METHOD /path`, with the method uppercased, one space, and no trailing slash;
  - `file` is a repo-relative path with forward slashes, with no leading `./` or `/` and no `..`;
  - `other` is a slug (`a-z0-9-`; spaces and underscores become `-`).

  A key is at most 200 characters. A key that doesn't parse is `validation`, naming the rule.
- **Paths** are repo-relative globs (`*`, `**`, `?`) with forward slashes: at most 20 per part, each ≤ 300.
- **Changed files** are up to 2,000 repo-relative paths, normalised like `file:` names.
- **In flight** means Ready, In progress or Review.
- **The owner question** is the overlap or hold record itself (Needs you, kinds `overlap` and `undeclared_parts`), not an `ask_owner` question, so it never takes the item's one open question (BUILD_SPEC §5.21, B38 resolutions).
- **`set_status` to `done` with undeclared parts** is refused with `not_declared` (`details.undeclared`, `details.files`), raises the same owner question as a held packet (*Add to the declaration* or *Send back*), and leaves the item where it was. Reusing `not_declared` keeps three new codes (coordinator).

#### `declare_shared_changes`
**Description:** "Declare the shared parts this item will change (tables, models, endpoints, shared files), each with add, change or remove and a short note, or none: true when it changes none. An item can't move to Ready until it has declared. Each call replaces the item's whole declaration. Name parts by their keys from list_shared_parts; register a missing one with new_parts. Returns the in-flight items that change the same parts."
- **Input:** `id`, and either `changes?: [{ part, change: 'add'|'change'|'remove', note? }]` (1–50; `note` ≤ 500) or `none?: true`; with `changes`, optionally `new_parts?: [{ key, kind?, paths?, note? }]` (1–20; `paths` ≤ 20 globs of ≤ 300; `note` ≤ 1,000), plus `run_id?` and `idempotency_key?`.
- **Output:** `{ declaration: Declaration, registered: string[], overlaps: [{ with: { id, title, status }, parts: string[] }] }` (§4). `registered` lists the keys `new_parts` added to the registry.
- **Rules:**
  - The call replaces the item's declaration: listed parts are kept or added, unlisted ones removed. `none: true` clears them and sets `items.shared_none_at`; declaring parts clears it.
  - Any open item (Inbox to Review) may declare, by any agent; a Done or Canceled item is `validation`.
  - Each `part` must be registered and not archived, or be in `new_parts`, or it is `validation` naming the key. A part may appear once.
  - `new_parts` registers each part (`created_by` the agent), never single-writer (FR-158). A key that is already registered is reused as it is, not changed, and isn't listed in `registered`. `kind`, when given, must match the key's prefix.
  - **Overlaps** are the other in-flight items in the project that declare any of the same parts, except pairs the owner marked compatible and pairs already sequenced by a `blocks` link. They are informational: the claim enforces them. Declaring later, while the item is in progress, is allowed; a new overlap then flags both items and raises the owner question without revoking the claim (BUILD_SPEC §5.21 Declaring later; B39).
- **Text rendering:** one line: `Declared 2 changes on GF-312 · registered table:decks · overlaps GF-240 on model:Token`.
- **Events:** `shared.declared` on the item, and `shared_part.saved` for each part `new_parts` registered.
- **Errors:** `validation` (limits, a key that doesn't parse, an unknown or archived part, a closed item, a secret in a note), `not_found` (item).
- **Not retry-safe** (`idempotentHint: false`): pass `idempotency_key` when you might retry.

#### `list_shared_parts`
**Description:** "List a project's shared parts (tables, models, endpoints, shared files): each key, the file paths that map to it, whether it is single-writer and who holds its lease, and the in-flight items that declared changes to it. Read-only. Call it before declare_shared_changes, to name parts by their registered keys."
- **Input:** `project`, `include_archived?: boolean = false`, plus `run_id?`.
- **Output:** `{ project, parts: [SharedPart & { in_flight: InFlightChange[], lease: { item_id, held_until } | null }] }` (§4), sorted by key; each part's `in_flight` is sorted by item ID.
- **Text rendering:** a header line (`Shared parts in GF: 12`), then one line per part (`- model:Token · single-writer · lease GF-240 until 14:05Z · paths src/Domain/Token.cs · <note>`), with its in-flight declarations indented under it (`GF-240 Token refresh · progress · change · <note>`).
- **Read-only.**
- **Errors:** `not_found` (project).

#### `take_lease`
**Description:** "Take the lease on a single-writer part (such as a migrations snapshot) for an item you lead, before you change it; call again to renew. A lease lasts 2 hours and ends when the item is done or handed off, or when you release it. If another item holds it you get lease_held with the holder and expiry: work on something else rather than waiting in a loop."
- **Input:** `id` (the item you lead), `part` (a single-writer part's key), plus `run_id?` and `idempotency_key?`.
- **Output:** `{ part, item_id, held_until, renewed }`. `renewed` is true when the item already held it.
- **Rules:** one holder per part. A lease lasts `DOCKET_LEASE_MINUTES` (default 120) from the latest take, and ends when the holder releases it, the owner releases it (*Release lease*), the holder's item reaches Done or is handed off (`submit_packet`, or `set_status` to `done`), the item is canceled, or it expires. Expiry is lazy: reads skip an expired lease, and the next take ends it (`end_reason: expired`).
- **Text rendering:** `Lease on <part> for GF-240 · until 14:05Z` (` · renewed` when renewed).
- **Events:** `lease.taken` (a renewal writes none).
- **Errors:** `lease_held` with `current: { item_id, holder, held_until }`; `validation` (the part isn't single-writer, or is archived); `forbidden` (you don't lead the item); `not_found` (item or part).

#### `release_lease`
**Description:** "Release your lease on a single-writer part as soon as your change to it is committed and pushed, so other items can take it."
- **Input:** `id`, `part`, plus `run_id?` and `idempotency_key?`.
- **Output:** `{ part, item_id, released: true }`.
- **Text rendering:** `Released lease on <part> for GF-240`.
- **Events:** `lease.ended` (`end_reason: released`).
- **Errors:** `forbidden` (you don't lead the item), `not_found` (the item holds no lease on that part).

#### Changes to existing tools
- **`claim_lead`** (§5.4): accepts `branch` (≤ 200; defaults to `workspace.branch`), stored on the run for the radar. It may fail with `seam_conflict` (`details: { with, parts }`): the item's declared parts overlap another in-flight item's, and that pair is neither compatible nor sequenced by a `blocks` link. The item stays Ready, the refusal is recorded as a rejected claim the owner can see, and one overlap (an owner question) is opened per pair; claiming the same pair again doesn't open a second. The description tells the agent to pick other work.
- **`set_status`** (§5.3):
  - to `ready`, from an agent, it fails with `not_declared` unless the item has declarations or declared none (the owner's route takes `override_reason`);
  - to `done`, it accepts `changed_files` and `branch`, mapped through the parts' `paths`; changes to undeclared parts refuse the move with `not_declared` and raise the owner question;
  - to `done`, it also ends the item's leases (`end_reason: done`).
- **`submit_packet`** (§5.7): accepts `changed_files` and `branch`. Changes to undeclared parts create the packet held (`held_undeclared` in the result; the human review gate stays closed) and raise the owner question. Without `changed_files`, an item with declarations shows "Changed files not reported" on the packet. A packet ends the item's leases (`end_reason: handed_off`).
- **`get_context`** (§5.2): adds `shared` (§4 `ContextShared`; BUILD_SPEC §5.21 Context).

**New error codes** (§6): `seam_conflict`, `not_declared`, `lease_held`. Over the UI API they map to 409, 400 and 409.

## 6. Errors

Every error is returned as a tool result: `isError: true`, a `text` block holding the message, and `structuredContent: ToolError`. Messages are one or two sentences: what happened, then what to do.

| Code | When | Example `message` | Extras |
|---|---|---|---|
| `validation` | Bad input, a disallowed transition, limits, cycles | "Can't close RCP-14: 1 human review item is undecided. Submit a packet with submit_packet." | `details` (field errors, `allowed`, `cycle`) |
| `conflict` | Version mismatch, claim held, run ended | "RCP-15 is led by codex · orca-w1 (lease until 11:13 UTC). Pick another item." | `current` (record or claim) |
| `not_found` | Unknown ID, or deleted | "No item RCP-99. Check the ID with search_items." | — |
| `forbidden` | Owner-only operation, someone else's run, owner-added or locked item | "hr_01J… was added by the owner; only the owner can change it." | — |
| `unavailable` | Database busy past 5 s, disk full, maintenance (restore) | "Docket is busy; retry in a few seconds with the same idempotency_key." | `details.retry_after_s` |
| `internal` | Bug | "Unexpected error (ref e_01J…). It has been logged." | `details.ref` |
| `seam_conflict` | Decision 36: a claim whose declared shared parts overlap another item in flight (§5.15) | "GF-312 changes model:Token, like GF-240 (In progress). Pick other work: the owner has been asked whether they can run together." | `details.with` (item IDs), `details.parts` (keys) |
| `not_declared` | Decision 36: moving to Ready before declaring shared changes, or closing as done with changed files mapped to undeclared parts (§5.15) | "Declare the shared parts GF-312 will change (or none) with declare_shared_changes, then move it to Ready." | `details.undeclared`, `details.files` (on done) |
| `lease_held` | Decision 36: taking a single-writer part's lease that another item holds (§5.15) | "file:…/GameflowDbContextModelSnapshot.cs is leased to GF-240 (claude · orca-w2) until 14:05 UTC. Work on something else." | `current: { item_id, holder, held_until }` |

JSON-RPC protocol errors (malformed requests, unknown tool) follow the MCP spec and are separate from these.

---

## 7. Worked flows

Abbreviated calls: arguments shown as JSON, results trimmed with `…`.

### 7.1 Start a session and pick up work
```
whoami → { client: "claude", … }
search_items { project: "RCP", filter: "resumable" }            → []        (nothing sent back to resume)
search_items { project: "RCP", filter: "ready_to_start", limit: 5 } → [RCP-17, RCP-25, …]
claim_lead { id: "RCP-17", agent_label: "orca-w3" }              → { run_id: "run_01JA…", lease_expires_at: … }
get_context { id: "RCP-17" }                                     → outcome, 1 owner decision on the epic, epic brief, no blockers, no docs
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
set_plan { id: "RCP-17", run_id, reason: "Found a second cause", steps: [{ text: "Clear the stale cache key on reload", after: "wst_…2" }] }
                                                                   → plan v2; nothing else changed (patch)
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

### 7.10 Recording and following decisions
```
get_context { id: "RCP-16" } → decisions: dec_7 "Nutrition is per serving; 100 g goes in a footnote" (owner)
publish_decision { project: "RCP", scope: { kind: "epic", id: "RCP-1" },
  title: "Units are stored metric; convert on display",
  decision: "Store g and ml. Convert cups and spoons on import (RCP-14) and display.",
  rationale: "One canonical unit keeps merging simple." }        → dec_9, authority agent
```
The owner sees dec_9 on RCP-1 and its tickets, and may *Confirm* it (it becomes an owner decision) or *Withdraw* it. To change an owner decision, an agent uses `ask_owner`; `publish_decision` with `supersedes: dec_7` returns `forbidden`.

### 7.11 Stricter dependency: wait for the merge
```
link_items { from: "RCP-19", to: "RCP-16", type: "blocks", satisfied_when: "merged" }   (updates the existing link)
  (RCP-19 closes as done)
get_item { id: "RCP-16", view: "summary" } → blocked_by: DOC-4, RCP-19 (waiting for merge)
link_artifact { id: "RCP-19", kind: "pr", label: "PR #52", url: "…", state: "merged" }
get_item { id: "RCP-16", view: "summary" } → blocked_by: DOC-4          (RCP-19 cleared; DOC-4 still open)
```
In V1 the merge is agent-reported, and the UI says so. A GitHub integration would observe it instead (ROADMAP.md).

---

### 7.12 Parking while you wait
```
claim_lead { id: "RCP-23", agent_label: "orca-w2", workspace: { path: "C:/…/rcp-23", branch: "rcp-23-templates", base_ref: "origin/main", base_sha: "9a10624" },
             orchestrator: { name: "orca", dispatch_id: "ctx_…" }, brief: "Implement meal plan templates per …" } → run_A
  … work …
report_commit { id: "RCP-23", run_id: "run_A", sha: "c1d2e3f", pushed: true }
park_run { run_id: "run_A", reason: "Waiting for RCP-12 (planner) to merge before wiring templates in", waiting_on: { items: ["RCP-12"] } }
  (hours later RCP-12 is done; recovery_report lists run_A under parked with resume_ready: true)
heartbeat { run_id: "run_A", note: "Resuming after RCP-12" }    → run_state live (unparked)
```

### 7.13 Crash recovery (coordinator)
```
recovery_report { include_briefs: true }
  → interrupted: RCP-15 (service_restart) · 2/4 done · ws C:/…/rcp-15 @ 4be1c09 (pushed) · dirty false
               RCP-21 (lease_expired) · 1/3 done · ws C:/…/rcp-21 @ 77aa001, pushed 6f00e12 · dirty true   ← at risk
  → parked:    RCP-23 waiting on RCP-12 · resume_ready true
  → workspaces: rcp-15 at_risk (interrupted, not yet re-dispatched); rcp-30 safe_to_prune
  → orphaned_resources: dev server :5173 (RCP-21, run ended 03:12)
```
Then, for each entry:
1. **Find the code.** If the worktree still exists, reuse it. If it's gone, recreate it from `pushed_sha` on its branch. If `dirty` was true or `head_sha` was ahead of `pushed_sha`, tell the owner that work may be lost (it already shows under their Problems).
2. **Re-dispatch** a worker with the stored brief, unchanged, plus "Resume from the checklist; claim_lead first".
3. **Clean up** the orphaned resources (stop the process, end the session). The new run, or the owner, marks them released.
4. **Prune** only workspaces in `safe_to_prune`.

The resumed worker calls `claim_lead`, which works on In progress items with no lead, then `get_context` and `get_item`, and continues from the first unfinished step.

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
| Marks an orphaned resource released, or unpushed work handled | `resource.released` or `run.unpushed_handled` (actor owner); the workspace may become `safe_to_prune` |
| Releases a stale claim | `claim.released`; the old run is `interrupted`; the item is back to `ready`; calls with the old `run_id` get `conflict` |
| Moves to Ready, or back to Planning | `item.status_changed` |
| Archives | `item.archived` (agent queries still include archived items) |
| Cancels an item | `item.status_changed` to `canceled` (`actor: owner`). If you led it, your run is `interrupted` and later calls naming it get `conflict` with the canceled state. Stop work on it. |
| Edits the title, description, outcome or acceptance criteria | `item.updated` with `actor: owner`; the item's `version` changes, so an agent update based on an older version gets `conflict`. Re-read and keep the owner's text. |
| Records, confirms or withdraws a decision | `decision.published` (`authority: owner`), `decision.confirmed` or `decision.withdrawn`; `get_context` reflects it immediately |
| Changes a project's "blockers clear when" rule | `project.updated`; items may become blocked or unblocked, so recheck with `search_items` |

---

## 9. Implementation notes

- **Session and run binding.** Record the MCP session ID on each run. A *session* signal (BUILD_SPEC §5.4) requires the call's session to match the run's. Calls naming a run from a different session count as *report*.
- **Tool registration.** Generate the MCP `inputSchema` and `outputSchema` from the zod schemas in `shared/` (e.g. with `zod-to-json-schema`). Descriptions come from one `shared/mcp-copy.ts` file whose strings match this document; a unit test compares them.
- **Text rendering.** The compact text block (§3.1) comes from renderers in `shared/compact.ts`, one per result type. Snapshot tests render the seed data, and the token-budget tests measure these outputs.
- **Write checks.** Secret detection (§3.4) runs in the domain layer, so the UI API applies it too. Patterns live in `shared/secrets.ts`.
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
11. Token budgets (§3.2) hold for the listed calls on the seed data. The test prints the actual numbers, so regressions are visible.
12. Patch semantics: `set_plan` and `set_checks` in patch mode never remove unlisted entries; `replace` removes only agent entries; `update_item` leaves absent fields alone.
13. Decisions: scope inheritance (project → epic → label → item) in `get_context` and `list_decisions in_scope_of`; agents get `forbidden` on owner records; supersede and withdraw states.
14. `satisfied_when`: done, merged and verified each gate `ready_to_start` correctly, a link override beats the project default, and verified on a blocker without human review gets `validation`.
15. Write checks: each secret pattern is rejected and not persisted; references to items that don't exist produce warnings.
16. `get_context` never marks notes read; `get_item` view `summary` doesn't either.
17. Parking: a parked run never goes stale and keeps its claim. Its lease is suspended. It shows `resume_ready` when its items clear. A heartbeat resumes it. After `DOCKET_PARK_MAX` it is flagged but keeps its claim.
18. Workspace state: in_use, parked, at_risk (dirty, unpushed, unreleased resources) and safe_to_prune are each reached from the right inputs; `report_commit pushed:true` moves `pushed_sha`.
19. `recovery_report` after a simulated restart lists every interrupted run with its end reason, its brief (with `include_briefs`), its workspace, its checklist progress and its orphaned resources, and the §7.13 flow re-claims and resumes it.
20. `finish_run` with unreleased resources or unpushed commits warns, and the owner sees the matching Problem.
21. `apply_batch` (decision 34): at least 150 operations through batches in one session, each with its own result; a failing operation (secret, stale version, bad `$n`) fails alone and writes nothing; a retry with the same key replays what succeeded; within its budget. Imported steps take added details, and refuse rewrites.
22. Shared changes (decision 36): the Ready gate refuses an undeclared item (`not_declared`) and takes the owner's override; two agents claiming overlapping items unattended: the second gets `seam_conflict`, one question is raised per pair, and *Run one after the other* and *They're compatible* each let work continue (SC-023); a held lease gets `lease_held`, and leases end on done, hand-off, release and expiry; changed files mapped to undeclared parts hold the packet, or refuse the close; `get_context.shared` stays within budget. B38 ships the contract and the registry; B39 (T183) the rest.

---

## 11. Client setup

**Default (decision 32):** no commands. Installing the agent files into a repo (Agent files → *Install*) writes `.mcp.json` (Claude Code) and `.codex/config.toml` (Codex) there; open the client in that repo and approve the one-time prompt. The commands below remain for a user-wide connection, and for protected mode, which needs the token. In local trust, leave out the `--header` and `bearer_token_env_var` lines below (Settings → Connections shows the snippets for the mode in use). Checked in B31: headless `claude -p` uses the project `.mcp.json` without a prompt; `codex exec` reads the project's `.codex/config.toml` only once the folder is trusted.

The commands below were checked against the clients' current documentation on 2026-11-07. The real-client smoke test (BUILD_SPEC §10) is still the final check.

### Token
- **Where it comes from:** Settings → Connections → *Reveal token* (or `docker compose exec docket docket agent-token`).
- **Put it in the environment** the agent clients run in, as `DOCKET_TOKEN`. On Windows: `setx DOCKET_TOKEN "<token>"`, then open a new terminal. Orca workers must see the same variable (BUILD_SPEC §12, V2).
- **Watch for whitespace:** a trailing newline in the token breaks auth, and Claude Code warns about hidden whitespace.

### Codex
Source: Codex MCP docs, `learn.chatgpt.com/docs/extend/mcp?surface=cli`.
- **Where:** add this to `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`). The token is read from the environment on every connection and never stored in the file:
  ```toml
  [mcp_servers.docket]
  url = "http://127.0.0.1:7420/mcp"
  bearer_token_env_var = "DOCKET_TOKEN"
  ```
- **Flags:** none needed; Streamable HTTP isn't behind an experimental flag.
- **No CLI form:** `codex mcp add` has no documented bearer-token flag for HTTP servers, so use the config file.
- **Result mode:** structured (§3 Results). Which part Codex gives the model is still to verify (BUILD_SPEC §12, V6); if it is `structuredContent`, add its `clientInfo.name` to `DOCKET_TEXT_ONLY_CLIENTS`.

### Claude Code
Source: `code.claude.com/docs/en/mcp`. Flags come before the name, and the name before the URL.
- **For every project (user scope; recommended):**
  ```bash
  claude mcp add --transport http --scope user docket http://127.0.0.1:7420/mcp \
    --header "Authorization: Bearer $DOCKET_TOKEN"
  ```
  PowerShell: `--header "Authorization: Bearer $env:DOCKET_TOKEN"`.

  **Caveat:** your shell expands the variable when you run this, so Claude Code stores the token itself in its user config. That's acceptable for a loopback-only service. If you rotate the token, run the command again.
- **One repo only (project scope):** add `.mcp.json` at the repo root. Claude Code expands `${DOCKET_TOKEN}` in this file, so the token isn't stored. The first time, it shows as "Pending approval" until you approve it in an interactive `claude` session.
  ```json
  {
    "mcpServers": {
      "docket": {
        "type": "http",
        "url": "http://127.0.0.1:7420/mcp",
        "headers": { "Authorization": "Bearer ${DOCKET_TOKEN}" }
      }
    }
  }
  ```
  Note: `type` must be `http`. An entry with a `url` but no `type` is treated as stdio and skipped.
- **Check it:** `claude mcp list` should show `docket … ✔ Connected`. Inside Claude Code, `/mcp` shows the status.
- **Result mode:** text-only (§3 Results). Claude Code sends `clientInfo.name` `claude-code` and gives the model `structuredContent` when there is one (BUILD_SPEC §12, V6), so by default it gets no `outputSchema` and no `structuredContent`, and its model reads the compact text.

### Orca workers
Orca launches the installed Codex or Claude, so the configurations above apply as long as the worker inherits your user config and environment. That's verified for Codex workers; Claude workers are still to verify (BUILD_SPEC §12, V2). Settings shows "Not verified" until the smoke test passes. A worker sends its client's `clientInfo.name`, so it gets that client's result mode: text-only for Claude, structured for Codex. Settings shows each surface's mode.

### Settings snippets
The Client setup card in Settings (UI_SPEC §6.7) shows exactly the Codex TOML and the user-scope Claude command above, with the token as `$DOCKET_TOKEN`, never the value.
