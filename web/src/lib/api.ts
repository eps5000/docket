/**
 * The typed UI API client (tasks.md T049), derived from the shared route
 * table (`@docket/shared` API_ROUTES), so a route's path, method, input and
 * result types can't drift from the server:
 *
 * - `api['items.patch']({ params: { id }, body })` → the route's typed result;
 * - mutations send `X-Docket-CSRF` from the `docket_csrf` cookie (BUILD_SPEC §3);
 * - an owner mutation's `mutation_id` is handed to `onMutation`, for the
 *   Undo toast (BUILD_SPEC §5.11);
 * - errors throw `ApiError`; a stale write throws `ConflictError` with the
 *   server's `current` record (409);
 * - `queryKeys`: the TanStack Query key factory;
 * - `INVALIDATION` and `keysForChange`: which queries a live-stream event
 *   invalidates (contracts/events.md).
 *
 * Shared contract file (tasks.md, Slice rules).
 */
import {
  API_ROUTES,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  isMutation,
  needsCsrf,
  type ApiRouteDef,
  type ErrorCode,
  type EventType,
  type ObjectKind,
  type RouteBodyInput,
  type RouteId,
  type RouteParamsInput,
  type RouteQueryInput,
  type RouteResult,
} from '@docket/shared';

// ---- CSRF ----

/** The value of cookie `name` in a `document.cookie`-style string, or null. */
export function readCookie(name: string, cookies: string): string | null {
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** The CSRF token to echo on mutations: the `docket_csrf` cookie (double submit). */
export function csrfToken(cookies: string = browserCookies()): string | null {
  return readCookie(CSRF_COOKIE_NAME, cookies);
}

function browserCookies(): string {
  return typeof document === 'undefined' ? '' : document.cookie;
}

// ---- Errors ----

/** Any non-2xx answer: the shared error body `{error: {code, message, details?, current?}}`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly route: RouteId;

  constructor(
    route: RouteId,
    status: number,
    body: { code: ErrorCode; message: string; details?: Record<string, unknown> },
  ) {
    super(body.message);
    this.name = 'ApiError';
    this.route = route;
    this.status = status;
    this.code = body.code;
    if (body.details !== undefined) this.details = body.details;
  }

  /** True for a route a slice hasn't implemented yet (501). */
  get notImplemented(): boolean {
    return this.status === 501;
  }
}

/**
 * `409`: the record changed since it was read (or a claim is held, or an
 * undo came too late). `current` is the server's record; the UI rolls back,
 * shows it and toasts "Changed by codex just now. Showing the latest."
 */
export class ConflictError<T = unknown> extends ApiError {
  readonly current: T;
  constructor(
    route: RouteId,
    body: { code: 'conflict'; message: string; details?: Record<string, unknown>; current?: T },
  ) {
    super(route, 409, body);
    this.name = 'ConflictError';
    this.current = body.current as T;
  }
}

export const isConflict = (err: unknown): err is ConflictError => err instanceof ConflictError;

// ---- Requests ----

/** An input with no fields (`z.strictObject({})` infers `Record<string, never>`). */
type IsEmpty<T> = [keyof T] extends [never] ? true : string extends keyof T ? true : false;

/** Whether a part of the input is absent, optional (no required fields) or required. */
type Has<T> = [T] extends [never]
  ? false
  : IsEmpty<T> extends true
    ? 'optional'
    : Partial<T> extends T
      ? 'optional'
      : 'required';

/** What a route call takes: `params`, `query` and `body`, each only when the route has one. */
export type RouteInput<K extends RouteId> = (Has<RouteParamsInput<K>> extends 'required'
  ? { params: RouteParamsInput<K> }
  : { params?: undefined }) &
  (Has<RouteQueryInput<K>> extends 'required'
    ? { query: RouteQueryInput<K> }
    : { query?: RouteQueryInput<K> }) &
  (Has<RouteBodyInput<K>> extends 'required'
    ? { body: RouteBodyInput<K> }
    : Has<RouteBodyInput<K>> extends 'optional'
      ? { body?: RouteBodyInput<K> }
      : { body?: undefined });

