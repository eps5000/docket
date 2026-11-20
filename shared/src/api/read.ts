/**
 * Reading routes: the shell, Needs you, Work, the item page, Agents, search
 * and the live stream (BUILD_SPEC §7; contracts/ui-api.md US2).
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import {
  AGENT_FILE_SOURCES,
  FILTERS,
  ONBOARDING_CHANGES,
  PROVENANCES,
  SIGNAL_KINDS,
  SUBAGENT_PROVENANCES,
} from '../enums.js';
import { itemId, longText, objectId } from '../mcp/common.js';
import { labelNameSchema } from '../mcp/items.js';
import { deferredReviewsOutput } from '../mcp/read.js';
import {
  decisionRecordSchema,
  itemSchema,
  itemSummarySchema,
  itemTypeSchema,
  runStateSchema,
  statusSchema,
} from '../mcp/types.js';
import { input, jsonResponse, noInput, scopeSchema } from './common.js';
import { onboardingSessionSchema } from './onboarding.js';
import { problemAckSchema, problemExplanationSchema, resolutionRowSchema } from './problems.js';
import {
  overlapRowSchema,
  radarFindingRowSchema,
  undeclaredHoldRowSchema,
} from './shared-changes.js';
import { json, route } from './route.js';
import {
  activityRowSchema,
  epicCardSchema,
  forecastSchema,
  healthSchema,
  labelSchema,
  leadParkedSchema,
  linkEdgeSchema,
  projectSchema,
  runStateCountsSchema,
  workItemSchema,
} from './types.js';

// ---- GET /api/bootstrap ----

export const bootstrapResponse = jsonResponse({
  server_version: z.string(),
  server_time: z.string(),
  projects: z.array(projectSchema),
  labels: z.array(labelSchema),
  /** Sidebar counts. `for_you` also drives the tab title `(N) Docket` (UI_SPEC §6.7a). */
  counts: z.object({
    for_you: z.number().int(),
    problems: z.number().int(),
    planning: z.number().int(),
    runs: runStateCountsSchema,
  }),
  /** Timing the UI needs to label run state and undo honestly (BUILD_SPEC §5.4, §5.11). */
  settings: z.object({
    live_window_s: z.number().int(),
    stale_after_s: z.number().int(),
    lease_s: z.number().int(),
    undo_window_s: z.number().int(),
  }),
  health: healthSchema,
});
export type BootstrapResponse = z.infer<typeof bootstrapResponse>;

// ---- GET /api/needs-you ----

export const forYouRowSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('packet'),
    item_id: z.string(),
    title: z.string(),
    project: z.string(),
    packet_id: z.string(),
    round: z.number().int(),
    to_verify: z.number().int(),
    estimate: z.string(),
    stale: z.boolean(),
    /** The commit it was built from, when stale ("code changed after it was written"). */
    built_from_commit: z.string(),
    submitted_at: z.string(),
  }),
  z.object({
    kind: z.literal('question'),
    item_id: z.string(),
    title: z.string(),
    project: z.string(),
    question_id: z.string(),
    /** `codex · orca-w3`. */
    asked_by: z.string(),
    text: z.string(),
    asked_at: z.string(),
  }),
]);
export type ForYouRow = z.infer<typeof forYouRowSchema>;

export const PROBLEM_KINDS = [
  'stale_run',
  'failed_run',
  'cycle',
  'date_risk',
  'canceled_blocker',
  'deferred_verified_blocker',
  'extra_backup_failed',
  // Recovery (owner decision 26; BUILD_SPEC §5.16; UI_SPEC §6.1)
  'orphaned_resources',
  'unpushed_work',
  'parked_too_long',
  'resume_unattended',
  // Agent files changed outside Docket (owner decision 30; BUILD_SPEC §5.19; UI_SPEC §6.7b-1)
  'agent_files_drift',
  // Two in-flight branches heading for a merge conflict (owner decision 36; BUILD_SPEC §5.21; B39)
  'radar_conflict',
] as const;

