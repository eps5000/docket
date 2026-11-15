/**
 * Domain service signatures (tasks.md T047; constitution Principle II).
 *
 * There is one write path and one set of rules. The MCP tools
 * (`server/src/mcp/tools/*.ts`) and the UI API routes
 * (`server/src/api/routes/*.ts`) are thin adapters: they validate input,
 * build a context, call a method declared here, and shape the result.
 * Every BUILD_SPEC §5 rule lives behind one of these methods.
 *
 * Contexts:
 * - `WriteContext` (write.ts) for mutations: built by the adapter through
 *   the write path (`ctx.mutate` in MCP, `api.mutate` in the API), so it
 *   carries the actor (with `run_id`), the mutation ID, the idempotency key
 *   and one open transaction. Every mutation must append an event.
 * - `ReadContext` for reads: the database, the caller and the time.
 * - `ReceiptContext` for the bookkeeping writes that are deliberately not
 *   events (BUILD_SPEC §5.4, §5.7; contracts/events.md: "heartbeats are not
 *   events"): run signals and lease renewal, heartbeats, and delivery
 *   receipts (`read_by_agent_at`). The write path refuses a mutation that
 *   records no event, so these run outside it, each in its own short
 *   transaction.
 *
 * Errors: a method throws a `ToolError` (errors.ts) rather than returning
 * one. Inside the write path a throw rolls the whole transaction back,
 * which a returned error would not; adapters turn the throw into an MCP
 * error result or an HTTP status.
 *
 * Stubs: each service's implementation lives in its own file
 * (`server/src/domain/<service>.ts`) and starts as a stub whose methods throw
 * `NotImplementedError`. Adapters show that as `unavailable` "Not implemented
 * yet: <tool>" (MCP) or `501` "Not implemented yet: <METHOD path>" (API).
 * A slice replaces the stub methods in its file; it does not edit this one.
 *
 * Shared contract file (tasks.md, Slice rules).
 */
import {
  ToolError,
  type AgentsResponse,
  type Artifact,
  type BootstrapResponse,
  type BurndownResponse,
  type Check,
  type ContextBundle,
  type DecideResponse,
  type DecisionRecord,
  type EventRow,
  type Forecast,
  type HumanReviewItem,
  type ItemDetailResponse,
  type ItemResume,
  type ItemSummary,
  type ItemText,
  type ItemView,
  type JiraImport,
  type LabelPageResponse,
  type NeedsYouResponse,
  type Project,
  type Question,
  type Resource,
  type ReviewResponse,
  type RouteBody,
  type RouteParams,
  type RouteQuery,
  type SearchResponse,
  type SettingsResponse,
  type SignalKind,
  type Timeline,
  type ToolInput,
  type ToolName,
  type ToolOutput,
  type WorkResponse,
  type WorkspaceState,
  type WorkspacesResponse,
  type WorkStep,
} from '@tasklite/shared';
import type { Config, SecretStore } from '../config.js';
import type { Db } from '../db/client.js';
import type { CallLog } from '../jobs/logs.js';
import type { Actor, WriteContext } from './write.js';

export type { Actor, WriteContext } from './write.js';

// ---- Contexts ----

export interface ReadContext {
  readonly db: Db;
  /** Who is asking: the owner, or an agent (client, label, session, run). */
  readonly actor: Actor;
  /** ISO-8601 UTC. */
  readonly now: string;
}

/** A read context used for the non-event bookkeeping writes (see the header). */
export type ReceiptContext = ReadContext;

export function readContext(db: Db, actor: Actor, now: Date | string): ReadContext {
  return { db, actor, now: typeof now === 'string' ? now : now.toISOString() };
}

// ---- Not implemented yet ----

/**
 * Thrown by a stub. Adapters replace the message with their own name for
 * the operation: the tool (MCP) or `METHOD path` (API, as a 501).
 */
export class NotImplementedError extends ToolError {
  readonly operation: string;
  constructor(operation: string) {
    super('unavailable', `Not implemented yet: ${operation}`);
    this.name = 'NotImplementedError';
    this.operation = operation;
  }
}

