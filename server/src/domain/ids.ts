/**
 * IDs (BUILD_SPEC §4, MCP_SPEC §3 IDs; decision T4).
 * - Items are `<KEY>-<n>`, numbered per project through `projects.next_seq`
 *   inside the creating transaction.
 * - Everything else is a prefix plus a ULID. The agent-visible prefixes are
 *   fixed by MCP_SPEC §3; the rest name internal rows.
 */
import type Database from 'better-sqlite3';
import { ToolError } from '@tasklite/shared';
import { monotonicFactory } from 'ulid';

export const ID_PREFIXES = {
  // Agent-visible (MCP_SPEC §3).
  work_step: 'wst',
  check: 'chk',
  human_review: 'hr',
  run: 'run',
  question: 'q',
  link: 'lnk',
  document: 'doc',
  document_version: 'dv',
  packet: 'pkt',
  decision: 'dec',
  /** A run's declared resource (MCP_SPEC §4 Resource; BUILD_SPEC §4 `run_resources`). */
  resource: 'rsc',
  // Internal.
  mutation: 'mut',
  project: 'prj',
  acceptance: 'ac',
  label: 'lbl',
  item_label: 'il',
  plan_version: 'pv',
  subagent_log: 'sub',
  owner_note: 'note',
  commit: 'cmt',
  artifact: 'art',
  review_decision: 'rd',
  packet_item: 'pki',
  packet_attachment: 'pka',
  idempotency: 'idem',
  /** A Jira import session (memory only; US9). */
  jira_import: 'imp',
  /** Reference for an `internal` error, quoted in its message (MCP_SPEC §6). */
  error_ref: 'e',
} as const;
export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const ulid = monotonicFactory();

/** A new `<prefix>_<ULID>`; `time` (ms) sets the ULID's timestamp part. */
export function newId(prefix: IdPrefix, time?: number): string {
  return `${prefix}_${ulid(time)}`;
}

const ITEM_ID = /^([A-Z]{2,5})-([1-9][0-9]*)$/;

export function isItemId(value: string): boolean {
  return ITEM_ID.test(value);
}

export function parseItemId(value: string): { project: string; n: number } | null {
  const m = ITEM_ID.exec(value);
  return m ? { project: m[1]!, n: Number(m[2]) } : null;
}

/**
 * Allocate the next `<KEY>-<n>` for a project. Must run inside the write
 * transaction that creates the item, so a rollback also returns the number.
 */
export function allocateItemId(sqlite: Database.Database, projectKey: string): string {
  if (!sqlite.inTransaction) {
    throw new Error('allocateItemId must run inside the creating transaction');
  }
  const row = sqlite
    .prepare(
      `UPDATE projects SET next_seq = next_seq + 1
       WHERE key = ? AND deleted_at IS NULL
       RETURNING next_seq - 1 AS n`,
    )
    .get(projectKey) as { n: number } | undefined;
  if (!row) {
    throw new ToolError('not_found', `No project ${projectKey}. Check the key with list_projects.`);
  }
  return `${projectKey}-${row.n}`;
}