export const problemSchema = z.object({
  kind: z.enum(PROBLEM_KINDS),
  /** The item the action opens; null for service problems (extra backup copy). */
  item_id: z.string().nullable(),
  title: z.string().nullable(),
  /** One line, e.g. "RCP-22 needs RCP-12 verified, but 1 check was deferred". */
  reason: z.string(),
  /** Other items involved (the cycle path, the blocker). */
  related: z.array(z.string()),
  /** The link to remove, for a canceled blocker. */
  link_id: z.string().nullable(),
  /** The run a recovery problem is about (*Handled* on unpushed work sends it). */
  run_id: z.string().nullable(),
  /** Orphaned resources: what *Mark released* sends, one call each. */
  resource_ids: z.array(z.string()),
  /** Agent files drift (decision 30): the drift record the row opens (optional; B26). */
  drift_id: z.string().optional(),
  /**
   * Decision 37 (B42; optional): a stable ID (`rdf_…` for a radar finding,
   * else `<kind>:<item or run>`), which the item page's `?problem=` focuses.
   */
  id: z.string().optional(),
  /** Decision 37 (B42; optional): what's wrong, what fixes it, and who acts. */
  explanation: problemExplanationSchema.optional(),
  /**
   * Decision 37 (B42; optional): why an agent problem reached the owner:
   * "Not fixed by an agent for a day" or "Nobody is working on GF-228". Null
   * while agents are handling it, and for the owner's own problems.
   */
  reached_you: z.string().nullable().optional(),
  /**
   * Decision 37 (B42; optional): a radar finding's reported branches, which
   * *Not an active branch* can remove from their item. A branch the radar
   * found by name isn't listed.
   */
  branches: z.array(z.object({ item_id: z.string(), branch: z.string() })).optional(),
  /**
   * Decision 37 (B42; optional): the owner's acknowledgement while it still
   * covers the problem (it left Needs you); null otherwise.
   */
  acknowledged: problemAckSchema.nullable().optional(),
  /** Decision 37 (B42; optional): the newest proposed resolution of this problem. */
  resolution: resolutionRowSchema.nullable().optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export const deferredRowSchema = deferredReviewsOutput.shape.items.element;
export type DeferredRow = z.infer<typeof deferredRowSchema>;

export const needsYouQuery = input({ scope: scopeSchema });
export const needsYouResponse = jsonResponse({
  for_you_now: z.array(forYouRowSchema),
  problems: z.array(problemSchema),
  deferred: z.array(deferredRowSchema),
  planning_queue: z.array(itemSummarySchema),
  agent_counts: runStateCountsSchema,
  /** "n agent file changes proposed" (decision 30; UI_SPEC §6.7b-1): pending proposals in scope (optional; B26). */
  agent_file_proposals: z.number().int().optional(),
  /** Onboardings ready for the owner's review in scope: one card each (decision 31; UI_SPEC §6.7d; optional; B29). */
  onboarding_reviews: z.array(onboardingSessionSchema).optional(),
  /**
   * Decision 36 (UI_SPEC §6.3.6; optional; B38): open overlap questions (a card
   * per pair), open undeclared-parts holds (a card each), and open radar
   * findings (Problems: "Heading for a conflict").
   */
  overlaps: z.array(overlapRowSchema).optional(),
  undeclared_holds: z.array(undeclaredHoldRowSchema).optional(),
  radar_findings: z.array(radarFindingRowSchema).optional(),
  /**
   * Decision 37 (B42; optional): agent problems the items' leads are still
   * within their grace period to fix, so they aren't in `problems` yet: the
   * "Agents are handling N problems" line lists them.
   */
  agent_problems: z.array(problemSchema).optional(),
  /**
   * Decision 37 (B42; optional): problems the owner acknowledged, which left
   * Needs you until they need a human step again ("You acknowledged N").
   */
  acknowledged: z.array(problemSchema).optional(),
  /**
   * Decision 37 (B42; optional): open proposed resolutions, a card each
   * (counted as for you): *Approve*, *Go a different way*, *Acknowledge*.
   */
  resolutions: z.array(resolutionRowSchema).optional(),
});
export type NeedsYouResponse = z.infer<typeof needsYouResponse>;

// ---- GET /api/work ----

/** Filters the Work screen accepts (chips and URL; BUILD_SPEC §13). */
export const UI_FILTER_KEYS = FILTERS.filter((f) => f.ui).map((f) => f.key) as [
  (typeof FILTERS)[number]['key'],
  ...(typeof FILTERS)[number]['key'][],
];
export const uiFilterSchema = z.enum(UI_FILTER_KEYS);

export const WORK_LAYOUTS = ['board', 'list', 'map', 'timeline'] as const;
export const workLayoutSchema = z.enum(WORK_LAYOUTS);

export const workQuery = input({
  scope: scopeSchema,
  epic: itemId.optional(),
  label: labelNameSchema.optional(),
  filter: uiFilterSchema.default('all'),
  layout: workLayoutSchema.default('board'),
  /**
   * The onboarding review card's links (decision 31; UI_SPEC §6.7d; B30
   * contract change): only the items this session (`onb_…`) created or
   * enriched, with the epics row limited the same way. Optional.
   */
  onboarding: objectId.optional(),
  /** With `onboarding`: only the items it created, or only the ones it enriched; both when omitted. */
  onboarding_change: z.enum(ONBOARDING_CHANGES).optional(),
});

export const timelineRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: itemTypeSchema,
  project: z.string(),
  status: statusSchema,
  blocked: z.boolean(),
  planned_start: z.string().nullable(),
  planned_end: z.string().nullable(),
  dates_set_by: z.string().nullable(),
  /** First `progress` → `done`, from history (BUILD_SPEC §5.9). */
  actual_start: z.string().nullable(),
  actual_end: z.string().nullable(),
  overdue: z.boolean(),
  blockers: z.array(
    z.object({
      id: z.string(),
      planned_end: z.string().nullable(),
      /** True when this blocker ends after the item is planned to start (date risk). */
      risky: z.boolean(),
    }),
  ),
});

