/**
 * Product copy for agents (constitution Principle IV; MCP_SPEC §2 and §5).
 *
 * The server instructions and every tool description are MCP_SPEC.md
 * verbatim, character for character. They change only together with
 * MCP_SPEC.md; the contract snapshot test reads the spec at test time and
 * fails on any drift. Shared contract file (tasks.md, Slice rules).
 */
import type { ToolName } from './mcp/tools.js';

/** MCP_SPEC §2: returned as `instructions` in the `initialize` result. */
export const SERVER_INSTRUCTIONS = [
  "Docket coordinates the owner's agent work. Use it to find work you may start, get its context, record your plan and progress, follow and record decisions, and hand finished work to the owner for review. It enforces claims, dependencies and review gates for you. The owner supervises in a web UI; keep entries short and factual.",
  '',
  'Workflow: Inbox → Planning → Ready → In progress → Review → Done.',
  '- Only start work that is Ready (search_items filter "ready_to_start") or was sent back to you (filter "resumable"). Claim it first with claim_lead; if someone else holds it, pick something else.',
  '- Then call get_context: one call that gathers the item, the decisions you must follow, the epic and label briefs, blockers and planning docs. Start with budget "small" and widen only if needed.',
  '- Follow active decision records. Owner decisions are authoritative; to challenge one, use ask_owner. Record decisions other agents must follow with publish_decision.',
  "- Planning belongs to the owner. You may draft planning documents (put_document) and move an item to Ready only when the project's workflow (AGENTS.md / CLAUDE.md) says you may.",
  "- To change your instructions for a project, propose it with propose_agent_file_change; don't edit installed files directly.",
  '- To set up a new project or onboard a repo, call onboard_project and follow the guide it returns.',
  "- Your plan is the item's checklist, not new tickets: set_plan with one-line steps, update_step as you go. Split work into a new ticket only when a step needs its own blocker, owner or review.",
  '- Record what you verify yourself with set_checks. Record subagent work with log_subagent; say whether you observed it or are relaying it.',
  '- If the owner must verify something by hand, declare it with declare_human_review, ideally during Planning. The item cannot close while any human review item is undecided.',
  '- Report each commit for the item it belongs to (report_commit). When the work is built and your checks pass, hand off with submit_packet. If there is no human review, close it with set_status "done".',
  "- Decide technical, reversible choices yourself. If only the owner can decide, ask_owner in plain words for someone who hasn't seen this work, then stop; the answer arrives in get_item.",
  '- Pass run_id on every call while you are working; it keeps your claim alive and shows you as live. Call finish_run when you stop.',
  '- Say where your work lives: pass workspace (worktree path, branch, base) to claim_lead, push work in progress at every checklist step, and report_commit with pushed true.',
  '- If you must wait (on another item, the coordinator or a person), call park_run with what you are waiting on. Never just go quiet: a silent run looks stale and loses its claim; a parked run keeps it.',
  '- Coordinators: get_digest replaces a round of reads. To wait, run the installed docket-wait script, which costs no tokens until something changes; never poll in a sleep loop.',
  '- Declare long-lived things you start (dev servers, sessions, containers) with heartbeat resources_started, and release them before finish_run. Coordinators: after a crash or restart, start with recovery_report, and never prune a workspace it lists as in use or at risk.',
  "- After any pause, call get_item: it delivers the owner's notes, answers and review decisions, each once.",
  '- Send only what changes. update_item, set_plan and set_checks patch: whatever you leave out stays as it is. Use get_item view "summary" when you only need status.',
  '',
  'Errors are structured (code: validation | conflict | not_found | forbidden | unavailable | internal | seam_conflict | not_declared | lease_held | design_review | project_paused | epic_not_ready | release_gates). On conflict, read the current state in the error and retry only if your change still makes sense.',
].join('\n');