export function isNotImplemented(err: unknown): err is NotImplementedError {
  return err instanceof NotImplementedError;
}

/** A stub method: throws `NotImplementedError` for `service.method`. */
export const notImplemented = (operation: string) => (): never => {
  throw new NotImplementedError(operation);
};

// ---- Input and result types ----

/** A tool's arguments as a service receives them: the idempotency key is the write path's. */
export type In<N extends ToolName> = Omit<ToolInput<N>, 'idempotency_key'>;

/** A tool's result as a service returns it: `replayed` and `warnings` are added by the adapter. */
export type Out<N extends ToolName> = Omit<ToolOutput<N>, 'replayed' | 'warnings'>;

/** An owner mutation's result without the `mutation_id` (the API adds it from the write path). */
export type OwnerOut<T> = Omit<T, 'mutation_id'>;

/** Notes and an answer `get_item` delivered, to be marked read after the response is built (§5.7). */
export interface DeliveryReceipt {
  item_id: string;
  owner_note_ids: string[];
  /** The answered question whose answer was delivered. */
  question_id: string | null;
  /** Who it was delivered to ("Waiting for <agent> to read it"). */
  delivered_to: string;
}

/** What `get_item` reads, and what it delivered. */
export interface ItemRead {
  item: ItemView;
  delivery: DeliveryReceipt | null;
}

/** A run signal (BUILD_SPEC §5.4): any call naming a run. */
export interface RunSignalInput {
  run_id: string;
  kind: SignalKind;
  session_id: string | null;
}

/** A file to store as a document version (BUILD_SPEC §5.10). `Blob` satisfies it. */
export interface UploadFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
}

/** Bytes streamed to the docs volume before the database write (nothing is overwritten). */
export interface StagedFile {
  path: string;
  size: number;
  sha256: string;
  mime: string;
  original_name: string;
}

/** A stored version, ready to stream back with the right headers (§5.10). */
export interface DocumentContent {
  document_version_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  /** Absolute path on the docs volume. */
  path: string;
  /** `inline` for the preview formats, else `attachment`. */
  disposition: 'inline' | 'attachment';
}

export type UploadFields = RouteBody<'agentUpload.post'>;

export interface BlockState {
  blocked: boolean;
  /** Unresolved blockers. */
  blocked_by: string[];
  /** What each unresolved blocker is waiting for. */
  waiting_for: Record<string, 'done' | 'merge' | 'verification'>;
}

export interface BackupLocationStatus {
  location: 'volume' | 'extra';
  path: string;
  last_success_at: string | null;
  keep_days: number;
  last_error: string | null;
}

export interface BackupResult {
  archive_path: string;
  extra_copy: { path: string; ok: boolean; error: string | null } | null;
}

// ---- Services (BUILD_SPEC §5) ----

/** Items: create, edit, status (§5.1), labels, the owner's field and text edits (decision 22). */
export interface ItemsService {
  create(w: WriteContext, input: In<'create_item'>): ItemSummary;
  update(w: WriteContext, input: In<'update_item'>): ItemSummary;
  /** `PATCH /api/items/:id`: priority, planning/ready moves, and inline text edits. */
  ownerPatch(w: WriteContext, input: { id: string } & RouteBody<'items.patch'>): ItemText;
  /** Transitions with their guards; an invalid one is `validation` listing the allowed ones. */
  setStatus(w: WriteContext, input: In<'set_status'>): ItemSummary;
  /** `get_item`: the view, trimmed by `view` and `fields`, plus what it delivered. */
  get(r: ReadContext, input: In<'get_item'>): ItemRead;
  upsertLabel(w: WriteContext, input: In<'upsert_label'>): Out<'upsert_label'>;
  /** *Move N to Ready* on the label page; returns the moved IDs. */
  moveLabelToReady(w: WriteContext, input: RouteParams<'labels.moveToReady'>): string[];
}

