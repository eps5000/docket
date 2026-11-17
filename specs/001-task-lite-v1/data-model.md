# Data Model: Task Lite V1

Phase 1 output. The columns are authoritative in [BUILD_SPEC §4](../../docs/BUILD_SPEC.md), and the
MCP shapes in [MCP_SPEC §4](../../docs/MCP_SPEC.md). This file adds what tasks and tests need:
- relationships;
- validation rules;
- state machines, each tied to a spec requirement.

**Conventions:**
- every row has `id`, `created_at` and `updated_at` (UTC ISO-8601);
- mutable entities carry an integer `version`;
- every mutation appends `events` in the same transaction.

## Entities

| Entity | Key fields | Relationships | Validation (spec ref) |
|---|---|---|---|
| **Project** | `key` (2–5 uppercase letters), `name`, `color`, `next_seq`, `default_satisfied_when` | has items, labels, decision records, documents | key is unique; deleting removes children and the docs directory together (FR-104) |
| **Item** | `id` `<KEY>-<n>`, `type`, `title`, `description_md`, `outcome_md`, `status`, `priority`, `epic_id`, planned dates plus `dates_set_by`/`at`, `effort`, `closed_by`, `archived_at`, `jira_key`, `imported`, `from_review`, `version` | belongs to a project, and optionally to an epic (an Epic in the same project); has acceptance criteria, labels, links, a checklist, runs, packets, a question, notes, documents, commits, artifacts | title ≤ 200, Markdown ≤ 20,000, priority 1–3, effort ≥ 0; an epic can't have an epic; archiving requires `done` (FR-001/002, US7) |
| **AcceptanceCriterion** | `item_id`, `position`, `text` | ordered list on an item | ≤ 500 each; the owner edits inline (decision 22) |
| **Label** | `project_key`, `name`, `brief_md` | many-to-many with items | name is `a-z0-9-`, ≤ 40; unique per project |
| **Link** | `from_id`, `to_id`, `type` (`blocks`/`relates`), `satisfied_when` (null = project default) | item → item, across projects | no self-links; `blocks` can't close a cycle (FR-032); `verified` needs the blocker to have human review items (FR-034) |
| **PlanVersion / WorkStep** | step `text`, `state`, `was_text`, `change_reason`, `added_by`, `from_review`, `state_by`/`at` | an item has plan versions; each step belongs to the current version | ≤ 30 steps; text ≤ 500; a reason is required after v1; owner steps are always kept (FR-017) |
| **SubagentLog** | `name`, `outcome`, `evidence`, `provenance` (`observed`/`relayed`), `child_run_id` | under a work step | name ≤ 60, outcome ≤ 500 (FR-018) |
| **AgentCheck** | `text`, `state` (`todo`/`pass`/`fail`/`skipped`), `evidence`, `provenance`, `added_by` | on an item | ≤ 30 checks; owner checks are always kept |
| **HumanReviewItem** | `text`, `state`, `added_by`, `last_decision`, `follow_up_item_id`, `version` | on an item; included in packets | locked while `ready`; agents can't change owner-added items (FR-019) |
| **Packet** | `round`, `content_hash`, `built_from_commit`, `estimate`, `how[]`, `checked[]`, `gaps[]`, `state` | on an item; has packet items (text snapshots), attachments (document versions) and review decisions | one open packet per item; submit guards (FR-020) |
| **ReviewDecision** | `kind`, `note`, `into`, `follow`, `result_ref` | one per packet item; owner only | a note is required for `changes` (FR-050) |
| **Run** | `client`, `label`, `session_id`, `is_lead`, `parent_run_id`, `state`, `last_signal_at`, `last_signal_kind`, `lease_expires_at`, `current_step_id`, `summary`, `error` | on an item; a child run has a parent | at most one active lead run per item (FR-013) |
| **Question** | `text`, `answer`, `answered_at`, `read_by_agent_at` | on an item (and its run) | at most one open per item; text ≤ 2,000 (FR-022) |
| **OwnerNote** | `text`, `read_by_agent_at` | on an item | delivered once (FR-021) |
| **DecisionRecord** | `scope_kind`/`scope_id`, `title`, `decision_md`, `rationale_md`, `authority`, `author`, `status`, `supersedes_id`, `confirmed_at`, `version` | in a project; scoped to a project, epic, label or item | title ≤ 120, decision ≤ 4,000; agents can't change owner records (FR-041–043) |
| **Document / DocumentVersion** | `name`, `kind`; version `version_no`, `mime`, `size`, `sha256`, `path` | on an item or project | versions are immutable; 25 MB through MCP, 500 MB through HTTP (FR-070) |
| **Commit / Artifact** | `sha`, `branch`, `pr_url` / `kind`, `label`, `url`, `state`, `provenance` | on an item | sha is 7–40 hex; a `pr` artifact with state `merged` satisfies `merged` (FR-031) |
| **Workspace** *(columns on `runs`)* | `workspace` JSON (host, repo, path, branch, base_ref, base_sha, head_sha, pushed_sha, dirty), `orchestrator` JSON, `brief_document_version_id`, `end_reason`, `parked_reason`, `waiting_on`, `parked_at`, `external`, `unpushed_handled_at` | on a run; state derived per path | external ≤ 2 KB; brief ≤ 20,000 (FR-110 to FR-112, FR-114) |
| **RunResource** | `id` `rsc_…`, `kind`, `label`, `locator` JSON, `started_at`, `released_at`, `released_by`, `release_note` | on a run | label ≤ 120; ≤ 10 per heartbeat (FR-113) |
| **AgentFile / AgentFileVersion** | `key`, `layer` (bundled/service/project), `project_key`; version `content`, `sha256`, `author`, `note` | per project for the project layer | versions immutable; one current per key, layer and project (FR-121) |
| **ProjectWorkflow** | `project_key`, `version_no`, `content_md` | on a project | ≤ 10,000 characters (FR-123) |
| **Install** | `client`, `target_kind`, `path`, `method`, `manifest` | optional project | logged on token use or push (FR-126) |
| **Event** | `seq` (the cursor), `actor_kind`, `client`, `label`, `run_id`, `type`, `summary`, `data`, `inverse`, `mutation_id`, `idempotency_key` | references a project and item | append-only (FR-006); the `inverse` is used by owner undo |
| **Idempotency** | `key`, `client`, `request_hash`, `response`, `expires_at` | — | 24 h (FR-007) |
| **OwnerSession** | `id`, `last_seen_at`, `user_agent` | — | 30-day sliding expiry; key rotation ends all sessions (FR-101) |
| **ImportSession** *(memory only)* | Jira site, email, token, project key, target, report | creates items on commit | the token is never persisted (FR-092) |