export const timelineSchema = z.object({
  /** The first and last day shown. */
  from: z.string(),
  to: z.string(),
  rows: z.array(timelineRowSchema),
  /** "Not on the timeline (no dates)". */
  undated: z.array(z.string()),
  forecasts: z.array(z.object({ project: z.string(), forecast: forecastSchema })),
  /**
   * The IANA time zone the server's days are in (config `TZ`, else the
   * container's own zone). The UI draws "today" and the Now line in it, so
   * they agree with the burn-down's days (B18).
   */
  time_zone: z.string(),
});
export type Timeline = z.infer<typeof timelineSchema>;

export const workResponse = jsonResponse({
  layout: workLayoutSchema,
  items: z.array(workItemSchema),
  /** Non-archived epics in scope (the Epics row; not shown on Timeline). */
  epics: z.array(epicCardSchema),
  /** Chip counts. */
  filter_counts: z.partialRecord(uiFilterSchema, z.number().int()),
  /** Links among `items`, plus links from `outside` blockers, for the map. */
  links: z.array(linkEdgeSchema),
  /** Blockers of `items` that aren't in `items` (the map's "Outside this view" column). */
  outside: z.array(itemSummarySchema),
  /** Present only for `layout=timeline`. */
  timeline: timelineSchema.nullable(),
});
export type WorkResponse = z.infer<typeof workResponse>;

// ---- GET /api/items/:id ----

export const itemParams = input({ id: itemId });

export const planVersionSchema = z.object({
  version_no: z.number().int(),
  reason: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  changes: z.array(
    z.object({
      step_id: z.string(),
      text: z.string(),
      change: z.enum(['added', 'removed', 'changed']),
      was_text: z.string().nullable(),
    }),
  ),
});
export type PlanVersion = z.infer<typeof planVersionSchema>;

/** The instruction versions a run reported working from (decision 30; BUILD_SPEC §5.19). */
export const runInstructionsSchema = z.object({
  run_id: z.string(),
  install_id: z.string().nullable(),
  files: z.array(
    z.object({
      key: z.string(),
      /** The skill's name or "AGENTS.md block". */
      name: z.string(),
      /** Which version was sent: the default or the project's copy; null when it isn't known. */
      source: z.enum(AGENT_FILE_SOURCES).nullable(),
      version_no: z.number().int().nullable(),
      /** The reported hash differs from what was sent: the ⚠ "edited locally" chip. */
      edited_locally: z.boolean(),
      /** The drift record the chip links to. */
      drift_id: z.string().nullable(),
    }),
  ),
});
export type RunInstructions = z.infer<typeof runInstructionsSchema>;

export const itemDetailResponse = jsonResponse({
  item: itemSchema,
  /** For an epic: its children, each with whether it's for you ("n for you", UI_SPEC §6.3). Empty otherwise. */
  children: z.array(
    itemSummarySchema.extend({
      for_you: z.boolean(),
      /** The lead's park, when it is parked (B20; the Tickets list's run line). */
      lead_parked: leadParkedSchema.nullable().optional(),
    }),
  ),
  /** Active and inactive records in scope, owner first (UI_SPEC §6.3.5). */
  decisions: z.array(decisionRecordSchema),
  /** The Checklist history dialog. */
  plan_history: z.array(planVersionSchema),
  /** The Activity tab, newest first. */
  activity: z.array(activityRowSchema),
  open_packet: z
    .object({
      packet_id: z.string(),
      round: z.number().int(),
      stale: z.boolean(),
      to_verify: z.number().int(),
      /** The agent's estimate, for "about 10 min" (UI_SPEC §6.3). */
      estimate: z.string().nullable(),
    })
    .nullable(),
  /** "Created from your human review of RCP-12 (…)": set on Bugs and follow-ups made by a review decision. */
  from_review: z
    .object({
      item_id: z.string(),
      round: z.number().int(),
      hr_item_id: z.string(),
      /** The human review item's text, for the banner. */
      text: z.string().nullable(),
    })
    .nullable(),
  /** "Waiting for <agent> to read it" (BUILD_SPEC §5.7). */
  answer_unread: z.boolean(),
  notes_unread: z.number().int(),
  label_briefs: z.array(z.object({ name: z.string(), brief_md: z.string() })),
  links: z.array(linkEdgeSchema),
  /** Items linked to this item (or, for an epic, its children) that aren't among them: 1-hop and "Outside this epic" cards. */
  outside: z.array(itemSummarySchema),
  /**
   * "Instructions: docket-worker · Recipe App's copy v2" on each run that
   * reported them on claim_lead (decision 30; UI_SPEC §6.7b-1; optional; B26).
   */
  run_instructions: z.array(runInstructionsSchema).optional(),
  /**
   * Decision 37 (B42; optional): the item's open problems, the owner's and
   * the ones agents are handling, for the problem banner.
   */
  problems: z.array(problemSchema).optional(),
  /** Decision 37 (B42; optional): open proposed resolutions about the item in general. */
  resolutions: z.array(resolutionRowSchema).optional(),
});
export type ItemDetailResponse = z.infer<typeof itemDetailResponse>;