/** Lead claims, leases and runs (§5.3, §5.4). */
export interface RunsService {
  claim(w: WriteContext, input: In<'claim_lead'>): Out<'claim_lead'>;
  release(w: WriteContext, input: In<'release_lead'>): ItemSummary;
  /** The owner's *Release lead claim*. */
  ownerRelease(w: WriteContext, input: { id: string } & RouteBody<'items.release'>): ItemSummary;
  /** The owner's *Return to Ready*. */
  returnToReady(
    w: WriteContext,
    input: { id: string } & RouteBody<'items.returnToReady'>,
  ): ItemSummary;
  /**
   * Claim and start record the recovery fields (§5.16): workspace,
   * orchestrator, `external`, and the brief, stored as an immutable `brief`
   * document version (`brief-<run_id>.md`) unless a `brief_document_version_id`
   * is given.
   */
  startRun(w: WriteContext, input: In<'start_run'>): Out<'start_run'>;
  /**
   * Not an event: renews the lease, records the signal, and applies the
   * workspace patch, `note`, `current_step_id` and `external`. Returns the
   * run's `resources`. Declaring or releasing resources is an event, so the
   * adapter does that first, through `updateResources`.
   */
  heartbeat(r: ReceiptContext, input: In<'heartbeat'>): Out<'heartbeat'>;
  /**
   * A heartbeat's `resources_started` (new `rsc_…` IDs; event
   * `resource.declared`) and `resources_released` (event `resource.released`).
   * A later run of the same item may release an earlier run's resources.
   */
  updateResources(w: WriteContext, input: ResourceChanges): { resources: ResourceRef[] };
  /** Ends the run with `end_reason` `finished` or `failed`; warns on unreleased resources and unpushed commits. */
  finish(w: WriteContext, input: In<'finish_run'>): Out<'finish_run'>;
  /** `park_run` (§5.16): state `parked`, lease suspended, claim kept; event `run.parked`. */
  park(w: WriteContext, input: In<'park_run'>): Out<'park_run'>;
  /**
   * Any later call with a parked run's `run_id` resumes it (state `open`,
   * lease renewed; event `run.resumed`). US11 calls it from the MCP signal
   * hook for parked runs.
   */
  resume(w: WriteContext, input: { run_id: string }): { resumed: boolean };
  /** Every call carrying `run_id` (the MCP signal hook): renew the lease, record the signal. */
  recordSignal(r: ReceiptContext, signal: RunSignalInput): void;
  /** The sweeper: expired leases → run `interrupted`, item back to Ready. */
  expireLeases(w: WriteContext): { interrupted: string[] };
  /** Service start: every open run → `interrupted` ("service restarted"). */
  interruptOpenRuns(w: WriteContext, input: { reason: string }): { interrupted: string[] };
  /** Sessions of open runs, for the 60 s ping. */
  openRunSessions(r: ReadContext): { run_id: string; session_id: string }[];
}

/** A heartbeat's resource changes (MCP_SPEC §5.4). */
export interface ResourceChanges {
  run_id: string;
  resources_started?: In<'heartbeat'>['resources_started'];
  resources_released?: In<'heartbeat'>['resources_released'];
}

/** A resource as a heartbeat returns it. */
export interface ResourceRef {
  id: string;
  label: string;
}

/**
 * Recovery (owner decision 26; BUILD_SPEC §5.16; MCP_SPEC §5.9): workspace
 * state, `Item.resume`, the restart list, and the owner's two Problems
 * actions. Task Lite only records: nothing here touches the host.
 */
export interface RecoveryService {
  /** `recovery_report`: read-only. */
  report(r: ReadContext, input: In<'recovery_report'>): Out<'recovery_report'>;
  /** Derived state per worktree path, from reported data only (decision T23). */
  workspaceStates(r: ReadContext, input: { paths: string[] }): Record<string, WorkspaceState>;
  /** `Item.resume` for `get_item`: null unless the item is resumable or its last run was interrupted. */
  itemResume(r: ReadContext, input: { item_id: string }): ItemResume | null;
  /** `GET /api/workspaces`: Agents → Workspaces. */
  workspaces(r: ReadContext, input: RouteQuery<'workspaces.list'>): WorkspacesResponse;
  /** *Mark released* on an orphaned resource (owner; event `resource.released`). */
  ownerReleaseResource(
    w: WriteContext,
    input: RouteParams<'resources.release'> & RouteBody<'resources.release'>,
  ): Resource;
  /** *Handled* on "Unpushed work may be lost" (owner; sets `unpushed_handled_at`; event `run.unpushed_handled`). */
  markUnpushedHandled(
    w: WriteContext,
    input: RouteParams<'runs.unpushedHandled'>,
  ): { run_id: string; unpushed_handled_at: string };
}

