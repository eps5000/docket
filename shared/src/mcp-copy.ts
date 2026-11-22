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
  "- Your plan is the item's checklist, not new tickets: set_plan with one-line steps, update_step as you go. Split work into a new Story or Task only when a step needs its own blocker, owner or review.",
  '- Record what you verify yourself with set_checks. Record subagent work with log_subagent; say whether you observed it or are relaying it.',
  '- If the owner must verify something by hand, declare it with declare_human_review, ideally during Planning. The item cannot close while any human review item is undecided.',
  '- Report each commit for the item it belongs to (report_commit). When the work is built and your checks pass, hand off with submit_packet. If there is no human review, close it with set_status "done".',
  '- If you need a decision from the owner, ask_owner and stop; the answer arrives in get_item.',
  '- Pass run_id on every call while you are working; it keeps your claim alive and shows you as live. Call finish_run when you stop.',
  '- Say where your work lives: pass workspace (worktree path, branch, base) to claim_lead, push work in progress at every checklist step, and report_commit with pushed true.',
  '- If you must wait (on another item, the coordinator or a person), call park_run with what you are waiting on. Never just go quiet: a silent run looks stale and loses its claim; a parked run keeps it.',
  '- Coordinators: get_digest replaces a round of reads. To wait, run the installed docket-wait script, which costs no tokens until something changes; never poll in a sleep loop.',
  '- Declare long-lived things you start (dev servers, sessions, containers) with heartbeat resources_started, and release them before finish_run. Coordinators: after a crash or restart, start with recovery_report, and never prune a workspace it lists as in use or at risk.',
  "- After any pause, call get_item: it delivers the owner's notes, answers and review decisions, each once.",
  '- Send only what changes. update_item, set_plan and set_checks patch: whatever you leave out stays as it is. Use get_item view "summary" when you only need status.',
  '',
  'Errors are structured (code: validation | conflict | not_found | forbidden | unavailable | internal | seam_conflict | not_declared | lease_held | design_review). On conflict, read the current state in the error and retry only if your change still makes sense.',
].join('\n');

