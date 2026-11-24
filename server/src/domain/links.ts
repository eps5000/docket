/**
 * Links, blocked state and cycle rejection (BUILD_SPEC §5.2): the `links` service.
 *
 * - `link` creates a link, or updates `satisfied_when` on an existing one
 *   (MCP_SPEC §5.3); `updated` is true whenever the link already existed,
 *   and an existing link whose rule doesn't change records no event. A `blocks` link that would close a cycle is refused with
 *   the path; `verified` needs the blocker to have human review items.
 *   Omitting `satisfied_when` on an existing link leaves its rule alone
 *   (§3.3, silence preserves); on a new link it means the project default.
 * - `unlink` removes a link and says which items it unblocked.
 * - `blockState` is the one blocker evaluator (model.ts `BlockIndex`, after
 *   data-model.md "Blocker cleared?"): search filters, Work, the map, the
 *   Dependencies tab, Problems and `resume_ready` all read it.
 *
 * A rule change re-evaluates blocked state at once (it is derived, never
 * stored) and records what changed on the event (`reblocked`, `unblocked`).
 *
 * The graph helpers here (`cyclePath`, `cyclesOf`, `cycleText`) are shared
 * by the subgraph service and the owner's views.
 */
import { ToolError, type SatisfiedWhen } from '@docket/shared';
import type { LinksService, ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import { assertCallerRun, BlockIndex, callerName, ms, requireItem } from './model.js';
import { checkReleaseLink } from './release.js';
import type { WriteContext } from './write.js';

// ---- Graph helpers ----

/** `RCP-9` before `RCP-10`; projects alphabetically. */
export function compareIds(a: string, b: string): number {
  const [pa, na] = a.split('-');
  const [pb, nb] = b.split('-');
  return pa === pb ? Number(na) - Number(nb) : pa! < pb! ? -1 : 1;
}

type Next = (id: string) => readonly string[];

const blocksNext =
  (index: BlockIndex): Next =>
  (id) =>
    (index.dependents.get(id) ?? []).map((l) => l.to_id);

/**
 * A shortest `blocks` path from `start` to `goal` (both included), or null.
 * Breadth-first, so the cycle reported is the shortest one.
 */
export function findPath(
  next: Next,
  start: string,
  goal: string,
  within?: Set<string>,
): string[] | null {
  const prev = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const to of next(id)) {
      if (within && !within.has(to)) continue;
      if (to === goal) {
        const path = [goal];
        for (let at: string | null = id; at !== null; at = prev.get(at) ?? null) path.push(at);
        return path.reverse();
      }
      if (!prev.has(to)) {
        prev.set(to, id);
        queue.push(to);
      }
    }
  }
  return null;
}

/**
 * The cycle `from blocks to` would close: a path `to → … → from → to`, or
 * null when the link is safe (DFS over existing `blocks` links, A04).
 */
export function cycleFor(index: BlockIndex, from: string, to: string): string[] | null {
  if (from === to) return [from, from];
  const path = findPath(blocksNext(index), to, from);
  return path ? [...path, to] : null;
}

/** Strongly connected components of the `blocks` graph larger than one node (Tarjan), each sorted by ID. */
export function cyclesOf(index: BlockIndex, nodes: Iterable<string>): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  const next = blocksNext(index);
  // Iterative, so a long imported chain can't overflow the call stack.
  for (const root of nodes) {
    if (order.has(root)) continue;
    const work: { id: string; edges: readonly string[]; i: number }[] = [];
    const visit = (id: string) => {
      order.set(id, counter);
      low.set(id, counter);
      counter++;
      stack.push(id);
      onStack.add(id);
      work.push({ id, edges: next(id), i: 0 });
    };
    visit(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.edges.length) {
        const to = frame.edges[frame.i++]!;
        if (!order.has(to)) visit(to);
        else if (onStack.has(to)) low.set(frame.id, Math.min(low.get(frame.id)!, order.get(to)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === order.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const x = stack.pop()!;
          onStack.delete(x);
          component.push(x);
          if (x === frame.id) break;
        }
        if (component.length > 1) out.push(component.sort(compareIds));
      }
    }
  }
  return out;
}

/**
 * A real path around a component, starting and ending at its first ID:
 * `A → B → C → A`. A component with more than one loop shows the shortest.
 */
