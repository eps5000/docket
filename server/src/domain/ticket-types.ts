/**
 * Ticket types by kind of work (owner decision 67; BUILD_SPEC §5.47): what the
 * server reads from `items.type_info` and `items.rollout`. The rules for
 * changing a type live in items.ts (`typeChange`); the Release's in release.ts.
 */
import type { ItemSummary } from '@docket/shared';
import type { Db } from '../db/client.js';
import type { ItemRow } from './model.js';

/** What `items.type_info` holds (decision 67). */
export interface TypeInfo {
  inferred?: true;
  original?: string;
  generated?: true;
}

export function typeInfoOf(raw: unknown): TypeInfo | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? (value as TypeInfo) : null;
}

/** The summary's decision 67 fields: inferred, the original type, and the rollout marker. */
export function typeFields(
  row: Pick<ItemRow, 'type_info' | 'rollout'>,
): Pick<ItemSummary, 'type_inferred' | 'type_original' | 'rollout'> {
  const info = typeInfoOf(row.type_info ?? null);
  return {
    ...(info?.inferred ? { type_inferred: true as const } : {}),
    ...(info?.original ? { type_original: info.original } : {}),
    ...(row.rollout ? { rollout: true as const } : {}),
  };
}

/** SQL: an item whose type is still inferred. */
export const INFERRED_SQL = `json_extract(type_info, '$.inferred') = 1`;

/**
 * How many open tickets (not Done, canceled or archived) still have an
 * inferred type: in one project, or everywhere.
 */
export function inferredTypeCount(db: Db, project?: string): number {
  const row = db.sqlite
    .prepare(
      `SELECT count(*) AS n FROM items i JOIN projects p ON p.key = i.project_key
       WHERE p.deleted_at IS NULL AND i.archived_at IS NULL
         AND i.status NOT IN ('done', 'canceled') AND ${INFERRED_SQL.replace('type_info', 'i.type_info')}
         ${project ? 'AND i.project_key = ?' : ''}`,
    )
    .get(...(project ? [project] : [])) as { n: number };
  return row.n;
}
