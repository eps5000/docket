/**
 * The item-reference write check (MCP_SPEC §3.4, B11 resolutions): item IDs
 * mentioned in text that don't exist are accepted, with a warning
 * `RCP-99 doesn't exist` (rendered as `! RCP-99 doesn't exist`).
 *
 * - Only `<KEY>-<n>` where `KEY` is an existing project counts, so `UTF-8`,
 *   `SHA-256` or `XYZ-9` with no XYZ project never warn.
 * - IDs inside inline code and fenced code blocks are skipped.
 * - Every text field is checked except identifier and locator fields.
 * - The write path runs it inside the write's transaction, after the change,
 *   so an item created by the same call counts as existing.
 */
import type { Db } from '../db/client.js';

/** Identifier and locator fields: never scanned (MCP_SPEC §3.4). */
export const REFERENCE_SKIP_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'from',
  'to',
  'epic',
  'blocked_by',
  'link_id',
  'run_id',
  'url',
  'branch',
  'sha',
  'path',
  'workspace',
  'locator',
  'external',
  'idempotency_key',
]);

/** At most this many warnings per write; the rest are summarised. */
const MAX_WARNINGS = 10;

const ID_RE = /\b([A-Z]{2,5})-(\d{1,9})\b/g;

/** `text` without fenced code blocks and inline code spans. */
export function stripCode(text: string): string {
  return (
    text
      // Fenced blocks: ``` or ~~~ to the matching fence (or the end).
      .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, ' ')
      // Inline spans: `x`, ``x``.
      .replace(/(`+)(?:(?!\1)[\s\S])+?\1/g, ' ')
  );
}

/** Item-shaped IDs in `text`, outside code, in order of first mention. */
export function mentionedIds(text: string): string[] {
  const out: string[] = [];
  for (const m of stripCode(text).matchAll(ID_RE)) {
    const id = `${m[1]}-${Number(m[2])}`;
    if (m[0] === id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Every string in `value` outside the skipped fields. */
function collectText(value: unknown, out: string[], key?: string): void {
  if (key !== undefined && REFERENCE_SKIP_FIELDS.has(key)) return;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectText(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectText(v, out, k);
  }
}

/** Warnings for the item IDs in `args` that don't exist. Reads only. */
export function referenceWarnings(db: Db, args: unknown): string[] {
  const texts: string[] = [];
  collectText(args, texts);
  const ids: string[] = [];
  for (const t of texts) for (const id of mentionedIds(t)) if (!ids.includes(id)) ids.push(id);
  if (ids.length === 0) return [];
  const projects = new Set(
    (
      db.sqlite.prepare('SELECT key FROM projects WHERE deleted_at IS NULL').all() as {
        key: string;
      }[]
    ).map((p) => p.key),
  );
  const candidates = ids.filter((id) => projects.has(id.split('-')[0]!));
  if (candidates.length === 0) return [];
  const existing = new Set(
    (
      db.sqlite
        .prepare('SELECT id FROM items WHERE id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(candidates)) as { id: string }[]
    ).map((r) => r.id),
  );
  const missing = candidates.filter((id) => !existing.has(id));
  const warnings = missing.slice(0, MAX_WARNINGS).map((id) => `${id} doesn't exist`);
  if (missing.length > MAX_WARNINGS) {
    warnings.push(`${missing.length - MAX_WARNINGS} more item IDs don't exist`);
  }
  return warnings;
}