/** A recorded owner mutation, for the Undo toast. */
export interface MutationRecord {
  mutation_id: string;
  route: RouteId;
  undoable: boolean;
}

export interface ApiClientOptions {
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Prefix for every path; '' in the browser (same origin). */
  baseUrl?: string;
  /** The cookie string to read `docket_csrf` from; defaults to `document.cookie`. */
  cookies?: () => string;
  /** Called with the `mutation_id` of every successful owner mutation. */
  onMutation?: (m: MutationRecord) => void;
}

/** `/api/items/RCP-14?scope=all`: the path with its parameters filled in, plus the query string. */
export function buildUrl(
  route: Pick<ApiRouteDef, 'path'>,
  params: Record<string, unknown> | undefined,
  query: Record<string, unknown> | undefined,
): string {
  const path = route.path.replace(/:([A-Za-z_]+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null) throw new Error(`Missing path parameter ${name}`);
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/** What a call resolves to: the typed JSON result, or the raw `Response` for file, JSONL and stream routes. */
export type ClientResult<K extends RouteId> = [RouteResult<K>] extends [never]
  ? Response
  : RouteResult<K>;

export type ApiCall<K extends RouteId> = (input: RouteInput<K>) => Promise<ClientResult<K>>;

export type ApiClient = { [K in RouteId]: ApiCall<K> } & {
  request<K extends RouteId>(id: K, input: RouteInput<K>): Promise<ClientResult<K>>;
};

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? '';
  const cookies = opts.cookies ?? browserCookies;

  async function request<K extends RouteId>(id: K, input: RouteInput<K>): Promise<ClientResult<K>> {
    const route = API_ROUTES[id] as ApiRouteDef;
    const { params, query, body } = input as {
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: Record<string, unknown>;
    };
    const headers: Record<string, string> = { accept: 'application/json' };
    let payload: BodyInit | undefined;
    if (isMutation(route)) {
      if (route.bodyKind === 'multipart') {
        const form = new FormData();
        for (const [key, value] of Object.entries(body ?? {})) {
          if (value === undefined) continue;
          form.set(key, value instanceof Blob ? value : String(value));
        }
        payload = form;
      } else {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body ?? {});
      }
      if (needsCsrf(route)) {
        const token = csrfToken(cookies());
        // Without the cookie the server answers 403 (locked); there is nothing to send.
        if (token) headers[CSRF_HEADER_NAME] = token;
      }
    }

    const doFetch = opts.fetch ?? fetch;
    const res = await doFetch(`${baseUrl}${buildUrl(route, params, query)}`, {
      method: route.method,
      headers,
      body: payload,
      credentials: 'same-origin',
    });

    if (!res.ok) throw await toError(id, res);
    if (route.response.kind !== 'json') return res as ClientResult<K>;
    const result = (await res.json()) as ClientResult<K>;
    const mutationId = (result as { mutation_id?: unknown }).mutation_id;
    if (isMutation(route) && typeof mutationId === 'string') {
      opts.onMutation?.({ mutation_id: mutationId, route: id, undoable: route.undoable });
    }
    return result;
  }

  const calls = Object.fromEntries(
    (Object.keys(API_ROUTES) as RouteId[]).map((id) => [
      id,
      (input: RouteInput<typeof id>) => request(id, input),
    ]),
  );
  return { ...calls, request } as ApiClient;
}

async function toError(id: RouteId, res: Response): Promise<ApiError> {
  let body: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    current?: unknown;
  };
  try {
    body = ((await res.json()) as { error: typeof body }).error;
  } catch {
    body = { code: res.status >= 500 ? 'internal' : 'validation', message: res.statusText };
  }
  if (res.status === 409 && body.code === 'conflict') {
    return new ConflictError(id, { ...body, code: 'conflict' });
  }
  return new ApiError(id, res.status, body);
}

