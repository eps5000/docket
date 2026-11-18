/**
 * The sample seed (BUILD_SPEC §8): maps `design/sample-data.json` into the
 * schema, so the acceptance tests run against a known state.
 *
 * - Deterministic: the same data and the same clock give the same rows,
 *   byte for byte. IDs are derived from a hash of what they identify (valid
 *   ULIDs with a fixed time part), never from randomness.
 * - Time shift: the prototype's clock is 2026-11-06T11:00. Every instant
 *   moves by `now − that clock`, so "silent 47m" stays 47 minutes; planned
 *   dates move by whole days. `'09:10'` means that day, `'Nov 5'` a date.
 * - Writes go straight to the tables in one transaction (domain services
 *   don't exist yet in B2); history becomes seeded events with no inverse.
 * - Only loads into an empty database.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { EventType } from '@docket/shared';
import type { Db } from '../client.js';

// ---- The shorthand in sample-data.json ----

type Shorthand = string;
interface SampleHr {
  t: string;
  state: 'declared' | 'ready' | 'approved' | 'deferred';
  epicLevel?: boolean;
  at?: Shorthand;
  last?: { round: number; note?: string; deferred?: boolean; approved?: boolean; ref?: string };
}
interface SampleItem {
  id: string;
  type: 'Epic' | 'Story' | 'Task' | 'Bug';
  title: string;
  status: string;
  prio: 1 | 2 | 3;
  proj: string;
  last?: Shorthand;
  epic?: string;
  labels?: string[];
  blockedBy?: string[];
  relates?: string[];
  fromReview?: string;
  lead?: string;
  run?: 'live' | 'reported' | 'stale' | 'needs' | 'failed' | 'finished';
  age?: Shorthand;
  start?: string;
  end?: string;
  setBy?: string;
  actual?: [string, string | null];
  pts?: number;
  closedBy?: 'owner' | 'agent' | 'imported';
  imported?: boolean;
  round?: number;
  head?: string;
  headNote?: string;
  question?: { by: string; at: Shorthand; text: string };
  hr?: SampleHr[];
}
interface SampleWork {
  s: string;
  t: string;
  who?: string;
  when?: Shorthand;
  was?: string;
  why?: string;
  from?: string;
  contrib?: [string, string, string, string][];
}
interface SampleDetail {
  outcome?: string;
  acceptance?: string[];
  planVer?: number;
  work?: SampleWork[];
  checks?: [string, string, string, string, string?][];
  history?: { v: number; at: Shorthand; by: string; note: string }[];
  docs?: [string, string, string, Shorthand][];
  runs?: { r: string | null; who: string; what: string; lead?: boolean }[];
  conflict?: string;
  error?: string;
  activity?: [Shorthand, string][];
}
interface SampleRound {
  n: number;
  by: string;
  when: Shorthand;
  sha: string;
  est?: string;
  commit?: string;
  items?: string[];
  how?: string[];
  checked?: [string, string, string][];
  gaps?: string[];
  attach?: [string, string][];
  decided?: {
    when: Shorthand;
    verdicts: { k: 'approve' | 'changes' | 'defer'; note?: string; into?: string; ref?: string }[];
  };
}
export interface SampleData {
  projects: Record<string, { key: string; name: string; short: string; color: string }>;
  labels: Record<string, { proj: string; brief: string; by?: string }>;
  items: SampleItem[];
  detail: Record<string, SampleDetail>;
  packets: Record<string, { rounds: SampleRound[] }>;
  changes: [Shorthand, string, string][];
}

// ---- Locating and reading the data ----

export function sampleDataPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db/seed and dist/db/seed are both four levels below the repository
  // root (or /app in the image), where design/sample-data.json lives.
  const path = join(here, '..', '..', '..', '..', 'design', 'sample-data.json');
  if (!existsSync(path)) throw new Error(`Sample data not found at ${path}`);
  return path;
}

export function readSampleData(path = sampleDataPath()): SampleData {
  return JSON.parse(readFileSync(path, 'utf8')) as SampleData;
}

export function isDatabaseEmpty(db: Db): boolean {
  const row = db.sqlite.prepare('SELECT count(*) AS n FROM projects').get() as { n: number };
  return row.n === 0;
}

// ---- Time ----

/** The prototype's clock: 2026-11-06T11:00 (interpreted as UTC; only differences matter). */
export const PROTOTYPE_CLOCK = Date.UTC(2026, 10, 6, 11, 0);
const PROTOTYPE_DAY = Date.UTC(2026, 10, 6);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};
const RELATIVE: Record<string, number> = { s: 1_000, m: MINUTE, h: HOUR, d: DAY };

