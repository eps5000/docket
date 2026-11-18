/**
 * The one write path (constitution Principle II; BUILD_SPEC §2, §5.11).
 *
 * Every mutation, from MCP or the UI API, runs through `WritePath.run`:
 * 1. secret check on every text field of the arguments (MCP_SPEC §3.4):
 *    a rejected write is not stored and not logged; after the change, the
 *    item-reference check (references.ts) adds warnings for IDs that don't
 *    exist;
 * 2. one BEGIN IMMEDIATE transaction holding the idempotency lookup, the
 *    change itself (with version checks), the event append and the
 *    idempotency record; a mutation that changes no row (an explicit
 *    no-op) records no event, and one that changes a row must record one;
 * 3. after commit, subscribers (the live stream) hear about the new events.
 *
 * Domain services receive a `WriteContext`. Its row helpers return the
 * inverse operation of each change, which the service stores on the event
 * so owner undo can reverse it (§5.11).
 */
import { createHash } from 'node:crypto';
import {
  EVENT_TYPES,
  ToolError,
  assertNoSecrets,
  type ActorKind,
  type EventType,
  type ObjectKind,
} from '@docket/shared';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { is } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { newId } from './ids.js';
import { referenceWarnings } from './references.js';

// ---- Actors and events ----

export interface Actor {
  kind: ActorKind;
  /** Normalised client name for agents (`claude`, `codex`, …); null for the owner and system. */
  client: string | null;
  label: string | null;
  session_id?: string | null;
  run_id?: string | null;
}

export const OWNER_ACTOR: Actor = Object.freeze({ kind: 'owner', client: null, label: null });
export const SYSTEM_ACTOR: Actor = Object.freeze({ kind: 'system', client: null, label: null });

export interface ObjectRef {
  kind: ObjectKind;
  id: string;
}

/** A row operation that reverses part of a mutation. */
export type InverseOp =
  | { op: 'update'; table: string; id: string; set: Record<string, unknown> }
  | { op: 'delete'; table: string; id: string }
  | { op: 'insert'; table: string; row: Record<string, unknown> };

export interface EventInput {
  type: EventType;
  /** The one line shown in Activity. */
  summary: string;
  item_id?: string | null;
  project_key?: string | null;
  /** Old and new values that matter. Stored, never sent to agents. */
  data?: Record<string, unknown>;
  /** How to reverse this event; omit or null when it can't be undone. */
  inverse?: InverseOp[] | null;
  /** Objects touched besides `item_id` (which is added automatically). */
  objects?: ObjectRef[];
}

export type Row = Record<string, unknown>;

// ---- Table metadata (row helpers only touch known tables and columns) ----

interface TableMeta {
  pk: string;
  columns: Set<string>;
  versioned: boolean;
  timestamped: boolean;
}

const MANAGED = new Set(['version', 'created_at', 'updated_at']);

const TABLES: ReadonlyMap<string, TableMeta> = new Map(
  Object.values(schema as Record<string, unknown>)
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .map((table) => {
      const config = getTableConfig(table);
      const columns = new Set(config.columns.map((c) => c.name));
      const pk = config.columns.find((c) => c.primary)?.name ?? 'id';
      return [
        config.name,
        { pk, columns, versioned: columns.has('version'), timestamped: columns.has('updated_at') },
      ] as const;
    })
    // Events are appended only through `WriteContext.event`.
    .filter(([name]) => name !== 'events'),
);

function tableMeta(table: string): TableMeta {
  const meta = TABLES.get(table);
  if (!meta) throw new Error(`Unknown table for the write path: ${table}`);
  return meta;
}

function checkColumns(table: string, meta: TableMeta, keys: string[]): void {
  for (const key of keys) {
    if (!meta.columns.has(key)) throw new Error(`Unknown column ${table}.${key}`);
  }
}