/** The app's client: same origin, cookies from the document. */
export const api = createApiClient();

// ---- Query keys ----

/** Query key families; every key starts with `['docket', family]`. */
export const QUERY_FAMILIES = [
  'bootstrap',
  'needsYou',
  'work',
  'burndown',
  'item',
  'review',
  'agents',
  /** Agents → Workspaces (owner decision 26). */
  'workspaces',
  'search',
  'labels',
  'decisions',
  'settings',
  'jiraImport',
  /** Settings → Agent setup (decision 29): the file list and each file's view. */
  'agentFiles',
  /** A project's Workflow notes (decision 29). */
  'workflow',
  /** The install log (decision 29). */
  'installs',
  /** The push folder card (decision 29). */
  'pushTarget',
  /** Agents' proposed changes to agent files (decision 30). */
  'proposals',
  /** Agent files changed outside Docket (decision 30). */
  'drift',
  /** Onboarding sessions: the Needs you review card (decision 31). */
  'onboarding',
  /** Settings → Shared parts: the registry (decision 36). */
  'sharedParts',
  /** An item's Shared changes section (decision 36). */
  'itemShared',
  /** Settings → Shared parts: the radar card (decision 36). */
  'radar',
] as const;
export type QueryFamily = (typeof QUERY_FAMILIES)[number];

const ROOT = 'docket';

/** The TanStack Query key factory: one key per screen query (UI_SPEC §6). */
export const queryKeys = {
  all: [ROOT] as const,
  family: (family: QueryFamily) => [ROOT, family] as const,
  bootstrap: () => [ROOT, 'bootstrap'] as const,
  needsYou: (query: RouteQueryInput<'needsYou.get'> = {}) => [ROOT, 'needsYou', query] as const,
  /**
   * Decision 43: Overview's numbers and lists sit in the needsYou family, so everything that
   * refreshes Needs you refreshes them too.
   */
  overview: (query: RouteQueryInput<'overview.get'> = {}) =>
    [ROOT, 'needsYou', 'overview', query] as const,
  overviewItems: (query: RouteQueryInput<'overview.items'>) =>
    [ROOT, 'needsYou', 'overview-items', query] as const,
  /** Decision 48: in the needsYou family too, so it refreshes with Overview. */
  brief: (query: RouteQueryInput<'brief.get'> = {}) => [ROOT, 'needsYou', 'brief', query] as const,
  work: (query: RouteQueryInput<'work.get'> = {}) => [ROOT, 'work', query] as const,
  burndown: (query: RouteQueryInput<'burndown.get'> = {}) => [ROOT, 'burndown', query] as const,
  item: (id: string) => [ROOT, 'item', id] as const,
  /** Without `round`: every round of the item's packets (a prefix key). */
  review: (id: string, round?: number) =>
    round === undefined ? ([ROOT, 'review', id] as const) : ([ROOT, 'review', id, round] as const),
  agents: (query: RouteQueryInput<'agents.list'> = {}) => [ROOT, 'agents', query] as const,
  workspaces: (query: RouteQueryInput<'workspaces.list'> = {}) =>
    [ROOT, 'workspaces', query] as const,
  /** Decision 48. Under `workspaces`, so a run or commit event refreshes its verdicts. */
  workspaceCleanup: (project: string) => [ROOT, 'workspaces', 'cleanup', project] as const,
  /** Decision 48. Under `work`, so any change to an item or link refreshes the chain. */
  criticalPath: (id: string) => [ROOT, 'work', 'critical-path', id] as const,
  search: (q: string) => [ROOT, 'search', q] as const,
  label: (project: string, name: string) => [ROOT, 'labels', project, name] as const,
  decisions: (query: RouteQueryInput<'decisions.list'>) => [ROOT, 'decisions', query] as const,
  settings: () => [ROOT, 'settings'] as const,
  /** Decision 39: Settings → Overlap handling. */
  overlapHandling: () => [ROOT, 'overlapHandling'] as const,
  jiraImport: (id: string) => [ROOT, 'jiraImport', id] as const,
  /** The effective set, service-wide or for one project. */
  agentFiles: (query: RouteQueryInput<'agentFiles.list'> = {}) =>
    [ROOT, 'agentFiles', query] as const,
  /** One file's view: every layer and its history. */
  agentFile: (key: string, query: RouteQueryInput<'agentFiles.get'> = {}) =>
    [ROOT, 'agentFiles', key, query] as const,
  /**
   * Each client's install state (decision 34): in the agentFiles family, so edits
   * and drift refresh it, and installs too (install.recorded).
   */
  installState: (query: RouteQueryInput<'installs.state'> = {}) =>
    [ROOT, 'agentFiles', 'install-state', query] as const,
  workflow: (project: string) => [ROOT, 'workflow', project] as const,
  installs: (query: RouteQueryInput<'installs.list'> = {}) => [ROOT, 'installs', query] as const,
  pushTarget: () => [ROOT, 'pushTarget'] as const,
  /** "Proposed changes" on Agent files (decision 30). */
  proposals: (query: RouteQueryInput<'proposals.list'> = {}) => [ROOT, 'proposals', query] as const,
  /** "Changed outside Docket" on Agent files (decision 30). */
  drift: (query: RouteQueryInput<'drift.list'> = {}) => [ROOT, 'drift', query] as const,
  /** Onboarding sessions, for the review card (decision 31). */
  onboarding: (query: RouteQueryInput<'onboarding.list'> = {}) =>
    [ROOT, 'onboarding', query] as const,
  /** A project's shared-part registry (decision 36). */
  sharedParts: (project: string, query: RouteQueryInput<'sharedParts.list'> = {}) =>
    [ROOT, 'sharedParts', project, query] as const,
  /** An item's Shared changes section (decision 36): narrowed per item like `item`. */
  itemShared: (id: string) => [ROOT, 'itemShared', id] as const,
  /** A project's radar card (decision 36). */
  radar: (project: string) => [ROOT, 'radar', project] as const,
};