/** Work steps, subagent logs and agent checks (§5.5). */
export interface ChecklistService {
  setPlan(w: WriteContext, input: In<'set_plan'>): Out<'set_plan'>;
  updateStep(w: WriteContext, input: In<'update_step'>): Out<'update_step'>;
  logSubagent(w: WriteContext, input: In<'log_subagent'>): Out<'log_subagent'>;
  setChecks(w: WriteContext, input: In<'set_checks'>): Out<'set_checks'>;
  updateCheck(w: WriteContext, input: In<'update_check'>): Out<'update_check'>;
  ownerAddStep(w: WriteContext, input: { id: string } & RouteBody<'steps.add'>): WorkStep;
  /** The owner's own undone steps only. */
  ownerRemoveStep(w: WriteContext, input: RouteParams<'steps.remove'>): void;
  ownerAddCheck(w: WriteContext, input: { id: string } & RouteBody<'checks.add'>): Check;
  /** The owner's own checks while still todo. */
  ownerRemoveCheck(w: WriteContext, input: RouteParams<'checks.remove'>): void;
}

/** Human review items (§5.5): author edits, locked while `ready`, owner-added items are owner-only. */
export interface HumanReviewService {
  declare(w: WriteContext, input: In<'declare_human_review'>): HumanReviewItem[];
  update(w: WriteContext, input: In<'update_human_review'>): HumanReviewItem[];
  ownerAdd(w: WriteContext, input: { id: string } & RouteBody<'humanReview.add'>): HumanReviewItem;
  ownerUpdate(
    w: WriteContext,
    input: RouteParams<'humanReview.update'> & RouteBody<'humanReview.update'>,
  ): HumanReviewItem;
  ownerRemove(
    w: WriteContext,
    input: RouteParams<'humanReview.remove'> & RouteBody<'humanReview.remove'>,
  ): void;
}

/** Packets (§5.6): submit, rounds, staleness, deferred reviews, the packet screen. */
export interface PacketsService {
  submit(w: WriteContext, input: In<'submit_packet'>): Out<'submit_packet'>;
  getReview(r: ReadContext, input: In<'get_review'>): Out<'get_review'>;
  deferredReviews(r: ReadContext, input: In<'deferred_reviews'>): Out<'deferred_reviews'>;
  /** `GET /api/review/:id`. */
  screen(r: ReadContext, input: { id: string; round?: number }): ReviewResponse;
  /** *Ask for a fresh packet*: withdraw, `ready` → `declared`, item → progress, owner note. */
  refresh(w: WriteContext, input: { id: string } & RouteBody<'review.refresh'>): ItemSummary;
  /** A reported commit makes open packets stale (called by `evidence.reportCommit`). */
  markStale(
    w: WriteContext,
    input: { item_id: string; sha: string },
  ): Out<'report_commit'>['stale_packets'];
}

/** The owner's packet decision (§5.6), always one atomic call, and deferred follow-ups. */
export interface ReviewDecisionsService {
  decide(
    w: WriteContext,
    input: { id: string } & RouteBody<'review.decide'>,
  ): OwnerOut<DecideResponse>;
  /** *Create test ticket* for a deferred item. */
  createFollowUp(w: WriteContext, input: { hr_item_id: string }): ItemSummary;
}

/** Notes, artifacts and commits (§5.6 staleness, A08). */
export interface EvidenceService {
  addNote(w: WriteContext, input: In<'add_note'>): EventRow;
  linkArtifact(w: WriteContext, input: In<'link_artifact'>): Artifact;
  /** A repeated SHA is a no-op; marks packets stale. */
  reportCommit(w: WriteContext, input: In<'report_commit'>): Out<'report_commit'>;
}