/** Encode a JS value for a SQLite parameter. */
function encode(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

const NOUNS: Record<string, string> = {
  items: 'item',
  projects: 'project',
  hr_items: 'human review item',
  work_steps: 'work step',
  agent_checks: 'check',
  runs: 'run',
  questions: 'question',
  links: 'link',
  labels: 'label',
  documents: 'document',
  document_versions: 'document version',
  packets: 'packet',
  decision_records: 'decision record',
  owner_notes: 'note',
};

export function notFound(table: string, id: string): ToolError {
  const noun = NOUNS[table] ?? table.replace(/_/g, ' ').replace(/s$/, '');
  const hint = table === 'items' ? ' Check the ID with search_items.' : '';
  return new ToolError('not_found', `No ${noun} ${id}.${hint}`);
}

// ---- Canonical JSON (idempotency hashes) ----

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// ---- The context a mutation runs in ----

export interface WriteContext {
  readonly actor: Actor;
  /** The mutation's timestamp (ISO-8601 UTC). */
  readonly now: string;
  readonly mutationId: string;
  /** The caller's idempotency key, applied by the write path that built this context; null without one. */
  readonly idempotencyKey: string | null;
  readonly db: Db;
  get(table: string, id: string): Row | undefined;
  /** The row, or `not_found`. */
  require(table: string, id: string): Row;
  /** The row, or `not_found`; `conflict` with `current` when `expected` is given and stale. */
  checkVersion(table: string, id: string, expected?: number): Row;
  /** Update columns, bump `version` and `updated_at`; returns the inverse. */
  update(table: string, id: string, set: Row): InverseOp;
  /** Insert a row (timestamps filled in); returns the inverse. */
  insert(table: string, row: Row): InverseOp;
  /** Delete a row; returns the inverse. */
  remove(table: string, id: string): InverseOp;
  /** Restore a row exactly as it was (used by undo). */
  restore(table: string, row: Row): void;
  /** Append an event in this transaction; returns its seq. */
  event(input: EventInput): number;
}

class Context implements WriteContext {
  readonly seqs: number[] = [];

  constructor(
    readonly db: Db,
    readonly actor: Actor,
    readonly now: string,
    readonly mutationId: string,
    readonly idempotencyKey: string | null,
  ) {}

  get(table: string, id: string): Row | undefined {
    const meta = tableMeta(table);
    return this.db.sqlite.prepare(`SELECT * FROM "${table}" WHERE "${meta.pk}" = ?`).get(id) as
      Row | undefined;
  }

  require(table: string, id: string): Row {
    const row = this.get(table, id);
    if (!row) throw notFound(table, id);
    return row;
  }

  checkVersion(table: string, id: string, expected?: number): Row {
    const row = this.require(table, id);
    if (expected !== undefined && row.version !== expected) {
      throw new ToolError(
        'conflict',
        `${id} changed since you read it (now v${String(row.version)}, you sent v${expected}). Read the current state and retry only if your change still makes sense.`,
        { current: row },
      );
    }
    return row;
  }

  update(table: string, id: string, set: Row): InverseOp {
    const meta = tableMeta(table);
    const keys = Object.keys(set).filter((k) => set[k] !== undefined);
    checkColumns(table, meta, keys);
    if (keys.some((k) => k === meta.pk || MANAGED.has(k))) {
      throw new Error(`${table}: the key, version and timestamps are managed by the write path`);
    }
    const before = this.require(table, id);
    const assignments = keys.map((k) => `"${k}" = ?`);
    if (meta.versioned) assignments.push(`"version" = "version" + 1`);
    if (meta.timestamped) assignments.push(`"updated_at" = ?`);
    if (assignments.length > 0) {
      const params = keys.map((k) => encode(set[k]));
      if (meta.timestamped) params.push(this.now);
      this.db.sqlite
        .prepare(`UPDATE "${table}" SET ${assignments.join(', ')} WHERE "${meta.pk}" = ?`)
        .run(...params, id);
    }
    return { op: 'update', table, id, set: Object.fromEntries(keys.map((k) => [k, before[k]])) };
  }

  insert(table: string, row: Row): InverseOp {
    const meta = tableMeta(table);
    const full: Row = { ...row };
    if (meta.columns.has('created_at') && full.created_at === undefined) full.created_at = this.now;
    if (meta.timestamped && full.updated_at === undefined) full.updated_at = this.now;
    const id = full[meta.pk];
    if (typeof id !== 'string' || !id) throw new Error(`${table}: insert needs ${meta.pk}`);
    this.insertRow(table, meta, full);
    return { op: 'delete', table, id };
  }

  remove(table: string, id: string): InverseOp {
    const meta = tableMeta(table);
    const before = this.require(table, id);
    this.db.sqlite.prepare(`DELETE FROM "${table}" WHERE "${meta.pk}" = ?`).run(id);
    return { op: 'insert', table, row: before };
  }

  restore(table: string, row: Row): void {
    this.insertRow(table, tableMeta(table), row);
  }

  private insertRow(table: string, meta: TableMeta, row: Row): void {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    checkColumns(table, meta, keys);
    this.db.sqlite
      .prepare(
        `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      )
      .run(...keys.map((k) => encode(row[k])));
  }

  event(input: EventInput): number {
    if (!(EVENT_TYPES as readonly string[]).includes(input.type)) {
      throw new Error(`Unknown event type: ${input.type}`);
    }
    const objects: ObjectRef[] = [];
    const add = (ref: ObjectRef) => {
      if (!objects.some((o) => o.kind === ref.kind && o.id === ref.id)) objects.push(ref);
    };
    if (input.item_id) add({ kind: 'item', id: input.item_id });
    for (const ref of input.objects ?? []) add(ref);
    const data = { ...(input.data ?? {}), objects };
    const inverse = input.inverse && input.inverse.length > 0 ? input.inverse : null;
    const row = this.db.sqlite
      .prepare(
        `INSERT INTO events (at, actor_kind, client, label, run_id, project_key, item_id, type, summary, data, inverse, mutation_id, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      )
      .get(
        this.now,
        this.actor.kind,
        this.actor.client,
        this.actor.label,
        this.actor.run_id ?? null,
        input.project_key ?? null,
        input.item_id ?? null,
        input.type,
        input.summary,
        JSON.stringify(data),
        inverse ? JSON.stringify(inverse) : null,
        this.mutationId,
        this.idempotencyKey,
      ) as { seq: number };
    this.seqs.push(row.seq);
    return row.seq;
  }
}

// ---- The write path ----

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX = 100;
export const BUSY_RETRY_AFTER_S = 2;

export interface WriteOptions {
  actor: Actor;
  /** The tool or route name; part of the idempotency hash. */
  operation: string;
  /** The caller's arguments: secret-checked, and hashed for idempotency. */
  args: unknown;
  idempotencyKey?: string | null;
}

export interface WriteResult<T> {
  result: T;
  mutation_id: string;
  replayed: boolean;
  /** Write-check warnings (MCP_SPEC §3.4), e.g. "RCP-99 doesn't exist". */
  warnings: string[];
}

export interface WritePathOptions {
  db: Db;
  clock?: () => Date;
  /** The service's own secrets (agent token, owner key), rejected by value. */
  knownSecrets?: () => readonly string[];
  /** Called after commit with the new events' seq numbers. */
  onCommit?: (seqs: number[]) => void;
}

/** The idempotency scope of an actor: its client, or `owner` / `system`. */
function clientScope(actor: Actor): string {
  if (actor.kind === 'agent') return actor.client ?? 'agent';
  return actor.kind;
}

/** Map low-level SQLite failures to the shared error codes. */
export function mapDbError(err: unknown): unknown {
  if (err instanceof ToolError) return err;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return err;
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
    return new ToolError(
      'unavailable',
      'Docket is busy; retry in a few seconds with the same idempotency_key.',
      { details: { retry_after_s: BUSY_RETRY_AFTER_S } },
    );
  }
  if (code === 'SQLITE_FULL') {
    return new ToolError('unavailable', 'The data volume is full; free some space, then retry.', {
      details: { retry_after_s: 60 },
    });
  }
  if (code === 'SQLITE_CONSTRAINT_CHECK') {
    const name = /CHECK constraint failed: (\w+)/.exec(String((err as Error).message))?.[1];
    return new ToolError(
      'validation',
      `A value is outside its allowed limits${name ? ` (${name})` : ''}. Shorten or correct it and retry.`,
      name ? { details: { constraint: name } } : {},
    );
  }
  return err;
}

/**
 * The commit listener of each database's main write path (the runtime's, which
 * feeds the SSE bus). A write path built later without its own `onCommit`, as
 * services do for writes after a commit (for example a Jira import's
 * attachments), uses it, so open screens still hear about those writes (B18).
 */
const commitListeners = new WeakMap<Db, (seqs: number[]) => void>();

export class WritePath {
  readonly db: Db;
  private readonly clock: () => Date;
  private readonly knownSecrets: () => readonly string[];
  private readonly onCommit?: (seqs: number[]) => void;

  constructor(opts: WritePathOptions) {
    this.db = opts.db;
    this.clock = opts.clock ?? (() => new Date());
    this.knownSecrets = opts.knownSecrets ?? (() => []);
    if (opts.onCommit) commitListeners.set(opts.db, opts.onCommit);
    this.onCommit = opts.onCommit;
  }

  now(): Date {
    return this.clock();
  }

  /** Rows changed on this connection so far (SQLite `total_changes()`). */
  private totalChanges(): number {
    return (this.db.sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  }

  run<T>(opts: WriteOptions, fn: (ctx: WriteContext) => T): WriteResult<T> {
    const key = opts.idempotencyKey ?? null;
    if (key !== null && (key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX)) {
      throw new ToolError(
        'validation',
        `idempotency_key must be 1–${IDEMPOTENCY_KEY_MAX} characters.`,
        { details: { field: 'idempotency_key' } },
      );
    }
    // Before anything touches the database: a rejected write leaves no trace.
    assertNoSecrets(opts.args, { known: this.knownSecrets() });

    const now = this.clock();
    const nowIso = now.toISOString();
    const client = clientScope(opts.actor);
    const requestHash = key
      ? sha256(canonicalJson({ operation: opts.operation, args: opts.args }))
      : '';

    let outcome: {
      response: { result: T; mutation_id: string; warnings?: string[] };
      seqs: number[];
      replayed: boolean;
    };
    try {
      outcome = this.db.sqlite
        .transaction(() => {
          if (key) {
            this.db.sqlite.prepare('DELETE FROM idempotency WHERE expires_at <= ?').run(nowIso);
            const stored = this.db.sqlite
              .prepare(
                'SELECT request_hash, response FROM idempotency WHERE client = ? AND key = ?',
              )
              .get(client, key) as { request_hash: string; response: string } | undefined;
            if (stored) {
              if (stored.request_hash !== requestHash) {
                throw new ToolError(
                  'validation',
                  'This idempotency_key was already used with different arguments; use a new key for a new operation.',
                  { details: { field: 'idempotency_key' } },
                );
              }
              return {
                response: JSON.parse(stored.response) as {
                  result: T;
                  mutation_id: string;
                  warnings?: string[];
                },
                seqs: [],
                replayed: true,
              };
            }
          }

          const ctx = new Context(this.db, opts.actor, nowIso, newId('mut', now.getTime()), key);
          const changesBefore = this.totalChanges();
          const result = fn(ctx);
          // A mutation that changed nothing (an explicit no-op, such as reporting a commit
          // already recorded) has nothing to record. Anything that changed a row needs an event.
          if (ctx.seqs.length === 0 && this.totalChanges() !== changesBefore) {
            throw new ToolError(
              'internal',
              `Mutation "${opts.operation}" recorded no event; every mutation must append one.`,
            );
          }
          // Item IDs in the text that don't exist: accepted, with a warning (§3.4). After
          // the change, so an item this call created counts as existing.
          const warnings = referenceWarnings(this.db, opts.args);
          const response = {
            result,
            mutation_id: ctx.mutationId,
            ...(warnings.length > 0 ? { warnings } : {}),
          };
          if (key) {
            this.db.sqlite
              .prepare(
                `INSERT INTO idempotency (id, key, client, request_hash, response, expires_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                newId('idem', now.getTime()),
                key,
                client,
                requestHash,
                JSON.stringify(response),
                new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
                nowIso,
                nowIso,
              );
          }
          return { response, seqs: ctx.seqs, replayed: false };
        })
        .immediate();
    } catch (err) {
      throw mapDbError(err);
    }

    if (outcome.seqs.length > 0) (this.onCommit ?? commitListeners.get(this.db))?.(outcome.seqs);
    const { warnings, ...rest } = outcome.response;
    return { ...rest, warnings: warnings ?? [], replayed: outcome.replayed };
  }
}
