/**
 * Limits and formats from MCP_SPEC §3 (IDs, Types, Pagination, Idempotency)
 * and the per-field limits in §5. Shared contract file (tasks.md, Slice rules).
 *
 * Where §5 names no limit for a field, the B3 resolution applies (listed in
 * the B3 PR): evidence and packet lines ≤ 500, estimate ≤ 40, URLs ≤ 2,000,
 * branch ≤ 200, artifact state ≤ 40.
 */
export const TEXT_LIMITS = {
  title: 200,
  /** Step, check and human review item text. */
  step: 500,
  /** `note`, `outcome` and other summary lines. */
  note: 4_000,
  question: 2_000,
  /** `description_md`, `outcome_md`. */
  markdown: 20_000,
  brief_md: 10_000,
} as const;

export const LIMITS = {
  page_default: 25,
  page_max: 50,
  changes_default: 100,
  changes_max: 200,
  /** Largest document accepted inline over MCP (25 MB). */
  document_mcp_bytes: 26_214_400,
  idempotency_key: 100,
  agent_label: 40,
  label_name: 40,
  decision_title: 120,
  decision_md: 4_000,
  rationale_md: 4_000,
  subagent_name: 60,
  subagent_outcome: 500,
  evidence: 500,
  run_summary: 500,
  run_error: 4_000,
  withdraw_reason: 500,
  commit_message: 200,
  document_name: 120,
  artifact_label: 120,
  artifact_state: 40,
  url: 2_000,
  branch: 200,
  estimate: 40,
  packet_line: 500,
  packet_how_max: 15,
  packet_gaps_max: 15,
  packet_checked_max: 30,
  plan_steps_max: 30,
  checks_max: 30,
  human_review_declare_max: 10,
  subgraph_depth_max: 5,
  // ---- Recovery (MCP_SPEC §3 "Workspaces, briefs and resources", §5.4, §5.9) ----
  /** `brief` text on claim_lead and start_run. */
  brief: 20_000,
  /** `external`: UTF-8 bytes of its JSON. */
  external_bytes: 2_048,
  resources_started_max: 10,
  resource_label: 120,
  park_reason: 500,
  // B5 resolutions (limits MCP_SPEC doesn't name; listed in the B5 PR):
  external_key: 40,
  workspace_host: 200,
  workspace_repo: 2_000,
  workspace_path: 1_000,
  orchestrator_name: 40,
  locator_text: 200,
  release_note: 500,
  resources_released_max: 50,
  waiting_on_items_max: 20,
  // ---- Agent files (decision 30; MCP_SPEC §5.4 claim_lead.instructions, §5.10) ----
  /** A skill or the AGENTS.md block (BUILD_SPEC §4 agent_file_versions; B21). */
  agent_file_content: 50_000,
  /** Workflow notes (BUILD_SPEC §5.17). */
  workflow_md: 10_000,
  proposal_reason: 500,
  /** `claim_lead.instructions.files`: up to 20 reported files. */
  instruction_files_max: 20,
  /** Upper bound for opaque identifiers and cursors (not a spec limit; a sanity bound). */
  id: 100,
  /** Lists in compact text truncate long text at this many characters (§3.1). */
  list_text: 200,
} as const;

/** Item IDs: `<PROJECT>-<n>` (§3 IDs). */
export const ITEM_ID_RE = /^[A-Z]{2,5}-[1-9][0-9]*$/;
/** Project keys: 2–5 uppercase letters. */
export const PROJECT_KEY_RE = /^[A-Z]{2,5}$/;
/** Label names: lowercase `a-z0-9-` (§5.3 upsert_label). */
export const LABEL_NAME_RE = /^[a-z0-9-]+$/;
/** Commit SHAs: 7–40 hex (§5.6 report_commit). */
export const SHA_RE = /^[0-9a-fA-F]{7,40}$/;
/** A sha256 in hex, either case (PowerShell's Get-FileHash prints uppercase; compared lowercased). */
export const SHA256_RE = /^[0-9a-fA-F]{64}$/;
/** An installed agent file: `agents_block` or `skill:<name>` (B21). */
export const INSTALLED_FILE_KEY_RE = /^(agents_block|skill:[a-z0-9-]{1,60})$/;
/** An agent file or the Workflow notes, as get_agent_files and propose_agent_file_change name them (B26). */
export const AGENT_FILE_TARGET_RE = /^(agents_block|workflow|skill:[a-z0-9-]{1,60})$/;
/** Dates: `YYYY-MM-DD` (§3 Types). */
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** ULID-prefixed object kinds (§3 IDs). */
export const ID_PREFIXES = {
  work_step: 'wst_',
  check: 'chk_',
  human_review: 'hr_',
  run: 'run_',
  question: 'q_',
  link: 'lnk_',
  document: 'doc_',
  document_version: 'dv_',
  packet: 'pkt_',
  decision: 'dec_',
  resource: 'rsc_',
  agent_file_proposal: 'afp_',
} as const;