/** A shorthand time ("40s", "09:10", "Nov 5", "Nov 5 16:10", "changed 10:05") on the prototype clock. */
export function protoInstant(text: string | undefined | null): number | null {
  if (!text) return null;
  const rel = /^(\d+)(s|m|h|d)$/.exec(text.trim());
  if (rel) return PROTOTYPE_CLOCK - Number(rel[1]) * RELATIVE[rel[2]!]!;
  const date = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (date) return Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), 12, 0);
  const md =
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?: (\d{1,2}):(\d{2}))?\b/.exec(
      text,
    );
  if (md) {
    const hour = md[3] === undefined ? 12 : Number(md[3]);
    const minute = md[4] === undefined ? 0 : Number(md[4]);
    return Date.UTC(2026, MONTHS[md[1]!]!, Number(md[2]), hour, minute);
  }
  const hm = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (hm) return Date.UTC(2026, 10, 6, Number(hm[1]), Number(hm[2]));
  return null;
}

class Clock {
  private readonly delta: number;
  private readonly dayDelta: number;

  constructor(now: Date) {
    this.delta = now.getTime() - PROTOTYPE_CLOCK;
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    this.dayDelta = Math.round((today - PROTOTYPE_DAY) / DAY);
  }

  /** Shift a prototype instant (ms) to the real clock, as ISO-8601. */
  iso(protoMs: number): string {
    return new Date(protoMs + this.delta).toISOString();
  }

  /** Shift a shorthand time; `fallback` (prototype ms) when it doesn't parse. */
  at(text: string | undefined | null, fallback: number): string {
    return this.iso(protoInstant(text) ?? fallback);
  }

  /** Shift a `YYYY-MM-DD` by whole days. */
  date(text: string | undefined | null): string | null {
    if (!text) return null;
    const [y, m, d] = text.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!) + this.dayDelta * DAY).toISOString().slice(0, 10);
  }
}

