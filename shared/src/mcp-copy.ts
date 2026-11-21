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
  '- Then call get_context: one call that gathers the item, the decisions you must follow, the epic and label briefs, blockers and planning docs.',
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
  '- Declare long-lived things you start (dev servers, sessions, containers) with heartbeat resources_started, and release them before finish_run. Coordinators: after a crash or restart, start with recovery_report, and never prune a workspace it lists as in use or at risk.',
  "- After any pause, call get_item: it delivers the owner's notes, answers and review decisions, each once.",
  '- Send only what changes. update_item, set_plan and set_checks patch: whatever you leave out stays as it is. Use get_item view "summary" when you only need status.',
  '',
  'Errors are structured (code: validation | conflict | not_found | forbidden | unavailable | internal | seam_conflict | not_declared | lease_held | design_review). On conflict, read the current state in the error and retry only if your change still makes sense.',
].join('\n');

/** MCP_SPEC §5: the exact `description` registered for each tool. */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  whoami:
    'Check your connection to Docket. Returns how the server identifies you, server limits and the server time. Call it once at the start of a session.',
  list_projects:
    'List projects with item counts. Use the project key when creating items or searching.',
  search_items:
    "Find items. Filters: ready_to_start (Ready, unblocked, unclaimed: what you may start), resumable (In progress with no lead, usually sent back by the owner's review: resume it), blocked, waiting_for_review (handed off, waiting on the owner), mine (items you lead), deferred_review (owner deferred a check; cleanup). Combine with project, status, type, label, epic or text. Results are summaries; call get_item for details.",
  get_item:
    "Get one item: description, acceptance criteria, blockers, checklist (your plan, your checks, human review), runs, the open question and its answer, the owner's unread notes, documents, packets and recent activity. Owner notes and answers are returned once and then marked as delivered, so read them now. Use view 'summary' when you only need status, and get_context when starting work. Step details show as a '· details' marker unless view is 'full'; read one step in full with get_step.",
  get_context:
    "Get everything you need to work on an item in one call: its outcome and acceptance, the decisions you must follow (owner decisions first), the epic and label briefs, blockers and what they are waiting for, the project's workflow notes, planning documents, and the last review's notes. Sized to a budget; anything cut is marked. Read-only: owner notes are counted here but delivered by get_item.",
  dependency_subgraph:
    "Show what blocks an item and what it blocks, with each item's status and planned dates. Set delay_days to see which downstream items a slip would push past their planned start.",
  deferred_reviews:
    'List human review checks the owner deferred (not verified), with any follow-up test ticket and its status. Use during cleanup: finish the check, or propose a plan in a note.',
  get_changes:
    'Poll for changes since a cursor instead of re-reading items. Start without a cursor to get the latest cursor, then pass next_cursor each time. Watch for review.decided, question.answered and owner_note.added on items you work on.',
  create_item:
    "Create an Epic, Story, Task or Bug. New items start in Inbox (or Planning if you are shaping it now). Put small steps in an item's checklist with set_plan rather than creating tickets for them.",
  update_item:
    "Edit an item's fields. Pass expected_version from your last read. Dates you set are labelled as set by you. To change status use set_status; to change the plan use set_plan.",
  set_status:
    "Move an item to another status. Allowed moves: inbox→planning; planning↔ready; ready→progress; progress→ready (gives up the work); progress or review→done (only when no human review item is undecided); any open status→canceled (reason required); done→progress (reopen, reason required). Moving to ready needs the item's shared changes declared first (declare_shared_changes), else not_declared. When you close an item as done, pass changed_files and branch. An unapproved change to an approved design refuses starting or closing the item with design_review. Use submit_packet, not set_status, to hand off for review.",
  link_items:
    "Link two items. type 'blocks' means from must be finished before to can start; 'relates' is informational. For blocks, satisfied_when sets what 'finished' means: done (default, or the project's default), merged (done and a PR reported merged with link_artifact), or verified (done and every human review item approved). Calling it again on an existing link updates satisfied_when. A link that would create a dependency cycle is rejected with the cycle path.",
  unlink_items: 'Remove a link between two items.',
  upsert_label:
    'Create a label or update its brief. Use a label for an initiative that spans several epics; the brief holds the shared decisions.',
  claim_lead:
    'Claim an item as its lead before you work on it. Works on Ready items (moves them to In progress) and on In progress items with no lead (resuming sent-back or interrupted work). Pass workspace (where the work lives) and, if a coordinator briefed you, the brief, so the work can be restarted after a crash. Pass instructions with the output of the installed docket-check script, so the owner knows which instructions you work from. Pass branch, the branch you will work on, so conflicts are spotted early. Returns your run_id: pass it on every later call. If someone else holds the claim you get a conflict with who holds it and until when; do not work on the item. If its shared parts collide with another item in flight you get seam_conflict: Docket has queued it behind that item, or asked the owner when only the owner can decide, so pick other work and leave this item. Parts that can safely run together do not refuse the claim. If it changes an approved design and the owner has not approved that yet, you get design_review: pause this item and take other work.',
  release_lead:
    'Give up the lead claim without finishing, for example when you are stopping before the work is done. The item returns to Ready so another agent can pick it up; your plan and notes stay.',
  start_run:
    'Start a child run under your lead run when you delegate to a subagent that has its own Docket connection. Pass its workspace and brief as for claim_lead. The subagent passes the child run_id on its calls. For subagents without their own connection, use log_subagent instead.',
  heartbeat:
    'Tell Docket you are still working, and update what it knows about your run: your current step, your workspace (head and pushed commits, uncommitted changes), and long-lived resources you started or released. Any call with run_id keeps you live, so use this when you have nothing else to record or something changed.',
  finish_run:
    "End your run. result 'finished' when you stopped normally, 'failed' with an error when something broke. Finishing a lead run releases the claim but does not change the item's status: hand off with submit_packet or close with set_status first.",
  park_run:
    'Park your run only when the work itself stops: waiting on another item, on the coordinator to send you more work, or on a person. Do not park while your own CI or tests run or while you review their results: that is still work in progress, so stay live and log a short note. A parked run keeps its claim and its workspace stays marked in use, so it is never mistaken for finished or stale. Say what you are waiting on; Docket flags it as ready to resume when that clears. Any later call with your run_id resumes it.',
  set_plan:
    "Publish or revise your plan as one-line work steps; steps may carry details (Markdown) and a source, such as a Jira key. By default this patches: steps with an id are updated (changing text records the old text and your reason), steps without an id are added, and nothing is removed unless you list it in remove. Use mode 'replace' to restate the whole plan. Owner-added steps are always kept; on steps imported from Jira you may add details, keeping the current text at the start. Every revision is kept as history.",
  update_step:
    "Update one work step's state as you go: current when you start it, done when finished, blocked or skipped with a note. Pass details to replace the step's details (null clears them), with expected_details_version from get_step. On a step imported from Jira you may only add to its details: keep the current text at the start.",
  log_subagent:
    "Record what a subagent contributed, as a short line under the step it worked on. provenance 'observed' if you saw its run or output directly, 'relayed' if you are passing on its report. This never creates a ticket.",
  set_checks:
    'Publish what you will verify yourself (tests, measurements, reviews), with state and evidence. Patches like set_plan: listed checks are updated or added, and nothing is removed unless listed in remove. Owner-added checks are always kept.',
  update_check: "Update one check's state and evidence, for example when tests pass.",
  declare_human_review:
    "Declare what the owner must verify by hand before this item can close, one plain instruction per item ('On your phone, drag a recipe between days. Does it feel right?'). Declare early, usually during Planning. For work shipped as one PR across an epic, declare it once on the epic instead of on each child. With no human review items, you may close the item yourself once your checks pass.",
  update_human_review:
    'Edit or remove a human review item you declared. Items in an open packet are locked, and items the owner added can only be changed by the owner.',
  add_note:
    "Add a short progress note or comment to the item's activity. Use it for decisions you made, surprises and anything the owner should know. Keep it to a sentence or two.",
  put_document:
    'Store a document on an item (or a project): planning docs (PRD, UX, TDD), packet attachments such as screenshots, or other files. Uploading the same name again creates a new version. Send Markdown or text as content_text; binary files as content_base64 (up to 25 MB; larger files: POST to /agent-upload and pass the returned document_version_id).',
  link_artifact:
    'Link external evidence: a PR, CI run, deployment, test report or URL. A link is evidence, never approval.',
  report_commit:
    'Report a commit for the item it belongs to. Report every commit you make for an item, including fixes after a review, and set pushed true once it is on the remote: an unpushed commit can be lost in a crash. If a handoff packet was built from an older commit, it is marked out of date for the owner automatically.',
  submit_packet:
    "Hand finished work to the owner for human review. Call it when the work is built, your checks pass and everything is committed and reported. The packet must let the owner verify without asking you anything: what to check, exact steps (URLs, builds, commands), what you already verified and how, known gaps, and attachments. Pass changed_files (every file your work changed) and branch: changes to shared parts the item didn't declare, or an unapproved change to an approved design, hold it for the owner. The item moves to Review; read the decision later with get_review or get_item.",
  get_review:
    "Read the owner's review decisions for an item, round by round. 'changes' notes say what to fix; each became a checklist step or a new Bug (see result_ref). Approved items stay approved in later rounds. Deferred items are not verified; leave them alone unless you are doing cleanup.",
  ask_owner:
    'Ask the owner a question you cannot answer yourself, such as a product decision. Ask one clear question with the options you see. Your run shows as needs input; stop work that depends on the answer. The answer appears in get_item (open_question) and as a question.answered event.',
  publish_decision:
    'Record a decision that other agents must follow, such as a convention, a design choice or an interface rule, with a short rationale. Scope it as narrowly as it applies: an item, an epic, a label or the whole project. You can supersede an earlier agent decision; owner decisions can only be changed by the owner (use ask_owner to challenge one).',
  list_decisions:
    'List decision records for a project, optionally narrowed to one scope. Active records only unless include_inactive. get_context already includes the active decisions that apply to an item.',
  withdraw_decision:
    "Withdraw a decision you or another agent recorded when it no longer applies. Owner decisions can't be withdrawn by agents.",
  recovery_report:
    'After a crash or restart, or before pruning worktrees, get the restart list: runs that were interrupted, went stale or are parked, each with its brief, workspace, last pushed commit, checklist progress and any open question; every workspace with whether it is in use, at risk or safe to prune; and resources left running. Re-dispatch from this instead of guessing, and never prune a workspace marked in use or at risk.',
  get_agent_files:
    "Read the agent files (skills and the AGENTS.md block) and Workflow notes in effect for a project, with each one's version_id and where it comes from. Pass file to get its full text. Read-only. Call it before propose_agent_file_change, and propose from this text, not your installed copy.",
  propose_agent_file_change:
    "Propose new content for an agent file (a skill or the AGENTS.md block) or a project's Workflow notes, with a short reason. Nothing changes until the owner approves; they may edit or decline it. Send the whole new text and based_on_version_id from get_agent_files. Omit project to propose a change to the default.",
  onboard_project:
    'Set up a project, or onboard a repo into one. Creates the project when the key is free (pass name) or adopts the existing project with that key, starts an onboarding session, and returns its session_id, what the project already holds, and the onboarding guide. Follow the guide step by step; it works with no agent files installed. Not retry-safe: pass idempotency_key.',
  finish_onboarding:
    'Finish an onboarding session and hand it to the owner for review, with a short summary and any open questions. Pass the session_id from onboard_project. The owner reviews everything you set up from one card; stop there and wait for them.',
  get_step:
    "Read one checklist step in full: its text, state, source, details (Markdown), history and subagent notes. Call it before you work on a step that get_item shows with '· details'. Read-only.",
  apply_batch:
    'Run up to 100 writes in one call, for large onboardings: each operation names a tool (create_item, update_item, link_items, upsert_label, set_plan, update_step, put_document or publish_decision) and its arguments, exactly as you would call it. Each operation runs the same checks as its single call and is applied on its own, in order: one that fails does not undo the others, and the result lists every operation with its ID or its error. "$1" in an argument means the ID operation 1 wrote. Pass idempotency_key, so a retry replays what succeeded and runs only the rest.',
  declare_shared_changes:
    "Declare the shared parts this item will change (tables, models, endpoints, shared files), each with add, change or remove and a short note, or none: true when it changes none. An item can't move to Ready until it has declared. Each call replaces the item's whole declaration. Name parts by their keys from list_shared_parts; register a missing one with new_parts. Name the member when you can (model:Token.expiresAt, table:decks.archived_at): adding different members runs in parallel, while a bare part means it could touch anything in it and is sequenced. Set design_impact: changes_approved_design with a design_note when the change alters an approved design: it always reaches the owner, and this item pauses until they approve it, while other items continue. Set disputed: true when agents disagree about who owns a part; that reaches the owner too. Pass branches, every branch the work is on (or branch for one), so the conflict radar can check them, also for work already in progress; they replace the item's reported branches, and an empty list clears them. Returns the in-flight items that change the same parts, each with its outcome: parallel, sequence or owner.",
  list_shared_parts:
    "List a project's shared parts (tables, models, endpoints, shared files): each key, the file paths that map to it, whether it is single-writer and who holds its lease, and the in-flight items that declared changes to it. Read-only. Call it before declare_shared_changes, to name parts by their registered keys.",
  take_lease:
    'Take the lease on a single-writer part (such as a migrations snapshot) for an item you lead, before you change it; call again to renew. A lease lasts 2 hours and ends when the item is done or handed off, or when you release it. If another item holds it you get lease_held with the holder and expiry: work on something else rather than waiting in a loop.',
  release_lease:
    'Release your lease on a single-writer part as soon as your change to it is committed and pushed, so other items can take it.',
  propose_resolution:
    "Propose how to resolve a problem that needs the owner: split the work, change its scope, change the order of work, or other, with a plan in Markdown and a reason. Pass problem (its ID from get_context problems), or id for the item in general. The owner approves it, asks for a different way with a note, or acknowledges it; the choice arrives as an owner note and in get_context. After a different way, propose again. Routine fixes need no proposal: rebase onto main, or remove an old branch from the item's branches with declare_shared_changes, and Docket records it on the item.",
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