/** MCP_SPEC §5: the exact `description` registered for each tool. */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  whoami:
    'Check your connection: how the server identifies you, limits and server time. Call once at session start.',
  list_projects: 'List projects with item counts and keys.',
  search_items:
    'Find items. Filters: ready_to_start (what you may start), resumable (resume it), blocked, waiting_for_review, mine, deferred_review. Combine with project, status, type, label, epic or text.',
  get_item:
    "Get one item: description, acceptance, blockers, checklist, runs, question and answer, owner notes, documents, packets, activity. Owner notes and answers are delivered once: read them now. view 'summary' for status only.",
  get_context:
    "Everything needed to work on an item in one call: outcome, acceptance, decisions to follow, briefs, blockers, workflow notes, planning documents, the last review's notes. Sized to a budget. Read-only.",
  dependency_subgraph:
    'Show what blocks an item and what it blocks, with status and planned dates. delay_days shows what a slip would push.',
  deferred_reviews:
    'List human review checks the owner deferred, with any follow-up ticket. For cleanup.',
  get_changes:
    'Read changes since a cursor; without one, returns the latest cursor. To wait, run the installed docket-wait script (no tokens), or pass wait_s (at most 45). Never poll in a sleep loop.',
  get_digest:
    'One compact snapshot for coordinators: what to start next, bottlenecks, runs, blockers, what waits on the owner, problems, leases and the change cursor. Pass cursor for only what changed. Read-only.',
  create_item:
    "Create an item in Inbox or Planning; an Epic also gets its Release. Pass outcome_md, acceptance and shared (part keys or 'none'), or it Needs shaping. To split, use split_from with 1-based acceptance positions.",
  update_item:
    "Edit an item's fields; pass expected_version. Status goes through set_status, the plan through set_plan. known_gaps: what implementation will settle.",
  set_status:
    'Move an item. Docket enforces the allowed moves and their gates (not_declared, design_review, release_gates). Closing as done: pass changed_files and branch. Hand off for review with submit_packet. Details: docket-worker reference status-moves.',
  link_items:
    "Link two items: 'blocks' (from finishes before to starts) or 'relates' (informational). satisfied_when: done, merged or verified. Calling again updates it; a cycle is rejected.",
  unlink_items: 'Remove a link between two items.',
  upsert_label:
    'Create a label or update its brief: an initiative across epics, with its shared decisions.',
  claim_lead:
    "Claim an item as its lead before working on it. Pass workspace, branch, brief and docket-check's output as instructions. Returns run_id: pass it on every call. Errors: conflict, seam_conflict, design_review: take other work.",
  release_lead:
    'Give up the lead without finishing; pass exit. The item returns to Ready with your plan; under a producer it waits for the next worker unless you pass release_story.',
  start_run:
    'Start a child run under your lead run for a subagent with its own Docket connection; it passes the child run_id. Without a connection, use log_subagent.',
  heartbeat:
    "Say you're still working: current step, workspace, resources started or released. Any call with run_id keeps you live; use this only when nothing else applies.",
  finish_run:
    "End your run: 'finished', or 'failed' with an error; exit: complete, or partial with what's left. Hand off or close the item first. Details: docket-worker reference exit-reports.",
  park_run:
    'Park when the work itself stops (another item, the coordinator, a person), not while CI runs. Keeps your claim; say what you wait on. Any write with your run_id resumes it. Details: docket-worker reference waiting.',
  update_run_status:
    "Coordinators: set a lead run's status or wait, or report verified Orca dispatch liveness through dispatch_observation. No run_id; coordinator is your name. Reporting never resumes or releases the run. Details: docket-coordinator reference parked-workers.",
  set_plan:
    "Publish or revise your plan as one-line steps, with optional details and source. Patches: steps with an id update, others are added, remove lists what goes; mode 'replace' restates it.",
  update_step:
    "Update a step's state: current, done, or blocked or skipped with a note. details replaces its details (expected_details_version from get_step); on a Jira step, only add.",
  log_subagent:
    "Record what a subagent contributed, as a line under its step: provenance 'observed' or 'relayed'. Never creates a ticket.",
  set_checks:
    'Publish what you will verify yourself, with state and evidence. Patches like set_plan; owner-added checks stay.',
  update_check: "Update one check's state and evidence.",
  declare_human_review:
    'Declare what the owner must verify by hand before the item can close, one plain instruction each, early. For one PR across an epic, declare on the epic. Details: docket-review-packet.',
  update_human_review:
    "Edit or remove a human review item you declared. Items in an open packet are locked; owner-added items are the owner's.",
  add_note:
    "Add a short note to the item's activity: decisions, surprises, anything the owner should know. A sentence or two.",
  put_document:
    'Store a document on an item or project; the same name makes a new version. content_text, or content_base64 up to 25 MB (larger: POST to /agent-upload, then pass document_version_id).',
  link_artifact:
    'Link external evidence: a PR, CI run, deployment, test report or URL. A link is evidence, never approval.',
  report_commit:
    'Report every commit for its item, and set pushed true once it is on the remote. A packet built from an older commit is marked out of date.',
  submit_packet:
    'Hand finished work to the owner for review once built, checked and every commit reported, with changed_files and branch. The owner must be able to verify without asking you. Details: docket-review-packet.',
  get_review:
    "Read the owner's review decisions, round by round. 'changes' notes became steps or Bugs (result_ref); approved items stay approved; deferred items aren't verified.",
  ask_owner:
    'Ask the owner what only they can decide, in plain words; IDs, paths and links go in details. Stop the work that depends on it; the answer arrives in get_item. Details: docket-worker reference asking.',
  publish_decision:
    'Record a decision other agents must follow, with a short rationale, scoped as narrowly as it applies. You can supersede an agent decision; only the owner changes owner decisions.',
  list_decisions:
    "List a project's decision records, optionally for one scope; active only unless include_inactive.",
  withdraw_decision:
    'Withdraw an agent decision that no longer applies, or pass question_id to retract an outdated, unanswered question.',
  recovery_report:
    'After a crash or restart, or before pruning: interrupted, stale and parked runs, every workspace as in use, at risk or safe to prune, and resources left running; never prune a workspace in use or at risk. Details: docket-coordinator reference crash-recovery.',
  get_agent_files:
    'Read the agent files (skills, references, AGENTS.md block) and Workflow notes in effect for a project, with version_id. Pass file for its text, and propose changes from it, not your installed copy.',
  propose_agent_file_change:
    "Propose new content for an agent file or a project's Workflow notes, with a reason: the whole text and based_on_version_id from get_agent_files. Omit project for the default. The owner approves it.",
  onboard_project:
    'Set up a project or onboard a repo: creates it (pass name) or adopts it, and returns session_id, what it holds and the guide to follow. Pass idempotency_key.',
  finish_onboarding:
    'Finish an onboarding session (session_id from onboard_project) and hand it to the owner with a short summary and open questions. Then stop.',
  get_step:
    'Read one checklist step in full: text, state, source, details, history and subagent notes. Read-only.',
  apply_batch:
    'Run up to 100 writes in one call, in order, each a tool and its arguments; a failure doesn\'t undo the others. "$1" is the ID operation 1 wrote. Pass idempotency_key. Details: docket-planner reference batch-writes.',
  declare_shared_changes:
    'Declare the shared parts this item will change (add, change or remove, with a note), or none: true. Required before Ready; each call replaces it. design_impact pauses the item for the owner. Details: docket-worker reference shared-parts.',
  list_shared_parts:
    "List a project's shared parts: paths, whether single-writer, the lease holder and in-flight declarations. Read-only.",
  take_lease:
    'Take the lease on a single-writer part before changing it; call again to renew. It lasts 2 hours. On lease_held, work on something else; never wait in a loop.',
  release_lease: 'Release your lease on a single-writer part as soon as your change is pushed.',
  propose_resolution:
    'Propose how to resolve a problem that needs the owner: split, rescope, reorder or other, with plan_md and reason. Pass problem (from get_context) or id. Details: docket-worker reference shared-parts.',
};