/** Search, filters and the change feed (§5.11, §13). */
export interface SearchService {
  whoami(r: ReadContext, input: { client: string; session_id: string }): Out<'whoami'>;
  listProjects(r: ReadContext): Out<'list_projects'>;
  searchItems(r: ReadContext, input: In<'search_items'>): Out<'search_items'>;
  getChanges(r: ReadContext, input: In<'get_changes'>): Out<'get_changes'>;
  /** The command palette. */
  palette(r: ReadContext, input: RouteQuery<'search.get'>): SearchResponse;
}

/** The owner's read models (UI_SPEC §6). */
export interface ViewsService {
  bootstrap(r: ReadContext): BootstrapResponse;
  needsYou(r: ReadContext, input: RouteQuery<'needsYou.get'>): NeedsYouResponse;
  /** Board, list and map. For `layout=timeline` the `timeline` section comes from `forecast.timeline`. */
  work(r: ReadContext, input: RouteQuery<'work.get'>): WorkResponse;
  itemDetail(r: ReadContext, input: RouteParams<'items.get'>): ItemDetailResponse;
  agents(r: ReadContext, input: RouteQuery<'agents.list'>): AgentsResponse;
  labelPage(r: ReadContext, input: RouteParams<'labels.get'>): LabelPageResponse;
  settings(r: ReadContext): SettingsResponse;
}

/** Links, blocked state and cycles (§5.2). */
export interface LinksService {
  /** Creates, or updates `satisfied_when` on an existing link; a cycle is `validation` with the path. */
  link(w: WriteContext, input: In<'link_items'>): Out<'link_items'>;
  unlink(w: WriteContext, input: In<'unlink_items'>): { removed: true; unblocked: string[] };
  /** Blocked state per item, from each link's effective `satisfied_when`. */
  blockState(r: ReadContext, input: { ids: string[] }): Record<string, BlockState>;
}

/** The dependency subgraph and strongly connected components (§5.2, A11). */
export interface SubgraphService {
  dependencySubgraph(r: ReadContext, input: In<'dependency_subgraph'>): Out<'dependency_subgraph'>;
  /** Cycles (SCCs larger than one node), computed on read. */
  cycles(r: ReadContext, input: { project?: string }): string[][];
}

/** Decision records (§5.14): authority from the actor; owner records are authoritative. */
export interface DecisionsService {
  publish(w: WriteContext, input: Omit<In<'publish_decision'>, 'run_id'>): DecisionRecord;
  list(r: ReadContext, input: Omit<In<'list_decisions'>, 'run_id'>): Out<'list_decisions'>;
  withdraw(
    w: WriteContext,
    input: { decision_id: string; reason: string; expected_version?: number },
  ): DecisionRecord;
  /** Owner only: `authority=owner`, `confirmed_at`. */
  confirm(
    w: WriteContext,
    input: { decision_id: string; expected_version?: number },
  ): DecisionRecord;
}

/** The context bundle (§5.15). Read-only: never marks anything delivered. */
export interface ContextService {
  getContext(r: ReadContext, input: In<'get_context'>): ContextBundle;
}

/** Questions and owner notes (§5.7). */
export interface MessagesService {
  askOwner(w: WriteContext, input: In<'ask_owner'>): Out<'ask_owner'>;
  answer(w: WriteContext, input: { id: string } & RouteBody<'items.answer'>): Question;
  addOwnerNote(
    w: WriteContext,
    input: { id: string } & RouteBody<'items.addNote'>,
  ): { id: string; text: string; at: string };
  /** Not an event: sets `read_by_agent_at`, and puts a `needs_input` run back to `open`. */
  markDelivered(r: ReceiptContext, receipt: DeliveryReceipt): void;
}

/** Documents (§5.10): immutable versions, sha256, limits, preview formats. */
export interface DocumentsService {
  /** `put_document` (≤ 25 MB inline). */
  put(w: WriteContext, input: In<'put_document'>): Out<'put_document'>;
  /** `/agent-upload`, step 1: stream the bytes to disk (≤ 500 MB), before any transaction. */
  stage(r: ReadContext, file: UploadFile): Promise<StagedFile>;
  /** `/agent-upload`, step 2: record the version for staged bytes. */
  commitUpload(
    w: WriteContext,
    input: { fields: UploadFields; staged: StagedFile },
  ): Out<'put_document'>;
  content(r: ReadContext, input: { version_id: string }): DocumentContent;
}

