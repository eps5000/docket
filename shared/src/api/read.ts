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
import { questionFormSchema } from '../mcp/question-form.js';
import { deferredReviewsOutput } from '../mcp/read.js';
import {
  decisionRecordSchema,
  itemSchema,
  itemSummarySchema,
  itemTypeSchema,
  coordinatorParkSchema,
  runActivitySchema,
  runStateSchema,
  statusSchema,
  waitCardSchema,
  waitingRunSchema,
} from '../mcp/types.js';
import { input, jsonResponse, noInput, scopeSchema } from './common.js';
import { onboardingSessionSchema } from './onboarding.js';
import { WORK_CHECKS, WORK_QUICK, WORK_SHOWS } from '../work-filter.js';
import { problemAckSchema, problemExplanationSchema, resolutionRowSchema } from './problems.js';
import {
  designReviewRowSchema,
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
    /** Decision 47: the answer dialog's content. Null on a question asked before it. */
    form: questionFormSchema.nullable().optional(),
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
  // The nightly backup failed or is overdue (owner decision 41; BUILD_SPEC §5.13; B49)
  'backup_missed',
  // Recovery (owner decision 26; BUILD_SPEC §5.16; UI_SPEC §6.1)
  'orphaned_resources',
  'unpushed_work',
  'parked_too_long',
  'resume_unattended',
  // Agent files changed outside Docket (owner decision 30; BUILD_SPEC §5.19; UI_SPEC §6.7b-1)
  'agent_files_drift',
  // Two in-flight branches heading for a merge conflict (owner decision 36; BUILD_SPEC §5.21; B39)
  'radar_conflict',
  // A parked run's wait has no next step, or an owner decision nobody asked for (decision 45; B54)
  'wait_no_next_step',
  'wait_owner_unasked',
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
  /** The run a recovery problem is about (*Keep for later* and *Safe to discard* send it). */
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

/**
 * Decision 38 (B44): agents' project-wide records that predate the review
 * card, one grouped card per project ("3 project-wide decisions by agents to
 * review"), newest first. *Acknowledge all* sends their IDs.
 */
export const projectDecisionGroupSchema = z.object({
  project: z.string(),
  decisions: z.array(z.object({ id: z.string(), title: z.string(), author: z.string() })),
});
export type ProjectDecisionGroup = z.infer<typeof projectDecisionGroupSchema>;

export const needsYouQuery = input({ scope: scopeSchema });
export const needsYouResponse = jsonResponse({
  for_you_now: z.array(forYouRowSchema),
  problems: z.array(problemSchema),
  deferred: z.array(deferredRowSchema),
  planning_queue: z.array(itemSummarySchema),
  agent_counts: runStateCountsSchema,
  /**
   * Decision 43 (B51; optional): stories, never raw runs, in this response's scope.
   * `working` is the sidebar's Agents badge and the Overview card, from this one field.
   * `waiting` is shown beside it on the card and is not in the badge.
   */
  agents_now: z.object({ working: z.number().int(), waiting: z.number().int() }).optional(),
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
  /** Decision 39 (B46; optional): open reviews of a change to an approved design, a card each. */
  design_reviews: z.array(designReviewRowSchema).optional(),
  radar_findings: z.array(radarFindingRowSchema).optional(),
  /**
   * Decision 39 (B46; optional): the quiet line "Docket handled N overlaps
   * today", with the overlaps it links to (up to 20, newest first).
   */
  overlaps_handled: z
    .object({ count: z.number().int(), rows: z.array(overlapRowSchema) })
    .optional(),
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
  /**
   * Decision 38 (B44; optional): agents' new project-wide records, a card each
   * (counted as for you), until the owner confirms, withdraws, supersedes or
   * acknowledges them. Item, epic and label records never appear here.
   */
  project_decisions: z.array(decisionRecordSchema).optional(),
  /** Decision 38 (B44; optional): the older ones, one card per project (counted as for you). */
  project_decision_groups: z.array(projectDecisionGroupSchema).optional(),
});
export type NeedsYouResponse = z.infer<typeof needsYouResponse>;

/**
 * What the owner can act on in a Needs you response (owner decision 41; B49):
 * every card, plus the Problems that reached them. Problems agents are still
 * handling, acknowledged ones, and the Deferred and Planning lists aren't
 * counted. The sidebar badge, the tab title and the page all use this, on the
 * same response, so they can't disagree.
 */
export function needsYouCount(view: NeedsYouResponse): number {
  return (
    view.for_you_now.length +
    view.problems.length +
    (view.onboarding_reviews?.length ?? 0) +
    (view.overlaps?.length ?? 0) +
    (view.undeclared_holds?.length ?? 0) +
    (view.design_reviews?.length ?? 0) +
    (view.resolutions?.length ?? 0) +
    (view.project_decisions?.length ?? 0) +
    (view.project_decision_groups?.length ?? 0)
  );
}

// ---- GET /api/work ----

/** Filters the Work screen accepts (chips and URL; BUILD_SPEC §13). */
export const UI_FILTER_KEYS = FILTERS.filter((f) => f.ui).map((f) => f.key) as [
  (typeof FILTERS)[number]['key'],
  ...(typeof FILTERS)[number]['key'][],
];
export const uiFilterSchema = z.enum(UI_FILTER_KEYS);

export const WORK_LAYOUTS = ['board', 'list', 'map', 'timeline'] as const;
export const workLayoutSchema = z.enum(WORK_LAYOUTS);

/** A comma-separated list of known keys, as one query parameter (`has=for_you,live_run`). */
const csvOf = (keys: readonly string[]) =>
  z.string().refine((v) => v.split(',').every((k) => keys.includes(k)), {
    message: `Expected a comma-separated list of: ${keys.join(', ')}.`,
  });

export const workQuery = input({
  scope: scopeSchema,
  epic: itemId.optional(),
  label: labelNameSchema.optional(),
  /**
   * The old single filter (before B43). Used only when none of `quick`, `has`
   * and `show` is given, mapped by `legacyWorkFilter`; with none of the four,
   * the view is the old *All* (Active with Shows done).
   */
  filter: uiFilterSchema.optional(),
  /** B43 (UI_SPEC §6.2): the quick filter; `active` when omitted. */
  quick: z.enum(WORK_QUICK).optional(),
  /** B43: the ticked checks, comma-separated (each narrows the view). */
  has: csvOf(WORK_CHECKS).optional(),
  /** B43: `done`, `canceled` or both, comma-separated (each adds those items back). */
  show: csvOf(WORK_SHOWS).optional(),
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
  /**
   * B43: the counts for the chips and the Filters menu, over the epic and
   * label scope (`workFilterCounts`): each chip and check counts what you'd
   * see with it chosen; each show counts the items it adds.
   */
  filter_counts: z.object({
    quick: z.record(z.enum(WORK_QUICK), z.number().int()),
    has: z.record(z.enum(WORK_CHECKS), z.number().int()),
    show: z.record(z.enum(WORK_SHOWS), z.number().int()),
    archived: z.number().int(),
  }),
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
      /** Decision 48: a split moved acceptance criteria after this packet was built. */
      criteria_changed: z.boolean().optional(),
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
  /** Decision 47: the open question's answer dialog content; null on an older question. */
  question_form: questionFormSchema.nullable().optional(),
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
  /** Decision 45 (B54; optional): the wait card of the item's parked lead. */
  wait: waitCardSchema.nullable().optional(),
  /** Decision 45 (B54; optional): parked runs this item would unblock. */
  waiting_runs: z.object({ total: z.number().int(), rows: z.array(waitingRunSchema) }).optional(),
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
  /** Decision 42: the story's producer, the activity flag, and who last set the status. */
  producer: z.string().optional(),
  activity: runActivitySchema.optional(),
  updated_by: z.string().optional(),
  /** Decision 44: a coordinator's time-limited park, holding or just run out. */
  coordinator_park: coordinatorParkSchema.optional(),
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