/** MCP_SPEC §5: the exact `description` registered for each tool. */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  whoami:
    'Check your connection: how the server identifies you, limits and server time. Call once at session start.',
  list_projects: 'List projects with item counts. Use the key when creating items or searching.',
  search_items:
    'Find items. Filters: ready_to_start (Ready, unblocked, unclaimed: what you may start), resumable (In progress with no lead, usually sent back by review: resume it), blocked, waiting_for_review (handed off, waiting on the owner), mine (items you lead), deferred_review (owner deferred a check; cleanup). Combine with project, status, type, label, epic or text. Returns summaries; get_item has details.',
  get_item:
    "Get one item: description, acceptance, blockers, checklist (plan, checks, human review), runs, open question and answer, unread owner notes, documents, packets, recent activity. Owner notes and answers are returned once, then marked delivered: read them now. Use view 'summary' for status only, and get_context when starting work. Step details show as '· details' unless view is 'full'; read one with get_step.",
  get_context:
    "Everything needed to work on an item in one call: outcome and acceptance, decisions to follow (owner's first), epic and label briefs, blockers, the project's workflow notes, planning documents, the last review's notes. Sized to a budget; cuts are marked. Start with budget 'small' and widen only if needed. Read-only: owner notes are counted here but delivered by get_item.",
  dependency_subgraph:
    'Show what blocks an item and what it blocks, with status and planned dates. Set delay_days to see which downstream items a slip would push past their planned start.',
  deferred_reviews:
    'List human review checks the owner deferred (not verified), with any follow-up ticket. For cleanup: finish the check, or propose a plan in a note.',
  get_changes:
    "Read changes since a cursor instead of re-reading items. Without a cursor, returns the latest cursor; then pass next_cursor. Watch for review.decided, question.answered and owner_note.added on your items. To wait, run the installed docket-wait script: it costs no tokens until something changes. Only if you can't run a shell, pass wait_s (at most 45) to hold this call until a matching event. Never poll in a sleep loop.",
  get_digest:
    "One compact snapshot for coordinators, instead of many reads: top ready items, running, stale and parked runs (resume_ready flagged), blocked items and why, what waits on the owner, agent-actionable problems, leases, conflicts ahead, and the change cursor. Pass cursor for only what changed since then. Long sections end in '+N more'. Read-only.",
  create_item:
    'Create an Epic, Story, Task or Bug. It starts in Inbox (or Planning if you are shaping it now). Put small steps in the checklist (set_plan), not in new tickets.',
  update_item:
    "Edit an item's fields. Pass expected_version from your last read. Dates you set are labelled as set by you. Status goes through set_status, the plan through set_plan.",
  set_status:
    'Move an item. Allowed: inbox→planning; planning↔ready; ready→progress; progress→ready (gives up the work); progress or review→done (only with no undecided human review item); any open status→canceled (reason required); done→progress (reopen, reason required). Moving to ready needs shared changes declared (declare_shared_changes), else not_declared. When closing as done, pass changed_files and branch. An unapproved change to an approved design refuses starting or closing with design_review. Hand off for review with submit_packet, not this.',
  link_items:
    "Link two items. type 'blocks': from must finish before to can start; 'relates' is informational. For blocks, satisfied_when sets what 'finished' means: done (default, or the project's default), merged (done and a PR reported merged with link_artifact) or verified (done and every human review item approved). Calling again updates satisfied_when. A link that would create a cycle is rejected with the cycle path.",
  unlink_items: 'Remove a link between two items.',
  upsert_label:
    'Create a label or update its brief. Use a label for an initiative spanning several epics; the brief holds the shared decisions.',
  claim_lead:
    "Claim an item as its lead before working on it. Works on Ready items (moves them to In progress) and In progress items with no lead (resuming sent-back or interrupted work). Pass workspace and, if a coordinator briefed you, brief, so the work can restart after a crash; instructions with the installed docket-check script's output; and branch, so conflicts are spotted early. Returns run_id: pass it on every later call. Errors: conflict (someone holds it, with who and until when: do not work on it); seam_conflict (its shared parts collide with an item in flight: Docket queued it or asked the owner, so pick other work and leave it); design_review (it changes an approved design awaiting the owner: pause it and take other work). Parts that can safely run together don't refuse the claim.",
  release_lead:
    'Give up the lead claim without finishing. The item returns to Ready for another agent; your plan and notes stay.',
  start_run:
    'Start a child run under your lead run when delegating to a subagent that has its own Docket connection. Pass its workspace and brief as for claim_lead; the subagent passes the child run_id on its calls. For subagents without a connection, use log_subagent.',
  heartbeat:
    'Tell Docket you are still working and update your current step, workspace (head and pushed commits, uncommitted changes) and long-lived resources started or released. Any call with run_id keeps you live, so use this only when you have nothing else to record or something changed.',
  finish_run:
    "End your run: result 'finished' when you stopped normally, 'failed' with an error when something broke. Finishing a lead run releases the claim but doesn't change the item's status: hand off with submit_packet or close with set_status first.",
  park_run:
    "Park only when the work itself stops: waiting on another item, the coordinator or a person. Don't park while your own CI or tests run or while you review them: stay live and log a note. A parked run keeps its claim and its workspace stays in use, so it is never mistaken for finished or stale. Say what you wait on; Docket flags it resume_ready when that clears. Any later call with your run_id resumes it.",
  set_plan:
    "Publish or revise your plan as one-line steps, optionally with details (Markdown) and a source such as a Jira key. Patches by default: steps with an id are updated (text changes record the old text and your reason), steps without one are added, nothing is removed unless listed in remove. mode 'replace' restates the plan. Owner-added steps are always kept; on Jira-imported steps you may add details, keeping the current text at the start. Revisions are kept as history.",
  update_step:
    "Update a step's state: current when you start, done when finished, blocked or skipped with a note. details replaces its details (null clears), with expected_details_version from get_step. On a Jira-imported step you may only add to details: keep the current text at the start.",
  log_subagent:
    "Record what a subagent contributed, as a short line under its step. provenance 'observed' if you saw its run or output, 'relayed' if passing on its report. Never creates a ticket.",
  set_checks:
    'Publish what you will verify yourself (tests, measurements, reviews), with state and evidence. Patches like set_plan: nothing is removed unless listed in remove. Owner-added checks are always kept.',
  update_check: "Update one check's state and evidence, for example when tests pass.",
  declare_human_review:
    "Declare what the owner must verify by hand before this item can close, one plain instruction each ('On your phone, drag a recipe between days. Does it feel right?'). Declare early, usually in Planning. For one PR across an epic, declare once on the epic. With none, you may close the item yourself once your checks pass.",
  update_human_review:
    "Edit or remove a human review item you declared. Items in an open packet are locked; owner-added items are the owner's.",
  add_note:
    "Add a short note to the item's activity: decisions you made, surprises, anything the owner should know. A sentence or two.",
  put_document:
    'Store a document on an item or project: planning docs (PRD, UX, TDD), packet attachments or other files. The same name creates a new version. Markdown or text as content_text; binary as content_base64 (up to 25 MB; larger: POST to /agent-upload and pass the returned document_version_id).',
  link_artifact:
    'Link external evidence: a PR, CI run, deployment, test report or URL. A link is evidence, never approval.',
  report_commit:
    'Report every commit for its item, including fixes after a review, and set pushed true once it is on the remote: an unpushed commit can be lost in a crash. A handoff packet built from an older commit is marked out of date automatically.',
  submit_packet:
    'Hand finished work to the owner for human review, once it is built, checks pass and everything is committed and reported. The packet must let the owner verify without asking you anything: what to check, exact steps (URLs, builds, commands), what you verified and how, known gaps, attachments. Pass changed_files (every file changed) and branch: undeclared shared-part changes, or an unapproved change to an approved design, hold it for the owner. The item moves to Review; read the decision with get_review or get_item.',
  get_review:
    "Read the owner's review decisions, round by round. 'changes' notes say what to fix; each became a checklist step or a new Bug (see result_ref). Approved items stay approved in later rounds. Deferred items are not verified; leave them unless doing cleanup.",
  ask_owner:
    "Ask the owner a question you can't answer yourself, such as a product decision: one clear question with the options you see. Your run shows as needs input; stop work that depends on it. The answer appears in get_item (open_question) and as a question.answered event.",
  publish_decision:
    'Record a decision other agents must follow (a convention, design choice or interface rule) with a short rationale. Scope it as narrowly as it applies: item, epic, label or project. You can supersede an agent decision; only the owner changes owner decisions (use ask_owner to challenge one).',
  list_decisions:
    "List a project's decision records, optionally for one scope. Active only unless include_inactive. get_context already includes those that apply to an item.",
  withdraw_decision:
    "Withdraw a decision you or another agent recorded when it no longer applies. Agents can't withdraw owner decisions.",
  recovery_report:
    'After a crash or restart, or before pruning worktrees, get the restart list: interrupted, stale and parked runs with brief, workspace, last pushed commit, checklist progress and open question; every workspace as in use, at risk or safe to prune; resources left running. Re-dispatch from this instead of guessing, and never prune a workspace marked in use or at risk.',
  get_agent_files:
    'Read the agent files (skills, AGENTS.md block) and Workflow notes in effect for a project, with version_id and source. Pass file for its full text. Read-only. Call before propose_agent_file_change, and propose from this text, not your installed copy.',
  propose_agent_file_change:
    "Propose new content for an agent file (skill or AGENTS.md block) or a project's Workflow notes, with a short reason. Nothing changes until the owner approves; they may edit or decline it. Send the whole new text and based_on_version_id from get_agent_files. Omit project to propose a change to the default.",
  onboard_project:
    'Set up a project or onboard a repo into one. Creates the project when the key is free (pass name) or adopts the existing one, starts an onboarding session, and returns session_id, what the project holds and the onboarding guide. Follow the guide step by step; it works with no agent files installed. Not retry-safe: pass idempotency_key.',
  finish_onboarding:
    'Finish an onboarding session and hand it to the owner for review, with a short summary and any open questions. Pass session_id from onboard_project. The owner reviews everything from one card; stop there and wait.',
  get_step:
    "Read one checklist step in full: text, state, source, details (Markdown), history and subagent notes. Call before working on a step get_item shows with '· details'. Read-only.",
  apply_batch:
    'Run up to 100 writes in one call, for large onboardings: each operation names a tool (create_item, update_item, link_items, upsert_label, set_plan, update_step, put_document or publish_decision) and its arguments. Each runs the same checks as its single call and applies on its own, in order: a failure doesn\'t undo the others, and the result lists each operation\'s ID or error. "$1" in an argument means the ID operation 1 wrote. Pass idempotency_key, so a retry replays what succeeded and runs only the rest.',
  declare_shared_changes:
    "Declare the shared parts this item will change (tables, models, endpoints, shared files), each with add, change or remove and a short note, or none: true. An item can't move to Ready until it has declared. Each call replaces the whole declaration. Name parts by their keys from list_shared_parts; register a missing one with new_parts. Name the member when you can (model:Token.expiresAt, table:decks.archived_at): different members run in parallel, while a bare part may touch anything in it and is sequenced. Set design_impact: changes_approved_design with a design_note when the change alters an approved design: it reaches the owner and this item pauses until approved, while others continue. Set disputed: true when agents disagree about who owns a part; that reaches the owner too. Pass branches, every branch the work is on (or branch for one), so the conflict radar can check them; they replace the reported branches, and an empty list clears them. Returns in-flight items changing the same parts, each with outcome parallel, sequence or owner.",
  list_shared_parts:
    "List a project's shared parts: each key, the file paths mapped to it, whether it is single-writer, who holds its lease, and in-flight items declaring changes to it. Read-only. Call before declare_shared_changes, to use registered keys.",
  take_lease:
    'Take the lease on a single-writer part (such as a migrations snapshot) for an item you lead, before changing it; call again to renew. It lasts 2 hours and ends when the item is done or handed off, or you release it. If another item holds it you get lease_held with holder and expiry: work on something else rather than waiting in a loop.',
  release_lease:
    'Release your lease on a single-writer part as soon as your change is committed and pushed, so other items can take it.',
  propose_resolution:
    'Propose how to resolve a problem that needs the owner: split, rescope, reorder or other, with a plan in Markdown and a reason. Pass problem (its ID from get_context problems), or id for the item in general. The owner approves it, asks for a different way with a note, or acknowledges it; the choice arrives as an owner note and in get_context. After a different way, propose again. Routine fixes need no proposal: rebase onto main, or remove an old branch with declare_shared_changes; Docket records it.',
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