export function cyclePath(index: BlockIndex, component: readonly string[]): string[] {
  const start = component[0]!;
  const within = new Set(component);
  const path = findPath(blocksNext(index), start, start, within);
  return path ?? [...component, start];
}

/** `A ⇄ B`, or `A → B → C → A`, plus "(+n more)" when the component has more loops. */
export function cycleText(index: BlockIndex, component: readonly string[]): string {
  if (component.length === 2) return component.join(' ⇄ ');
  const path = cyclePath(index, component);
  const extra = component.length - (path.length - 1);
  return `${path.join(' → ')}${extra > 0 ? ` (+${extra} more in the cycle)` : ''}`;
}

/** Which of `ids` changed blocked state between two evaluations. */
export function blockDiff(
  before: BlockIndex,
  after: BlockIndex,
  ids: Iterable<string>,
): { reblocked: string[]; unblocked: string[] } {
  const reblocked: string[] = [];
  const unblocked: string[] = [];
  for (const id of new Set(ids)) {
    const was = before.state(id).blocked;
    const now = after.state(id).blocked;
    if (!was && now) reblocked.push(id);
    if (was && !now) unblocked.push(id);
  }
  return { reblocked: reblocked.sort(compareIds), unblocked: unblocked.sort(compareIds) };
}

/** "RCP-16 blocked again", "RCP-16, RCP-17 unblocked". */
export function changeLine(diff: { reblocked: string[]; unblocked: string[] }): string {
  const parts: string[] = [];
  if (diff.reblocked.length > 0) parts.push(`${diff.reblocked.join(', ')} blocked again`);
  if (diff.unblocked.length > 0) parts.push(`${diff.unblocked.join(', ')} unblocked`);
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

// ---- The service ----

interface LinkDbRow {
  id: string;
  from_id: string;
  to_id: string;
  type: 'blocks' | 'relates';
  satisfied_when: SatisfiedWhen | null;
  version: number;
}

function findLink(
  w: WriteContext,
  from: string,
  to: string,
  type: 'blocks' | 'relates',
): LinkDbRow | undefined {
  const sql = w.db.sqlite;
  const row = sql
    .prepare('SELECT * FROM links WHERE from_id = ? AND to_id = ? AND type = ?')
    .get(from, to, type) as LinkDbRow | undefined;
  if (row || type === 'blocks') return row;
  // `relates` is symmetric.
  return sql
    .prepare("SELECT * FROM links WHERE from_id = ? AND to_id = ? AND type = 'relates'")
    .get(to, from) as LinkDbRow | undefined;
}

const linkName = (l: Pick<LinkDbRow, 'from_id' | 'to_id' | 'type'>) =>
  `${l.from_id} ${l.type} ${l.to_id}`;

function hasHumanReview(w: WriteContext, id: string): boolean {
  return (
    w.db.sqlite.prepare('SELECT 1 FROM hr_items WHERE item_id = ? LIMIT 1').get(id) !== undefined
  );
}

export function createLinksService(_deps: ServiceDeps): LinksService {
  return {
    link(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      const from = requireItem(w.db, input.from);
      const to = requireItem(w.db, input.to);
      if (from.id === to.id) {
        throw new ToolError(
          'validation',
          `An item can't be linked to itself (${from.id}). Pick two different items.`,
          {
            details: { field: 'to' },
          },
        );
      }
      if (input.type === 'relates' && input.satisfied_when !== undefined) {
        throw new ToolError(
          'validation',
          'satisfied_when applies to blocks links only; omit it for relates.',
          { details: { field: 'satisfied_when' } },
        );
      }
      if (input.satisfied_when === 'verified' && !hasHumanReview(w, from.id)) {
        throw new ToolError('validation', `Declare human review on ${from.id}, or use done.`, {
          details: { field: 'satisfied_when' },
        });
      }
      // Decision 67: a Release and the tickets in its own epic are never linked by hand.
      if (input.type === 'blocks') checkReleaseLink(w.db, from.id, to.id);
      const who = callerName(w.db, w.actor);
      const existing = findLink(w, from.id, to.id, input.type);

      if (existing) {
        const rule = input.satisfied_when;
        if (existing.type === 'relates' || rule === undefined || rule === existing.satisfied_when) {
          // Nothing to change: silence preserves (§3.3).
          const index = new BlockIndex(w.db);
          return {
            link_id: existing.id,
            from: existing.from_id,
            to: existing.to_id,
            type: existing.type,
            satisfied_when: existing.type === 'blocks' ? index.rule(existing) : null,
            updated: true,
          };
        }
        const before = new BlockIndex(w.db);
        const inverse = w.update('links', existing.id, { satisfied_when: rule });
        const after = new BlockIndex(w.db);
        const diff = blockDiff(before, after, [to.id]);
        w.event({
          type: 'link.updated',
          summary: `${linkName(existing)} now clears when ${rule}${changeLine(diff)}`,
          item_id: to.id,
          project_key: to.project_key,
          data: {
            link_id: existing.id,
            from: from.id,
            to: to.id,
            old: { satisfied_when: existing.satisfied_when },
            new: { satisfied_when: rule },
            ...diff,
          },
          inverse: [inverse],
          objects: [
            { kind: 'item', id: from.id },
            { kind: 'link', id: existing.id },
          ],
        });
        return {
          link_id: existing.id,
          from: from.id,
          to: to.id,
          type: 'blocks',
          satisfied_when: rule,
          updated: true,
        };
      }

      const before = new BlockIndex(w.db);
      if (input.type === 'blocks') {
        const cycle = cycleFor(before, from.id, to.id);
        if (cycle) {
          throw new ToolError(
            'validation',
            `Linking ${from.id} blocks ${to.id} would create a cycle: ${cycle.join(' → ')}. Remove a link in the path first, or link them the other way.`,
            { details: { cycle } },
          );
        }
      }
      const linkId = newId('lnk', ms(w.now));
      const inverse = w.insert('links', {
        id: linkId,
        from_id: from.id,
        to_id: to.id,
        type: input.type,
        satisfied_when: input.type === 'blocks' ? (input.satisfied_when ?? null) : null,
        created_by: who,
      });
      const after = new BlockIndex(w.db);
      const diff = blockDiff(before, after, [to.id]);
      const rule =
        input.type === 'blocks'
          ? after.rule({
              id: linkId,
              from_id: from.id,
              to_id: to.id,
              type: 'blocks',
              satisfied_when: input.satisfied_when ?? null,
            })
          : null;
      w.event({
        type: 'link.added',
        summary: `${from.id} ${input.type} ${to.id}${input.satisfied_when ? ` · clears when ${input.satisfied_when}` : ''}`,
        item_id: to.id,
        project_key: to.project_key,
        data: {
          link_id: linkId,
          from: from.id,
          to: to.id,
          type: input.type,
          satisfied_when: input.satisfied_when ?? null,
          ...diff,
        },
        inverse: [inverse],
        objects: [
          { kind: 'item', id: from.id },
          { kind: 'link', id: linkId },
        ],
      });
      return {
        link_id: linkId,
        from: from.id,
        to: to.id,
        type: input.type,
        satisfied_when: rule,
        updated: false,
      };
    },

    unlink(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      let row: LinkDbRow | undefined;
      if (input.link_id !== undefined) {
        row = w.get('links', input.link_id) as LinkDbRow | undefined;
        if (!row) {
          throw new ToolError(
            'not_found',
            `No link ${input.link_id}. Read the item's links with get_item.`,
          );
        }
      } else {
        row = findLink(w, input.from!, input.to!, input.type!);
        if (!row) {
          throw new ToolError(
            'not_found',
            `No ${input.type} link from ${input.from} to ${input.to}. Read the item's links with get_item.`,
          );
        }
      }
      const to = requireItem(w.db, row.to_id);
      const before = new BlockIndex(w.db);
      const inverse = w.remove('links', row.id);
      const after = new BlockIndex(w.db);
      const diff = blockDiff(before, after, [row.to_id]);
      w.event({
        type: 'link.removed',
        summary: `Removed: ${linkName(row)}${diff.unblocked.length > 0 ? ` · ${diff.unblocked.join(', ')} unblocked` : ''}`,
        item_id: row.to_id,
        project_key: to.project_key,
        data: {
          link_id: row.id,
          from: row.from_id,
          to: row.to_id,
          type: row.type,
          satisfied_when: row.satisfied_when,
          ...diff,
        },
        inverse: [inverse],
        objects: [
          { kind: 'item', id: row.from_id },
          { kind: 'link', id: row.id },
        ],
      });
      return { removed: true, unblocked: diff.unblocked };
    },

    blockState(r, input) {
      const index = new BlockIndex(r.db);
      return Object.fromEntries(input.ids.map((id) => [id, index.state(id)]));
    },
  };
}