## State machines

### Item status (FR-003 to FR-005; BUILD_SPEC §5.1)
```
inbox ──► planning ◄──► ready ──claim──► progress ──submit_packet──► review
                          ▲                │  ▲                         │
                          │    release /   │  │ any "changes" / fresh   │
                          └─ lease expiry ─┘  └──── packet request ─────┘
progress|review ──(no undecided review items)──► done ──reopen──► progress
any open ──(reason)──► canceled
progress (no lead) ──claim──► progress            (resume: "resumable")
```
- **Done:** blocked while any human review item is `declared` or `ready`.
- **Epic → Done:** only once every child is done or canceled.

### Human review item (FR-019, FR-050 to FR-053)
```
declared ──submit_packet──► ready ──approve──► approved   (carries forward to later rounds)
                              ├──changes──► declared   (last_decision holds the note)
                              ├──defer────► deferred   (follow-up ticket optional)
                              └──fresh packet requested──► declared
```

### Packet
- `open` → `decided` (the owner submitted decisions), or `withdrawn` (the owner asked for a fresh packet).
- **Stale** is derived: an open packet with a newer commit reported for its item, or for any child if the packet is epic-level (FR-052).

### Run (FR-013 to FR-016; displayed state is derived, see BUILD_SPEC §5.4)
- **Stored state:** `open` → `needs_input` (question asked) → `open` (answer read); then `finished`, `failed` or `interrupted`.
- **Parked** (FR-112): `open` ──park_run──► `parked` ──any call with its `run_id`──► `open`. While parked the lease is suspended (never stale, claim kept). `resume_ready` is derived when every `waiting_on` item clears. Past `TASKLITE_PARK_MAX` (24 h) it's a Problem, not an expiry.
- **Interrupted** comes from lease expiry, owner release, or a service restart.
- **`end_reason`** is set on every terminal transition: `finished`, `failed`, `released`, `lease_expired`, `owner_released`, `service_restart`, `canceled` (FR-114).
- **Displayed state:**
  - live: a session signal within 2 min;
  - reported: no session signal within 2 min, but some signal within 30 min;
  - stale: no signal for 30 min;
  - otherwise the stored terminal state.

### Decision record (FR-041 to FR-043)
- `active` → `superseded` (a newer record supersedes it), or `withdrawn`.
- **Confirming** sets `authority` from agent to owner, plus `confirmed_at`.

### Blocker cleared? (FR-031 to FR-035)
```
effective rule = link.satisfied_when ?? project(blocked item).default_satisfied_when ?? done
done     → blocker.status = done
merged   → done ∧ ∃ artifact(kind=pr, state=merged)
verified → done ∧ every human review item approved (none deferred)
canceled blocker → never cleared (problem: remove link)
```

## Derived (never stored)
- blocked;
- ready to start;
- resumable;
- for you (packet ready, or an open question);
- date risk;
- cycle membership (strongly connected components);
- displayed run state;
- workspace state per path (`in_use`, `parked`, `at_risk`, `safe_to_prune`, `unknown`), orphaned resources, unpushed-at-risk, `Item.resume` (FR-113 to FR-115);
- packet stale;
- for-you count (badge, tab title).
