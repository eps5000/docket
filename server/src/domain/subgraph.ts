/**
 * The dependency subgraph and cycles on read (BUILD_SPEC §5.2; A11; FR-024): the `subgraph` service.
 *
 * `dependency_subgraph` (MCP_SPEC §5.2) walks `blocks` links from an item:
 * up (what blocks it), down (what it blocks) or both, to `depth` hops. Each
 * node carries its planned dates labelled `entered` or `none` (dates are
 * never inferred), and `blocked` from the one evaluator (`BlockIndex`).
 *
 * `at_risk` lists items whose `planned_start` is on or before an unresolved
 * blocker's `planned_end` (the same test as the Problems date risk), after
 * slipping the root by `delay_days` and pushing each slip downstream: an item
 * that must start later ends later by the same number of days.
 */
import { ToolError, type Status } from '@docket/shared';
import type { ServiceDeps, SubgraphService } from './contracts.js';
import { criticalPath } from './critical-path.js';
import { pickEpics } from './epic-picks.js';
import { compareIds, cyclesOf } from './links.js';
import { BlockIndex, endsOnOrAfter, requireItem, windowsOf } from './model.js';

const DAY = 86_400_000;
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const dayOf = (msValue: number) => new Date(msValue).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => dayOf(dayMs(date) + n * DAY);

interface NodeRow {
  id: string;
  title: string;
  status: Status;
  planned_start: string | null;
  planned_end: string | null;
  effort: number | null;
}

/** IDs within `depth` hops of `root` along `next`, in breadth-first order (root excluded). */
function walk(root: string, depth: number, next: (id: string) => string[]): string[] {
  const seen = new Set([root]);
  const out: string[] = [];
  let frontier = [root];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const level: string[] = [];
    for (const id of frontier) {
      for (const to of next(id).sort(compareIds)) {
        if (seen.has(to)) continue;
        seen.add(to);
        level.push(to);
      }
    }
    out.push(...level);
    frontier = level;
  }
  return out;
}

export function createSubgraphService(deps: ServiceDeps): SubgraphService {
  return {
    dependencySubgraph(r, input) {
      const root = requireItem(r.db, input.id);
      const depth = input.depth ?? 2;
      const direction = input.direction ?? 'both';
      const delay = input.delay_days ?? 0;
      if (depth < 1 || depth > 5) {
        throw new ToolError('validation', 'depth must be 1–5.', { details: { field: 'depth' } });
      }
      const index = new BlockIndex(r.db);
      const up = (id: string) => (index.blockers.get(id) ?? []).map((l) => l.from_id);
      const down = (id: string) => (index.dependents.get(id) ?? []).map((l) => l.to_id);
      const ids = [root.id];
      if (direction !== 'down') ids.push(...walk(root.id, depth, up));
      if (direction !== 'up')
        ids.push(...walk(root.id, depth, down).filter((id) => !ids.includes(id)));
      const inSet = new Set(ids);

      const rows = new Map(
        (
          r.db.sqlite
            .prepare(
              `SELECT id, title, status, planned_start, planned_end, effort FROM items
               WHERE id IN (SELECT value FROM json_each(?))`,
            )
            .all(JSON.stringify(ids)) as NodeRow[]
        ).map((n) => [n.id, n]),
      );
      const present = ids.filter((id) => rows.has(id));
      const nodes = present.map((id) => {
        const n = rows.get(id)!;
        return {
          id: n.id,
          title: n.title,
          status: n.status,
          blocked: index.state(n.id).blocked,
          planned_start: n.planned_start,
          planned_end: n.planned_end,
          date_source:
            n.planned_start !== null || n.planned_end !== null
              ? ('entered' as const)
              : ('none' as const),
          effort: n.effort,
        };
      });

      const links = present
        .flatMap((id) => index.dependents.get(id) ?? [])
        .filter((l) => inSet.has(l.to_id) && rows.has(l.to_id))
        .sort((a, b) => compareIds(a.from_id, b.from_id) || compareIds(a.to_id, b.to_id));
      const edges = links.map((l) => ({ from: l.from_id, to: l.to_id, type: 'blocks' as const }));

      const cycles = cyclesOf(index, present).filter((c) => c.some((id) => inSet.has(id)));

      // ---- at_risk: slip the root, push slips downstream in topological order ----
      const slip = new Map<string, number>([[root.id, delay]]);
      const end = (id: string) => {
        const e = rows.get(id)?.planned_end;
        return e ? addDays(e, slip.get(id) ?? 0) : null;
      };
      const indegree = new Map(present.map((id) => [id, 0]));
      for (const l of links) indegree.set(l.to_id, (indegree.get(l.to_id) ?? 0) + 1);
      const queue = present.filter((id) => indegree.get(id) === 0);
      const order: string[] = [];
      while (queue.length > 0) {
        const id = queue.shift()!;
        order.push(id);
        for (const l of links.filter((x) => x.from_id === id)) {
          indegree.set(l.to_id, indegree.get(l.to_id)! - 1);
          if (indegree.get(l.to_id) === 0) queue.push(l.to_id);
        }
      }
      // Cycle members never drain; check them last, without pushing slips further.
      for (const id of present) if (!order.includes(id)) order.push(id);

      const at_risk: { id: string; reason: string }[] = [];
      for (const id of order) {
        const start = rows.get(id)!.planned_start;
        if (!start) continue;
        let worst: { blocker: string; end: string } | null = null;
        for (const l of links.filter((x) => x.to_id === id)) {
          const slipped = (slip.get(l.from_id) ?? 0) > 0;
          // A cleared blocker is no risk, unless this call slips it.
          if (index.cleared(l) && !slipped) continue;
          const e = end(l.from_id);
          if (e === null || !endsOnOrAfter(e, start)) continue;
          if (!worst || e > worst.end) worst = { blocker: l.from_id, end: e };
        }
        if (!worst) continue;
        const shift = Math.round((dayMs(worst.end) - dayMs(start)) / DAY) + 1;
        if (id !== root.id) slip.set(id, Math.max(slip.get(id) ?? 0, shift));
        const by = slip.get(worst.blocker) ?? 0;
        const why = by > 0 ? ` after a ${by}-day slip` : '';
        at_risk.push({
          id,
          reason: `planned start ${start} is on or before ${worst.blocker}'s planned end ${worst.end}${why}`,
        });
      }

      return { nodes, edges, cycles, at_risk };
    },

    criticalPath: (r, input) =>
      criticalPath({ db: r.db, windows: windowsOf(deps.config), now: r.now }, input.id),

    pickEpic: (r, input) => pickEpics({ db: r.db, now: r.now }, input.key),

    cycles(r, input) {
      const index = new BlockIndex(r.db);
      const sql = r.db.sqlite;
      const ids = (
        input.project
          ? (sql
              .prepare(
                `SELECT DISTINCT i.id FROM items i JOIN links l ON l.type = 'blocks' AND (l.from_id = i.id OR l.to_id = i.id)
                 WHERE i.project_key = ?`,
              )
              .all(input.project) as { id: string }[])
          : (sql
              .prepare("SELECT DISTINCT from_id AS id FROM links WHERE type = 'blocks'")
              .all() as { id: string }[])
      ).map((x) => x.id);
      const found = cyclesOf(index, ids.sort(compareIds));
      return input.project
        ? found.filter((c) => c.some((id) => index.project(id) === input.project))
        : found;
    },
  };
}