// ---- GET /api/agents ----

export const agentRowSchema = z.object({
  row_kind: z.enum(['run', 'subagent_log']),
  run_id: z.string().nullable(),
  /** Null for subagent log rows ("log entry"). */
  run_state: runStateSchema.nullable(),
  client: z.string(),
  label: z.string().nullable(),
  item_id: z.string(),
  item_title: z.string(),
  project: z.string(),
  /** Doing / did. */
  doing: z.string().nullable(),
  last_signal_at: z.string().nullable(),
  last_signal_kind: z.enum(SIGNAL_KINDS).nullable(),
  lease_expires_at: z.string().nullable(),
  lease: z.enum(['held', 'expired', 'paused', 'released', 'none']),
  /** How we know, for agent-reported, observed or relayed rows. */
  provenance: z.enum([...PROVENANCES, ...SUBAGENT_PROVENANCES]).nullable(),
  /** What a parked run waits on (B20): "parked · waiting on the coordinator". */
  lead_parked: leadParkedSchema.nullable().optional(),
  at: z.string(),
});
export type AgentRow = z.infer<typeof agentRowSchema>;

export const agentsQuery = input({ scope: scopeSchema });
export const agentsResponse = jsonResponse({ rows: z.array(agentRowSchema) });
export type AgentsResponse = z.infer<typeof agentsResponse>;

// ---- GET /api/search ----

export const searchQuery = input({ q: longText(200) });
export const searchResponse = jsonResponse({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      type: itemTypeSchema,
      status: statusSchema,
      project: z.string(),
      jira_key: z.string().nullable(),
      archived: z.boolean(),
      /**
       * B35: why it matched, when not by ID, Jira key or text: `step_source` is a work step
       * whose `source` holds the query (a Jira sub-task's key), named in `step`.
       */
      matched: z.enum(['step_source']).optional(),
      step: z.object({ id: z.string(), text: z.string(), source: z.string() }).optional(),
    }),
  ),
  labels: z.array(z.object({ project: z.string(), name: z.string() })),
  views: z.array(z.object({ key: z.string(), label: z.string(), path: z.string() })),
});
export type SearchResponse = z.infer<typeof searchResponse>;

// ---- Routes ----

export const readRoutes = {
  'bootstrap.get': route({
    method: 'GET',
    path: '/api/bootstrap',
    group: 'read',
    params: noInput,
    query: noInput,
    body: null,
    response: json(bootstrapResponse),
  }),
  'needsYou.get': route({
    method: 'GET',
    path: '/api/needs-you',
    group: 'read',
    params: noInput,
    query: needsYouQuery,
    body: null,
    response: json(needsYouResponse),
  }),
  /** Board, list and map; `layout=timeline` adds dates and forecasts (US8). */
  'work.get': route({
    method: 'GET',
    path: '/api/work',
    group: 'read',
    params: noInput,
    query: workQuery,
    body: null,
    response: json(workResponse),
  }),
  'items.get': route({
    method: 'GET',
    path: '/api/items/:id',
    group: 'read',
    params: itemParams,
    query: noInput,
    body: null,
    response: json(itemDetailResponse),
  }),
  'agents.list': route({
    method: 'GET',
    path: '/api/agents',
    group: 'read',
    params: noInput,
    query: agentsQuery,
    body: null,
    response: json(agentsResponse),
  }),
  'search.get': route({
    method: 'GET',
    path: '/api/search',
    group: 'read',
    params: noInput,
    query: searchQuery,
    body: null,
    response: json(searchResponse),
  }),
  /** Implemented in B2 (contracts/events.md). */
  'stream.get': route({
    method: 'GET',
    path: '/api/stream',
    group: 'read',
    params: noInput,
    query: noInput,
    body: null,
    response: { kind: 'sse' },
  }),
} as const;