export type QueryKey = readonly unknown[];

// ---- Live stream → invalidation (contracts/events.md) ----

/** One `event: change` message from `GET /api/stream`. */
export interface StreamChange {
  seq: number;
  type: EventType;
  objects: { kind: ObjectKind; id: string }[];
  /** True only for `packet.submitted`, `question.asked` (decision 21) and `onboarding.finished` (decision 31). */
  for_you: boolean;
}

const ITEM_VIEWS = ['item', 'work', 'needsYou', 'search', 'labels', 'burndown'] as const;
/** A run starting or ending also changes its workspace's state (BUILD_SPEC §5.16). */
const RUNS = ['item', 'work', 'agents', 'needsYou', 'bootstrap', 'workspaces'] as const;
// Decision 38: agents' project-wide decisions are Needs you cards (counted in the sidebar).
const DECISIONS = ['decisions', 'item', 'labels', 'settings', 'needsYou', 'bootstrap'] as const;

/**
 * Which query families each event type invalidates. `item` and `review`
 * are narrowed to the event's item objects when it lists any.
 */
export const INVALIDATION: Record<EventType, readonly QueryFamily[]> = {
  'item.created': [...ITEM_VIEWS, 'bootstrap', 'settings'],
  'item.updated': [...ITEM_VIEWS, 'review'],
  // B41: a close's branch joins the item's reported branches (Shared changes).
  'item.status_changed': [...ITEM_VIEWS, 'review', 'agents', 'bootstrap', 'settings', 'itemShared'],
  'item.archived': ['item', 'work', 'labels', 'burndown', 'settings'],
  'item.unarchived': ['item', 'work', 'labels', 'burndown', 'settings'],
  'link.added': ['item', 'work', 'needsYou', 'bootstrap'],
  'link.removed': ['item', 'work', 'needsYou', 'bootstrap'],
  'link.updated': ['item', 'work', 'needsYou', 'bootstrap'],
  // Decision 36: the radar's settings are on the project (Settings → Shared parts).
  'project.updated': ['bootstrap', 'settings', 'work', 'needsYou', 'item', 'radar'],
  'label.upserted': ['bootstrap', 'labels', 'settings', 'item'],
  'plan.updated': ['item'],
  'step.updated': ['item', 'agents'],
  'subagent.logged': ['item', 'agents'],
  'checks.updated': ['item'],
  'check.updated': ['item'],
  'human_review.declared': ['item', 'work', 'labels'],
  'human_review.updated': ['item', 'work', 'labels'],
  'human_review.removed': ['item', 'work', 'labels'],
  // B41: a claim's branch joins the item's reported branches (Shared changes).
  'claim.granted': [...RUNS, 'itemShared'],
  'claim.rejected': ['item'],
  'claim.released': RUNS,
  'run.started': RUNS,
  'run.ended': RUNS,
  // Recovery (US11). Parking changes the run state everywhere it shows and the
  // workspace state; resources and Handled change Problems and Workspaces.
  'run.parked': RUNS,
  'run.status_updated': RUNS,
  'run.activity': RUNS,
  'run.park_expired': RUNS,
  'run.wait_flagged': RUNS,
  'run.wait_cleared': RUNS,
  'run.resume_ready': RUNS,
  'run.resumed': RUNS,
  'run.unpushed_handled': ['item', 'needsYou', 'bootstrap', 'workspaces'],
  'resource.declared': ['item', 'agents', 'workspaces'],
  'resource.released': ['item', 'agents', 'needsYou', 'bootstrap', 'workspaces'],
  'packet.submitted': ['item', 'review', 'work', 'needsYou', 'bootstrap', 'itemShared'],
  'packet.stale': ['item', 'review', 'needsYou'],
  'packet.withdrawn': ['item', 'review', 'work', 'needsYou', 'bootstrap'],
  'review.decided': ['item', 'review', 'work', 'needsYou', 'bootstrap', 'labels', 'burndown'],
  'question.asked': ['item', 'needsYou', 'bootstrap', 'agents', 'work'],
  'question.answered': ['item', 'needsYou', 'bootstrap', 'agents'],
  'owner_note.added': ['item'],
  'note.added': ['item'],
  'document.added': ['item'],
  // With pushed: true it moves the run's pushed_sha (workspace state, unpushed Problems).
  'commit.reported': ['item', 'review', 'needsYou', 'workspaces'],
  // A merged PR can clear a `merged` blocker (BUILD_SPEC §5.2).
  'artifact.linked': ['item', 'work', 'needsYou'],
  'decision.published': DECISIONS,
  'decision.confirmed': DECISIONS,
  'decision.superseded': DECISIONS,
  'decision.withdrawn': DECISIONS,
  'decision.acknowledged': DECISIONS,
  // Agent setup (decision 29). A file's list row and its view share the family.
  'agent_file.updated': ['agentFiles'],
  'agent_file.reverted': ['agentFiles'],
  'workflow.updated': ['workflow'],
  // Decision 34: an install also changes each client's install state (agentFiles family).
  'install.recorded': ['installs', 'agentFiles'],
  // Proposals and drift (decision 30). A proposal shows on Agent files and as the
  // Needs you line; deciding one changes the file or the Workflow notes. Drift is
  // a Problems row (counted in the sidebar) and a run's "edited locally" chip.
  'agent_file.proposed': ['proposals', 'needsYou'],
  'agent_file.proposal_decided': ['proposals', 'agentFiles', 'workflow', 'needsYou'],
  'drift.detected': ['drift', 'agentFiles', 'needsYou', 'bootstrap', 'item'],
  'drift.resolved': ['drift', 'agentFiles', 'needsYou', 'bootstrap', 'item'],
  // Onboarding (decision 31). A new project shows in the shell, Settings and Needs you;
  // a finished onboarding is for you (the review card and the badge); reviewing it
  // clears the "created by <agent> · review" chip in the shell and Settings.
  'project.created': ['bootstrap', 'settings', 'needsYou'],
  'onboarding.started': ['onboarding', 'bootstrap'],
  'onboarding.finished': ['onboarding', 'needsYou', 'bootstrap'],
  'onboarding.reviewed': ['onboarding', 'needsYou', 'bootstrap', 'settings'],
  // Shared changes (decision 36). The registry shows in Settings and in each item's
  // section; a declaration changes the item, its overlaps and the registry's in-flight
  // lists; overlaps and holds are Needs you cards and Work markers; findings are Problems.
  'shared_part.saved': ['sharedParts', 'itemShared'],
  'shared.declared': ['itemShared', 'sharedParts', 'item', 'work'],
  'overlap.raised': ['itemShared', 'needsYou', 'bootstrap', 'work', 'item'],
  'overlap.decided': ['itemShared', 'needsYou', 'bootstrap', 'work', 'item'],
  'lease.taken': ['itemShared', 'sharedParts', 'item'],
  'lease.ended': ['itemShared', 'sharedParts', 'item'],
  'undeclared.held': ['itemShared', 'needsYou', 'bootstrap', 'item', 'review'],
  'undeclared.decided': ['itemShared', 'needsYou', 'bootstrap', 'item', 'review', 'work'],
  'radar.found': ['radar', 'itemShared', 'needsYou', 'bootstrap', 'work', 'item'],
  'radar.cleared': ['radar', 'itemShared', 'needsYou', 'bootstrap', 'work', 'item'],
  // B40: the item's branch for the radar, reported or found, shows in its section.
  'branch.reported': ['itemShared', 'item'],
  'branch.discovered': ['itemShared', 'item'],
  // Decision 37: an acknowledgement takes a problem off Needs you (the banner keeps it); a
  // proposed resolution is a Needs you card and shows on the banner.
  'problem.acknowledged': ['needsYou', 'bootstrap', 'item'],
  'resolution.proposed': ['needsYou', 'bootstrap', 'item'],
  'resolution.decided': ['needsYou', 'bootstrap', 'item'],
  // Decision 39: a design review is a Needs you card, a banner, and gates a held packet.
  'design_review.raised': ['itemShared', 'needsYou', 'bootstrap', 'item', 'review'],
  'design_review.decided': ['itemShared', 'needsYou', 'bootstrap', 'item', 'review', 'work'],
  // Decision 41: runs stayed open, but their leases moved.
  'service.restarted': RUNS,
};

/** Families narrowed to the event's items when it names any. */
const PER_ITEM: readonly QueryFamily[] = ['item', 'review', 'itemShared'];

/**
 * The query keys to invalidate for one stream message: the event type's
 * families, narrowed to its items where that applies, plus the for-you
 * count (bootstrap) and Needs you when `for_you` is true.
 */
export function keysForChange(change: StreamChange): QueryKey[] {
  const families = new Set<QueryFamily>(INVALIDATION[change.type] ?? QUERY_FAMILIES);
  if (change.for_you) {
    families.add('bootstrap');
    families.add('needsYou');
  }
  const itemIds = [...new Set(change.objects.filter((o) => o.kind === 'item').map((o) => o.id))];
  const keys: QueryKey[] = [];
  for (const family of QUERY_FAMILIES) {
    if (!families.has(family)) continue;
    if (PER_ITEM.includes(family) && itemIds.length > 0) {
      for (const id of itemIds) keys.push([ROOT, family, id]);
    } else {
      keys.push([ROOT, family]);
    }
  }
  return keys;
}