/**
 * One result-summary template per tool: the first line of its compact text
 * (MCP_SPEC §3.1). `{name}` placeholders are filled by `fillSummary`. For a
 * mutation this is the whole result: what changed and the new version.
 */
export const TOOL_SUMMARIES: Record<ToolName, string> = {
  whoami: 'Connected as {client} · session {session_id} · Docket {server_version} · {server_time}',
  list_projects: 'Projects: {count}',
  search_items: 'Items: {count}{more}',
  get_item: '{id} {title}',
  get_context: 'Context for {id} {title} · budget {budget}',
  dependency_subgraph: '{id} dependencies · {nodes} items · {edges} links',
  deferred_reviews: 'Deferred human review checks: {count}{more}',
  get_changes: 'Events: {count} · next_cursor {next_cursor}',
  get_digest: 'Digest {project} · cursor {cursor}{since}',
  create_item: 'Created {id} {title} · {status} · v{version}',
  update_item: 'Updated {id} · {changed} · v{version}',
  set_status: 'Moved {id} to {status} · v{version}',
  link_items: '{verb} {link_id} · {from} {type} {to}{rule}',
  unlink_items: 'Removed link {link}',
  upsert_label: 'Saved label {name} in {project}',
  claim_lead: 'Claimed {id} · run {run_id} · lease until {lease} · v{version}',
  release_lead: 'Released {id} · {status} · v{version}',
  start_run: 'Started child run {run_id} on {id}',
  heartbeat: 'Run {run_id} {run_state} · lease until {lease}{resources}',
  finish_run: 'Run {run_id} {run_state}',
  park_run: 'Parked run {run_id}{waiting} · {ready}',
  update_run_status: "Updated {id}'s run · {run_state} · by {by}{until}{ready}",
  set_plan: 'Plan v{plan_version} on {id} · {done}/{total} done',
  update_step: 'Step {step_id} {state} on {id}',
  log_subagent: 'Logged {provenance} {name} on {target}',
  set_checks: 'Checks on {id} · {pass}/{total} pass',
  update_check: 'Check {check_id} {state} on {id}',
  declare_human_review: 'Human review on {id} · {count} total',
  update_human_review: 'Human review on {id} · {count} total',
  add_note: 'Noted on {id} · {at}',
  put_document: 'Stored {name} v{version_no} · {document_version_id} · {size} bytes',
  link_artifact: 'Linked {kind} {label} on {id}',
  report_commit: 'Recorded {sha} on {id}{pushed}{stale}',
  submit_packet: 'Submitted {display_id} round {round} for {id} · {status} · v{version}',
  get_review: '{id} review rounds: {count}',
  ask_owner: 'Asked the owner on {id} · {question_id} · your run needs input',
  publish_decision: 'Published {decision_id} {title} · {authority}',
  list_decisions: 'Decisions: {count}{more}',
  withdraw_decision: 'Withdrew {decision_id} {title}',
  recovery_report:
    'Recovery: {interrupted} interrupted · {stale} stale · {parked} parked · {workspaces} workspaces · {orphaned} orphaned resources{more}',
  get_agent_files: 'Agent files for {project}: {count}',
  propose_agent_file_change:
    'Proposed {file} change for {target} · {proposal_id} · pending owner approval',
  onboard_project:
    'Onboarding {key} {name} · {how} · session {session_id} · existing: {items} items, {jira_items} from Jira, {documents} documents',
  finish_onboarding:
    "Onboarding {session_id} ready for the owner's review · {created} created · {enriched} enriched · {documents} documents · {decisions} decisions · {proposals} proposals",
  get_step: '{step_id} {text} · {state} · on {id}{facts}',
  apply_batch: 'Batch: {applied} applied · {failed} failed · of {total}',
  declare_shared_changes: 'Declared {declared} on {id}{branch}{registered}{overlaps}',
  list_shared_parts: 'Shared parts in {project}: {count}',
  take_lease: 'Lease on {part} for {id} · until {until}{renewed}',
  release_lease: 'Released lease on {part} for {id}',
  propose_resolution:
    'Proposed {kind} for {target} · {resolution_id} · waiting for the owner{superseded}',
};

/**
 * MCP_SPEC §5.11: the prompts the server lists (`prompts/list`), with their
 * descriptions and arguments verbatim. The `onboard` prompt returns the
 * same guide as onboard_project, as a user message (decision 31).
 */
export const PROMPTS = [
  {
    name: 'onboard',
    description:
      'Onboard this repo into Docket: set up or adopt the project, then follow the onboarding guide.',
    arguments: [
      {
        name: 'project_key',
        description: 'Project key: 2–5 uppercase letters, like GF.',
        required: true,
      },
      {
        name: 'project_name',
        description: "The project's name, if it is new.",
        required: false,
      },
    ],
  },
] as const;
export type PromptName = (typeof PROMPTS)[number]['name'];

/** What the `onboard` prompt returns while the guide service is a stub (B29; B30 fills it). */
export const ONBOARD_PROMPT_STUB = 'Onboarding guide not available yet';

/** Fill a summary template. A missing (or non-scalar) value renders as `?`, so a gap is visible in tests. */
export function fillSummary(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '?';
  });
}