/** Archive (§5.8) and cancel (§5.1; owner decision 23). */
export interface ArchiveService {
  archive(w: WriteContext, input: { id: string }): ItemSummary;
  unarchive(w: WriteContext, input: { id: string }): ItemSummary;
  archiveMany(w: WriteContext, input: { ids: string[] }): string[];
  /** Owner cancel (reason optional, undoable); agents cancel through `set_status`. */
  cancel(
    w: WriteContext,
    input: { id: string; expected_version: number; reason?: string },
  ): ItemSummary;
}

/** Projects: the blocker rule (§5.2) and delete together (§5.12). */
export interface ProjectsService {
  setDefaultSatisfiedWhen(
    w: WriteContext,
    input: { key: string } & RouteBody<'projects.patch'>,
  ): { project: Project; reblocked: string[]; unblocked: string[] };
  /** One transaction plus a tombstone; the docs directory goes after commit. */
  delete(
    w: WriteContext,
    input: { key: string; confirm_key: string },
  ): { deleted: true; key: string };
  /** After commit, and at startup from tombstones: remove `/data/docs/<KEY>`. */
  removeDeletedDocs(r: ReadContext): Promise<string[]>;
}

/**
 * Backups (§5.13). `tasklite restore` runs offline with the server stopped,
 * so it has no service method: it lives in the CLI and `jobs/backup.ts`.
 */
export interface BackupService {
  status(r: ReadContext): BackupLocationStatus[];
  runNow(r: ReadContext): Promise<BackupResult>;
}

/** Dates, burn-down and forecast (§5.9). Forecasts never overwrite planned dates. */
export interface ForecastService {
  timeline(r: ReadContext, input: RouteQuery<'work.get'>): Timeline;
  burndown(r: ReadContext, input: RouteQuery<'burndown.get'>): BurndownResponse;
  forecast(r: ReadContext, input: { project: string }): Forecast;
}

/** Jira import (§9): the dry run is in memory; the token never leaves memory. */
export interface JiraImportService {
  dryRun(r: ReadContext, input: RouteBody<'jira.dryRun'>): JiraImport;
  get(r: ReadContext, input: { import_id: string }): JiraImport;
  /** One transaction; attachment bytes download after the commit. */
  commit(w: WriteContext, input: { import_id: string }): JiraImport;
  cancel(r: ReadContext, input: { import_id: string }): void;
}

/** The diagnostic call log (decision T21): metadata only. */
export interface DiagnosticsService {
  /** JSONL lines, oldest first, for the last `days` days. */
  calls(r: ReadContext, input: RouteQuery<'diagnostics.calls'>): Iterable<string>;
}

/** Owner undo (§5.11; implemented in B2). */
export interface UndoService {
  undo(w: WriteContext, input: { mutation_id: string }): { undone: string };
}

/** Every service. Adapters reach the domain only through this. */
export interface Services {
  items: ItemsService;
  runs: RunsService;
  checklist: ChecklistService;
  humanReview: HumanReviewService;
  packets: PacketsService;
  reviewDecisions: ReviewDecisionsService;
  evidence: EvidenceService;
  search: SearchService;
  views: ViewsService;
  links: LinksService;
  subgraph: SubgraphService;
  decisions: DecisionsService;
  context: ContextService;
  messages: MessagesService;
  documents: DocumentsService;
  archive: ArchiveService;
  projects: ProjectsService;
  backup: BackupService;
  forecast: ForecastService;
  jiraImport: JiraImportService;
  diagnostics: DiagnosticsService;
  recovery: RecoveryService;
  undo: UndoService;
}

/** What services may use besides their context. `services()` reaches the others (late-bound). */
export interface ServiceDeps {
  config: Config;
  secrets: SecretStore;
  callLog: CallLog;
  clock: () => Date;
  log: (line: string) => void;
  services: () => Services;
}