// ---- Deterministic IDs ----

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulidTime(ms: number): string {
  let out = '';
  let rest = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[rest % 32]! + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

const SEED_TIME = ulidTime(PROTOTYPE_CLOCK);

/** `<prefix>_<ULID>`, stable for the same parts. */
export function seedId(prefix: string, ...parts: (string | number)[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest();
  let random = '';
  for (let i = 0; i < 16; i++) random += CROCKFORD[digest[i]! % 32];
  return `${prefix}_${SEED_TIME}${random}`;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// ---- Actors ----

interface SeedActor {
  kind: 'owner' | 'agent' | 'system';
  client: string | null;
  label: string | null;
}

/** "claude · orca-w3" → claude, orca-w3; "owner" → the owner. */
function parseActor(text: string | undefined): SeedActor {
  const [name, label] = (text ?? '').split('·').map((s) => s.trim());
  if (!name || name === 'owner' || name === 'you')
    return { kind: 'owner', client: null, label: null };
  return { kind: 'agent', client: name, label: label || null };
}

const KNOWN_CLIENTS = ['claude', 'codex'];

// ---- Activity text → event type ----

const ACTIVITY_TYPES: [RegExp, EventType][] = [
  [/created the epic/i, 'item.created'],
  [/claim .*rejected|claim by .* rejected/i, 'claim.rejected'],
  [/claimed lead/i, 'claim.granted'],
  [/requested changes|closed the ticket/i, 'review.decided'],
  [/handoff packet|packet ready/i, 'packet.submitted'],
  [/revised the checklist/i, 'plan.updated'],
  [/run .*failed|failed:/i, 'run.ended'],
  [/child run .* finished/i, 'run.ended'],
  [/reported commit/i, 'commit.reported'],
  [/asked you a question/i, 'question.asked'],
  [/declared .*human review/i, 'human_review.declared'],
  [/attached|updated the brief/i, 'document.added'],
  [/ci build .* passed/i, 'artifact.linked'],
  [/moved .* to planning/i, 'item.status_changed'],
  [/work item \d|reported progress/i, 'step.updated'],
];

function activityType(summary: string): EventType {
  return ACTIVITY_TYPES.find(([re]) => re.test(summary))?.[1] ?? 'note.added';
}

// ---- The loader ----

export interface SeedOptions {
  /** The real clock; every prototype time is shifted relative to it. */
  now: Date;
  /** `/data/docs`: generated document bytes are written here. */
  docsDir: string;
  data?: SampleData;
}

export type SeedSummary = Record<string, number>;

const STATUS_LABEL: Record<string, string> = {
  inbox: 'Inbox',
  planning: 'Planning',
  ready: 'Ready',
  progress: 'In progress',
  review: 'Review',
  done: 'Done',
  canceled: 'Canceled',
};

const MIME: Record<string, string> = {
  md: 'text/markdown',
  json: 'application/json',
  png: 'image/png',
  mp4: 'video/mp4',
  txt: 'text/plain',
};

export const SEED_TABLES = [
  'projects',
  'labels',
  'items',
  'acceptance_criteria',
  'item_labels',
  'links',
  'plan_versions',
  'runs',
  'work_steps',
  'subagent_logs',
  'agent_checks',
  'hr_items',
  'documents',
  'document_versions',
  'packets',
  'packet_items',
  'packet_attachments',
  'review_decisions',
  'questions',
  'commits',
  'decision_records',
  'events',
] as const;

/** Decision records (not in sample-data.json; BUILD_SPEC §8). */
const DECISIONS = [
  {
    id: 'dec_1',
    project: 'RCP',
    scope_kind: 'epic',
    scope_id: 'RCP-1',
    authority: 'owner',
    author: 'owner',
    title: 'Units are metric internally; convert on display',
    at: Date.UTC(2026, 10, 2, 10, 0),
  },
  {
    id: 'dec_2',
    project: 'DOC',
    scope_kind: 'project',
    scope_id: null,
    authority: 'agent',
    author: 'codex',
    title: 'API reference pages show one request and one response example per endpoint',
    at: Date.UTC(2026, 10, 4, 15, 0),
  },
  {
    id: 'dec_3',
    project: 'RCP',
    scope_kind: 'label',
    scope_id: 'ui-refresh',
    authority: 'agent',
    author: 'claude',
    title: 'Use design tokens v2 spacing (8 px grid)',
    at: Date.UTC(2026, 10, 5, 9, 30),
  },
] as const;

/** The blocker rule override from BUILD_SPEC §8. */
const LINK_OVERRIDES: Record<string, 'merged'> = { 'RCP-19>RCP-16': 'merged' };

export function loadSampleSeed(db: Db, opts: SeedOptions): SeedSummary {
  const data = opts.data ?? readSampleData();
  const clock = new Clock(opts.now);
  const sqlite = db.sqlite;

  const rows: { table: string; row: Record<string, unknown> }[] = [];
  const files: { path: string; bytes: Buffer }[] = [];
  const add = (table: string, row: Record<string, unknown>) => rows.push({ table, row });

  interface SeedEvent {
    at: number;
    order: number;
    actor: SeedActor;
    project: string;
    item: string | null;
    type: EventType;
    summary: string;
    data: Record<string, unknown>;
  }
  const events: SeedEvent[] = [];
  const event = (e: Omit<SeedEvent, 'order'>) => events.push({ ...e, order: events.length });

  const byId = new Map(data.items.map((i) => [i.id, i]));
  const itemProject = (id: string) => byId.get(id)?.proj ?? id.split('-')[0]!;
  const leadOf = (item: SampleItem): SeedActor | null => (item.lead ? parseActor(item.lead) : null);

  // ---- Projects and labels ----
  const projectCreated = PROTOTYPE_CLOCK - 7 * DAY;
  for (const p of Object.values(data.projects)) {
    const maxN = Math.max(
      0,
      ...data.items.filter((i) => i.proj === p.key).map((i) => Number(i.id.split('-')[1])),
    );
    add('projects', {
      id: seedId('prj', p.key),
      key: p.key,
      name: p.name,
      short_name: p.short,
      color: p.color,
      next_seq: maxN + 1,
      default_satisfied_when: 'done',
      deleted_at: null,
      version: 1,
      created_at: clock.iso(projectCreated),
      updated_at: clock.iso(projectCreated),
    });
  }
  const labelIds = new Map<string, string>();
  for (const [name, l] of Object.entries(data.labels)) {
    const id = seedId('lbl', l.proj, name);
    labelIds.set(`${l.proj}/${name}`, id);
    const by = l.by ? l.by.split('·').map((s) => s.trim()) : [];
    const briefAt = by[1] ? clock.at(by[1], projectCreated) : null;
    add('labels', {
      id,
      project_key: l.proj,
      name,
      brief_md: l.brief,
      brief_by: by[0] ?? null,
      brief_at: briefAt,
      version: 1,
      created_at: clock.iso(projectCreated),
      updated_at: briefAt ?? clock.iso(projectCreated),
    });
  }

  // ---- Review cross-references (from_review, last decisions) ----
  /** "RCP-17" → {item RCP-12, round 1, hr index 1}, from packet verdicts and hr follow-ups. */
  const reviewOrigin = new Map<string, { item: string; round: number; hrIndex: number }>();
  /** item → hr index → the latest decided verdict. */
  const lastVerdict = new Map<
    string,
    Map<
      number,
      { round: number; when: string; v: NonNullable<SampleRound['decided']>['verdicts'][number] }
    >
  >();
  for (const [itemId, { rounds }] of Object.entries(data.packets)) {
    for (const round of rounds) {
      if (!round.decided) continue;
      round.decided.verdicts.forEach((v, i) => {
        if (v.ref) reviewOrigin.set(v.ref, { item: itemId, round: round.n, hrIndex: i });
        const map = lastVerdict.get(itemId) ?? new Map();
        map.set(i, { round: round.n, when: round.decided!.when, v });
        lastVerdict.set(itemId, map);
      });
    }
  }
  for (const item of data.items) {
    item.hr?.forEach((h, i) => {
      if (h.last?.ref)
        reviewOrigin.set(h.last.ref, { item: item.id, round: h.last.round, hrIndex: i });
    });
  }
  const hrId = (itemId: string, index: number) => seedId('hr', itemId, index);
  const fromReviewOf = (itemId: string) => {
    const o = reviewOrigin.get(itemId);
    return o ? { item_id: o.item, round: o.round, hr_item_id: hrId(o.item, o.hrIndex) } : null;
  };

  // ---- Items ----
  for (const item of data.items) {
    const detail = data.detail[item.id] ?? {};
    const lead = leadOf(item);
    const updated = protoInstant(item.last) ?? PROTOTYPE_CLOCK;
    const times = [
      updated,
      ...(detail.activity ?? []).map(([t]) => protoInstant(t) ?? updated),
      ...(detail.history ?? []).map((h) => protoInstant(h.at) ?? updated),
      ...(item.actual?.[0] ? [Date.UTC(...ymd(item.actual[0]), 9, 0)] : []),
    ];
    const created = Math.min(...times) - HOUR;
    const setBy = item.setBy?.split('·').map((s) => s.trim());
    // Actual dates: work starts 09:00 and ends 17:00 that day, never after the item's last activity.
    const actualStart = item.actual?.[0]
      ? Math.min(Date.UTC(...ymd(item.actual[0]), 9, 0), updated)
      : null;
    const actualEnd = item.actual?.[1]
      ? Math.min(Date.UTC(...ymd(item.actual[1]), 17, 0), updated)
      : null;
    const closedAt = item.status === 'done' ? actualEnd : null;
    add('items', {
      id: item.id,
      project_key: item.proj,
      type: item.type,
      title: item.title,
      description_md: '',
      outcome_md: detail.outcome ?? '',
      status: item.status,
      priority: item.prio,
      epic_id: item.epic ?? null,
      planned_start: clock.date(item.start),
      planned_end: clock.date(item.end),
      dates_set_by: setBy?.[0] ?? null,
      dates_set_at: setBy?.[1] ? clock.at(setBy[1], created) : null,
      effort: item.pts ?? null,
      effort_unit: 'pts',
      closed_by: item.status === 'done' ? (item.closedBy ?? null) : null,
      closed_at: closedAt === null ? null : clock.iso(closedAt),
      archived_at: null,
      jira_key: item.imported ? `DOCS-${100 + Number(item.id.split('-')[1])}` : null,
      imported: item.imported ? 1 : 0,
      from_review: fromReviewOf(item.id),
      version: 1,
      created_at: clock.iso(created),
      updated_at: clock.iso(updated),
    });

    detail.acceptance?.forEach((text, i) =>
      add('acceptance_criteria', {
        id: seedId('ac', item.id, i),
        item_id: item.id,
        position: i,
        text,
        created_at: clock.iso(created),
        updated_at: clock.iso(created),
      }),
    );
    for (const name of item.labels ?? []) {
      add('item_labels', {
        id: seedId('il', item.id, name),
        item_id: item.id,
        label_id: labelIds.get(`${item.proj}/${name}`),
        created_at: clock.iso(created),
        updated_at: clock.iso(created),
      });
    }

    // Actual dates become status history: first In progress, then the end state.
    if (actualStart !== null) {
      event({
        at: actualStart,
        actor: lead ?? parseActor('owner'),
        project: item.proj,
        item: item.id,
        type: 'item.status_changed',
        summary: `${item.id} moved to In progress`,
        data: { status: { old: 'ready', new: 'progress' } },
      });
    }
    if (actualEnd !== null && (item.status === 'done' || item.status === 'review')) {
      event({
        at: actualEnd,
        actor:
          item.status === 'done' && item.closedBy === 'owner'
            ? parseActor('owner')
            : (lead ?? parseActor('owner')),
        project: item.proj,
        item: item.id,
        type: 'item.status_changed',
        summary: `${item.id} moved to ${STATUS_LABEL[item.status]}`,
        data: { status: { old: 'progress', new: item.status } },
      });
    }
  }

  // ---- Links ----
  for (const item of data.items) {
    for (const blocker of item.blockedBy ?? []) {
      add('links', {
        id: seedId('lnk', blocker, item.id, 'blocks'),
        from_id: blocker,
        to_id: item.id,
        type: 'blocks',
        satisfied_when: LINK_OVERRIDES[`${blocker}>${item.id}`] ?? null,
        created_by: 'owner',
        version: 1,
        created_at: clock.iso(projectCreated),
        updated_at: clock.iso(projectCreated),
      });
    }
    for (const other of item.relates ?? []) {
      add('links', {
        id: seedId('lnk', item.id, other, 'relates'),
        from_id: item.id,
        to_id: other,
        type: 'relates',
        satisfied_when: null,
        created_by: 'owner',
        version: 1,
        created_at: clock.iso(projectCreated),
        updated_at: clock.iso(projectCreated),
      });
    }
  }

  // ---- Checklist, runs, documents, packets, questions, commits ----
  for (const item of data.items) {
    const detail = data.detail[item.id] ?? {};
    const lead = leadOf(item);
    const leadClient = lead?.kind === 'agent' ? lead.client : null;
    const updated = protoInstant(item.last) ?? PROTOTYPE_CLOCK;
    const fallback = updated - HOUR;

    // Plan versions.
    const planVersion = detail.planVer ?? 1;
    if (detail.history?.length) {
      for (const h of detail.history) {
        add('plan_versions', {
          id: seedId('pv', item.id, h.v),
          item_id: item.id,
          version_no: h.v,
          reason: h.note,
          created_by: h.by,
          created_at: clock.at(h.at, fallback),
          updated_at: clock.at(h.at, fallback),
        });
      }
    } else if (detail.work?.length) {
      const first = detail.work[0]!;
      add('plan_versions', {
        id: seedId('pv', item.id, 1),
        item_id: item.id,
        version_no: 1,
        reason: null,
        created_by: first.who ?? leadClient ?? 'agent',
        created_at: clock.at(first.when, fallback),
        updated_at: clock.at(first.when, fallback),
      });
    }

    // Runs: the lead run from `lead`/`run`, child runs from `detail.runs`.
    const leadRunId = item.lead ? seedId('run', item.id, 'lead') : null;
    const stepIds = (detail.work ?? []).map((_, i) => seedId('wst', item.id, i));
    const currentStep = (detail.work ?? []).findIndex((w) => w.s === 'current');
    if (lead && leadRunId && item.run) {
      const lastSignal = protoInstant(item.age) ?? updated;
      const leadInfo = detail.runs?.find((r) => r.lead)?.what ?? '';
      const open = ['live', 'reported', 'stale'].includes(item.run);
      const leaseText = /lease (?:until|expires) (\d{1,2}:\d{2})/.exec(leadInfo)?.[1];
      const lease = open ? (protoInstant(leaseText) ?? lastSignal + HOUR) : null;
      const startCandidates = [
        lastSignal,
        ...(detail.history?.[0] ? [protoInstant(detail.history[0].at) ?? lastSignal] : []),
        ...(detail.activity ?? [])
          .filter(([, s]) => /claimed lead/i.test(s))
          .map(([t]) => protoInstant(t) ?? lastSignal),
        ...(item.actual?.[0] ? [Date.UTC(...ymd(item.actual[0]), 9, 0)] : []),
      ];
      const started = Math.min(...startCandidates);
      const state =
        item.run === 'needs'
          ? 'needs_input'
          : item.run === 'failed'
            ? 'failed'
            : item.run === 'finished'
              ? 'finished'
              : 'open';
      add('runs', {
        id: leadRunId,
        item_id: item.id,
        parent_run_id: null,
        client: lead.client ?? 'agent',
        label: lead.label,
        session_id: state === 'open' || state === 'needs_input' ? `seed-session-${item.id}` : null,
        is_lead: 1,
        state,
        last_signal_at: clock.iso(lastSignal),
        last_signal_kind: item.run === 'reported' ? 'report' : 'session',
        lease_expires_at: lease === null ? null : clock.iso(lease),
        summary: null,
        error: item.run === 'failed' ? (detail.error ?? null) : null,
        current_step_id: currentStep >= 0 ? stepIds[currentStep] : null,
        version: 1,
        created_at: clock.iso(started),
        updated_at: clock.iso(lastSignal),
      });
    }
    const childRuns = new Map<string, string>();
    for (const r of detail.runs ?? []) {
      if (r.lead || r.r === null || !leadRunId) continue;
      const id = seedId('run', item.id, r.who);
      childRuns.set(r.who, id);
      const finished = protoInstant(/finished (\d{1,2}:\d{2})/.exec(r.what)?.[1]) ?? updated;
      const source = (detail.work ?? [])
        .flatMap((w) => w.contrib ?? [])
        .find((c) => c[1] === r.who)?.[2];
      const client = KNOWN_CLIENTS.find((c) => source?.startsWith(c)) ?? leadClient ?? 'agent';
      add('runs', {
        id,
        item_id: item.id,
        parent_run_id: leadRunId,
        client,
        label: r.who,
        session_id: null,
        is_lead: 0,
        state: r.r === 'failed' ? 'failed' : r.r === 'finished' ? 'finished' : 'open',
        last_signal_at: clock.iso(finished),
        last_signal_kind: 'relayed',
        lease_expires_at: null,
        summary: null,
        error: null,
        current_step_id: null,
        version: 1,
        created_at: clock.iso(finished - 30 * MINUTE),
        updated_at: clock.iso(finished),
      });
    }

    // Work steps and subagent logs.
    const checklistVerdict = [...(lastVerdict.get(item.id)?.entries() ?? [])].find(
      ([, x]) => x.v.k === 'changes' && x.v.into === 'checklist',
    );
    (detail.work ?? []).forEach((w, i) => {
      const at = clock.at(w.when, fallback);
      const round = w.from ? /round (\d+)/.exec(w.from)?.[1] : undefined;
      add('work_steps', {
        id: stepIds[i],
        item_id: item.id,
        plan_version_no: planVersion,
        position: i,
        text: w.t,
        state: w.s,
        was_text: w.was ?? null,
        change_reason: w.why ?? null,
        from_review:
          round && checklistVerdict
            ? {
                item_id: item.id,
                round: Number(round),
                hr_item_id: hrId(item.id, checklistVerdict[0]),
              }
            : null,
        added_by: w.who ?? leadClient ?? 'agent',
        state_by: w.who ?? null,
        state_at: w.when ? at : null,
        version: 1,
        created_at: at,
        updated_at: at,
      });
      (w.contrib ?? []).forEach(([provenance, name, source, outcomeText], j) => {
        const [outcome, when] = outcomeText.split(' · ');
        const logAt = clock.at(when, fallback);
        add('subagent_logs', {
          id: seedId('sub', item.id, i, j),
          item_id: item.id,
          work_step_id: stepIds[i],
          name,
          outcome: outcome ?? outcomeText,
          evidence: source,
          provenance,
          child_run_id: provenance === 'observed' ? (childRuns.get(name) ?? null) : null,
          reported_by_run_id: leadRunId,
          created_at: logAt,
          updated_at: logAt,
        });
      });
    });

    // Agent checks: [text, provenance, evidence, state, by].
    (detail.checks ?? []).forEach(([text, provenance, evidence, state, by], i) => {
      add('agent_checks', {
        id: seedId('chk', item.id, i),
        item_id: item.id,
        position: i,
        text,
        state,
        evidence: evidence === 'not run yet' ? null : evidence,
        provenance,
        added_by: by ?? leadClient ?? 'agent',
        version: 1,
        created_at: clock.iso(fallback),
        updated_at: clock.iso(fallback),
      });
    });

    // Human review items.
    const declaredBy =
      (detail.activity ?? [])
        .map(([, s]) => /^(\w+) declared/.exec(s)?.[1])
        .find((c): c is string => !!c && KNOWN_CLIENTS.includes(c)) ??
      leadClient ??
      'owner';
    (item.hr ?? []).forEach((h, i) => {
      const verdict = lastVerdict.get(item.id)?.get(i);
      let lastDecision: Record<string, unknown> | null = null;
      if (h.last) {
        lastDecision = {
          kind: h.last.deferred ? 'defer' : h.last.approved ? 'approve' : 'changes',
          note: h.last.note ?? null,
          round: h.last.round,
          at: clock.at(h.at, fallback),
          result_ref: h.last.ref ?? null,
        };
      } else if (verdict) {
        lastDecision = {
          kind: verdict.v.k,
          note: verdict.v.note ?? null,
          round: verdict.round,
          at: clock.at(verdict.when, fallback),
          result_ref:
            verdict.v.ref ??
            (verdict.v.into === 'checklist'
              ? (stepIds[
                  (detail.work ?? []).findIndex((w) => w.from?.includes(`round ${verdict.round}`))
                ] ?? null)
              : null),
        };
      }
      add('hr_items', {
        id: hrId(item.id, i),
        item_id: item.id,
        position: i,
        text: h.t,
        state: h.state,
        added_by: item.fromReview ? 'owner' : declaredBy,
        last_decision: lastDecision,
        follow_up_item_id: h.last?.deferred ? (h.last.ref ?? null) : null,
        version: 1,
        created_at: clock.iso(fallback),
        updated_at: clock.iso(fallback),
      });
    });

    // Documents: generated bytes, every version up to the one listed.
    const docVersions = new Map<string, string>(); // "name vN" → document_version id
    const byName = new Map<string, [string, string, string, Shorthand][]>();
    for (const doc of detail.docs ?? []) {
      if (doc[0].startsWith('handoff packet')) continue; // packets, not documents
      byName.set(doc[0], [...(byName.get(doc[0]) ?? []), doc]);
    }
    const addDocument = (
      name: string,
      kind: string,
      versions: { n: number; by: string; at: number }[],
      caption?: string,
    ) => {
      const docId = seedId('doc', item.id, name);
      const createdAt = Math.min(...versions.map((v) => v.at));
      add('documents', {
        id: docId,
        project_key: item.proj,
        item_id: item.id,
        name,
        kind,
        created_at: clock.iso(createdAt),
        updated_at: clock.iso(Math.max(...versions.map((v) => v.at))),
      });
      for (const v of versions) {
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'txt';
        const bytes = Buffer.from(
          ext === 'md'
            ? `# ${name.replace(/\.md$/, '')}\n\nSample document for ${item.id} (${item.title}), version ${v.n}.\nGenerated by the Task Lite sample seed.\n`
            : `Placeholder for ${name}${caption ? ` (${caption})` : ''}, generated by the Task Lite sample seed.\n`,
        );
        const dvId = seedId('dv', item.id, name, v.n);
        const path = `${item.proj}/${docId}/v${v.n}/${name}`;
        files.push({ path, bytes });
        add('document_versions', {
          id: dvId,
          document_id: docId,
          version_no: v.n,
          mime: MIME[ext] ?? 'application/octet-stream',
          size: bytes.length,
          sha256: sha256(bytes),
          path,
          created_by: v.by,
          created_at: clock.iso(v.at),
          updated_at: clock.iso(v.at),
        });
        docVersions.set(`${name} v${v.n}`, dvId);
      }
    };
    for (const [name, listed] of byName) {
      const num = (v: string) => (/^v(\d+)$/.exec(v) ? Number(v.slice(1)) : 1);
      const max = Math.max(...listed.map((d) => num(d[1])));
      const newest = listed.find((d) => num(d[1]) === max)!;
      const newestAt = protoInstant(newest[3]) ?? fallback;
      const versions = Array.from({ length: max }, (_, k) => {
        const n = k + 1;
        const own = listed.find((d) => num(d[1]) === n);
        return {
          n,
          by: own?.[2] ?? newest[2],
          at: own ? (protoInstant(own[3]) ?? newestAt) : newestAt - (max - n) * HOUR,
        };
      });
      addDocument(name, name.endsWith('.md') ? 'planning' : 'other', versions);
    }

    // Packets, packet items, attachments and review decisions.
    for (const round of data.packets[item.id]?.rounds ?? []) {
      const packetId = seedId('pkt', item.id, round.n);
      const isLast = round.n === Math.max(...data.packets[item.id]!.rounds.map((r) => r.n));
      const state = round.decided
        ? 'decided'
        : isLast && item.status === 'review'
          ? 'open'
          : 'withdrawn';
      const createdAt = protoInstant(round.when) ?? fallback;
      // An open round without an item list holds the items that are `ready` (in the current packet).
      const roundItems =
        round.items ??
        (state === 'open'
          ? (item.hr ?? []).filter((h) => h.state === 'ready').map((h) => h.t)
          : []);
      const canonical = JSON.stringify({
        item: item.id,
        round: round.n,
        items: roundItems,
        how: round.how ?? [],
        checked: round.checked ?? [],
        gaps: round.gaps ?? [],
        commit: round.commit ?? null,
      });
      add('packets', {
        id: packetId,
        item_id: item.id,
        round: round.n,
        // The prototype's display hash ("pkt-7a1c") is kept as the first 4 characters.
        content_hash: round.sha.replace(/^pkt-/, '') + sha256(canonical).slice(4),
        built_from_commit: round.commit ?? null,
        estimate: round.est ?? null,
        how: round.how ?? [],
        checked: (round.checked ?? []).map(([text, provenance, evidence]) => ({
          text,
          provenance,
          evidence,
        })),
        gaps: round.gaps ?? [],
        created_by: round.by,
        state,
        version: 1,
        created_at: clock.iso(createdAt),
        updated_at: clock.at(round.decided?.when, createdAt),
      });
      roundItems.forEach((text, i) => {
        const index = (item.hr ?? []).findIndex((h) => h.t === text);
        add('packet_items', {
          id: seedId('pki', packetId, i),
          packet_id: packetId,
          hr_item_id: hrId(item.id, index >= 0 ? index : i),
          text_snapshot: text,
          created_at: clock.iso(createdAt),
          updated_at: clock.iso(createdAt),
        });
      });
      (round.attach ?? []).forEach(([name, caption], i) => {
        let dvId = docVersions.get(name);
        if (!dvId) {
          addDocument(name, 'packet_attachment', [{ n: 1, by: round.by, at: createdAt }], caption);
          dvId = docVersions.get(`${name} v1`)!;
        }
        add('packet_attachments', {
          id: seedId('pka', packetId, i),
          packet_id: packetId,
          document_version_id: dvId,
          caption,
          created_at: clock.iso(createdAt),
          updated_at: clock.iso(createdAt),
        });
      });
      round.decided?.verdicts.forEach((v, i) => {
        const decidedAt = clock.at(round.decided!.when, createdAt);
        const step = (detail.work ?? []).findIndex((w) => w.from?.includes(`round ${round.n}`));
        add('review_decisions', {
          id: seedId('rd', packetId, i),
          packet_id: packetId,
          hr_item_id: hrId(item.id, i),
          kind: v.k,
          note: v.note ?? null,
          into: v.into ?? null,
          follow: null,
          result_ref: v.ref ?? (v.into === 'checklist' && step >= 0 ? stepIds[step] : null),
          decided_at: decidedAt,
          created_at: decidedAt,
          updated_at: decidedAt,
        });
      });
    }

    // The open question.
    if (item.question) {
      const at = clock.at(item.question.at, fallback);
      add('questions', {
        id: seedId('q', item.id),
        item_id: item.id,
        run_id: leadRunId,
        text: item.question.text,
        asked_by: item.question.by,
        answer: null,
        answered_at: null,
        read_by_agent_at: null,
        created_at: at,
        updated_at: at,
      });
    }

    // Commits: packet build commits and the reported head.
    const commits = new Map<string, { at: number; message: string | null }>();
    for (const round of data.packets[item.id]?.rounds ?? []) {
      if (round.commit)
        commits.set(round.commit, { at: protoInstant(round.when) ?? fallback, message: null });
    }
    if (item.head && !commits.has(item.head)) {
      const note = item.headNote ?? '';
      commits.set(item.head, {
        at: protoInstant(/ at (\d{1,2}:\d{2})/.exec(note)?.[1]) ?? updated,
        message: /“(.+)”/.exec(note)?.[1] ?? null,
      });
    }
    for (const [sha, c] of commits) {
      add('commits', {
        id: seedId('cmt', item.id, sha),
        item_id: item.id,
        sha,
        branch: null,
        message: c.message,
        pr_url: null,
        reported_by: leadClient ?? 'agent',
        reported_at: clock.iso(c.at),
        created_at: clock.iso(c.at),
        updated_at: clock.iso(c.at),
      });
    }

    // Activity rows become events.
    for (const [time, summary] of detail.activity ?? []) {
      const first = summary.split(' ')[0]!.toLowerCase();
      const byClaimant = /by (\w+) · ([\w-]+)/.exec(summary);
      const actor: SeedActor =
        first === 'owner' || first === 'you'
          ? parseActor('owner')
          : KNOWN_CLIENTS.includes(first)
            ? { kind: 'agent', client: first, label: lead?.client === first ? lead.label : null }
            : byClaimant && KNOWN_CLIENTS.includes(byClaimant[1]!)
              ? { kind: 'agent', client: byClaimant[1]!, label: byClaimant[2]! }
              : /^ci build/i.test(summary)
                ? { kind: 'system', client: null, label: null }
                : (lead ?? { kind: 'system', client: null, label: null });
      const type = activityType(summary);
      event({
        at: protoInstant(time) ?? fallback,
        actor,
        project: item.proj,
        item: item.id,
        type,
        summary,
        data: type === 'claim.rejected' && detail.conflict ? { conflict: detail.conflict } : {},
      });
    }
  }

  // `changes[]`: Activity rows not already covered by an item's activity.
  for (const [time, itemId, summary] of data.changes) {
    const covered = (data.detail[itemId]?.activity ?? []).some(([t]) => t === time);
    if (covered) continue;
    const lead = byId.get(itemId) ? leadOf(byId.get(itemId)!) : null;
    event({
      at: protoInstant(time) ?? PROTOTYPE_CLOCK,
      actor: lead ?? { kind: 'system', client: null, label: null },
      project: itemProject(itemId),
      item: itemId,
      type: activityType(summary),
      summary,
      data: {},
    });
  }

  // ---- Decision records ----
  for (const d of DECISIONS) {
    add('decision_records', {
      id: d.id,
      project_key: d.project,
      scope_kind: d.scope_kind,
      scope_id: d.scope_id,
      title: d.title,
      decision_md: `${d.title}.`,
      rationale_md: null,
      authority: d.authority,
      author: d.author,
      status: 'active',
      supersedes_id: null,
      confirmed_at: null,
      version: 1,
      created_at: clock.iso(d.at),
      updated_at: clock.iso(d.at),
    });
    const onItem = d.scope_kind === 'epic' ? d.scope_id : null;
    event({
      at: d.at,
      actor: parseActor(d.author),
      project: d.project,
      item: onItem,
      type: 'decision.published',
      summary: `${d.author === 'owner' ? 'Owner' : d.author} published ${d.id}: ${d.title}`,
      data: { objects: [{ kind: 'decision', id: d.id }] },
    });
  }

  // ---- Write ----
  for (const f of files) {
    const full = join(opts.docsDir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.bytes);
  }

  events.sort((a, b) => a.at - b.at || a.order - b.order);
  const encode = (v: unknown) =>
    v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : v;

  sqlite
    .transaction(() => {
      if (!isDatabaseEmpty(db)) {
        throw new Error(
          'The database is not empty; the sample seed only loads into an empty database.',
        );
      }
      sqlite.pragma('defer_foreign_keys = ON');
      const statements = new Map<string, Database.Statement<unknown[]>>();
      for (const { table, row } of rows) {
        const keys = Object.keys(row);
        const sig = `${table}:${keys.join(',')}`;
        let stmt = statements.get(sig);
        if (!stmt) {
          stmt = sqlite.prepare(
            `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
          );
          statements.set(sig, stmt);
        }
        stmt.run(...keys.map((k) => encode(row[k])));
      }
      const insertEvent = sqlite.prepare(
        `INSERT INTO events (at, actor_kind, client, label, run_id, project_key, item_id, type, summary, data, inverse, mutation_id, idempotency_key)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      );
      events.forEach((e, n) => {
        const objects =
          (e.data.objects as unknown[] | undefined) ??
          (e.item ? [{ kind: 'item', id: e.item }] : []);
        insertEvent.run(
          clock.iso(e.at),
          e.actor.kind,
          e.actor.client,
          e.actor.label,
          e.project,
          e.item,
          e.type,
          e.summary,
          JSON.stringify({ ...e.data, seed: true, objects }),
          seedId('mut', 'seed', n),
        );
      });
    })
    .immediate();

  const summary: SeedSummary = {};
  for (const table of SEED_TABLES) {
    summary[table] = (
      sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }
    ).n;
  }
  return summary;
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y!, m! - 1, d!];
}

/** Used by the CLI and boot: a short, secret-free description of what was loaded. */
export function describeSeed(summary: SeedSummary): string {
  return Object.entries(summary)
    .map(([table, n]) => `${table} ${n}`)
    .join(', ');
}
