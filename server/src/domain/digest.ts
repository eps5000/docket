/**
 * `get_digest` (owner decision 40; MCP_SPEC §5.2): one compact coordinator
 * snapshot, read from the services that already answer each question, so its
 * rules can't drift from theirs: what's ready and blocked (`search`), run
 * states and `resume_ready` (`views`, `recovery`), what waits on the owner and
 * which problems agents can act on (`views.needsYou`).
 *
 * Each section keeps its full `total` and at most `DIGEST_CAPS` rows. With a
 * `cursor`, every section keeps only the items events have touched since it,
 * and `changed` lists those events. Read-only.
 */
import {
  DIGEST_CAPS,
  LIMITS,
  ToolError,
  type Digest,
  type ItemSummary,
  type NeedsYouResponse,
  type ToolInput,
  type WaitingOn,
} from '@docket/shared';
import type { ReadContext, ServiceDeps } from './contracts.js';

export interface DigestService {
  get(r: ReadContext, input: ToolInput<'get_digest'>): Digest;
}

/** Run states a coordinator acts on; finished runs aren't in the digest. */
const ACTIVE_RUN_STATES = new Set(['live', 'reported', 'needs_input', 'stale', 'parked']);
/** Stale and parked first: those are the runs that need a decision. */
const RUN_ORDER: Record<string, number> = {
  stale: 0,
  parked: 1,
  needs_input: 2,
  live: 3,
  reported: 4,
};

const section = <T>(rows: readonly T[], cap: number) => ({
  total: rows.length,
  rows: rows.slice(0, cap),
});

/** Every page of a filter: the digest sorts and caps the whole list. */
function allOf(
  deps: ServiceDeps,
  r: ReadContext,
  project: string,
  filter: 'ready_to_start' | 'blocked',
): ItemSummary[] {
  const out: ItemSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = deps.services().search.searchItems(r, {
      project,
      filter,
      include_archived: false,
      limit: LIMITS.page_max,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...(page.items as ItemSummary[]));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

/** What a parked run waits on: "GF-4, coordinator". */
function waitingText(on: WaitingOn): string | null {
  const parts = [
    ...(on.items ?? []),
    on.orchestrator ? 'coordinator' : null,
    on.person ? 'a person' : null,
    on.until ? `until ${on.until}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** What waits on the owner, as one list: packets and questions first. */
function ownerRows(view: NeedsYouResponse): Digest['owner']['rows'] {
  const rows: Digest['owner']['rows'] = view.for_you_now.map((x) =>
    x.kind === 'packet'
      ? { kind: 'packet', item_id: x.item_id, text: x.stale ? `stale · ${x.title}` : x.title }
      : { kind: 'question', item_id: x.item_id, text: x.text },
  );
  for (const x of view.design_reviews ?? []) {
    rows.push({ kind: 'design_review', item_id: x.item.id, text: x.item.title });
  }
  for (const x of view.overlaps ?? []) {
    rows.push({
      kind: 'overlap',
      item_id: x.items[0].id,
      text: `with ${x.items[1].id} on ${x.parts.join(', ')}`,
    });
  }
  for (const x of view.undeclared_holds ?? []) {
    rows.push({ kind: 'undeclared_parts', item_id: x.item.id, text: x.item.title });
  }
  for (const x of view.resolutions ?? []) {
    rows.push({ kind: 'resolution', item_id: x.item_id, text: x.kind });
  }
  for (const x of view.project_decisions ?? []) {
    rows.push({ kind: 'decision', item_id: null, text: x.title });
  }
  for (const x of view.onboarding_reviews ?? []) {
    rows.push({ kind: 'onboarding', item_id: null, text: x.id });
  }
  return rows;
}

/** Problems an agent can act on: the agents' own, and any whose fix isn't the owner's. */
function problemRows(view: NeedsYouResponse): Digest['problems']['rows'] {
  const open = [...(view.agent_problems ?? []), ...view.problems];
  const seen = new Set<string>();
  const out: Digest['problems']['rows'] = [];
  for (const p of open) {
    if (p.explanation?.who !== 'agent') continue;
    const id = p.id ?? `${p.kind}:${p.item_id ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind: p.kind,
      item_id: p.item_id,
      fix: p.explanation.fix ?? p.reason,
    });
  }
  return out;
}

export function createDigestService(deps: ServiceDeps): DigestService {
  return {
    get(r, input) {
      const sql = r.db.sqlite;
      const exists = sql
        .prepare('SELECT 1 FROM projects WHERE key = ? AND deleted_at IS NULL')
        .get(input.project);
      if (!exists) {
        throw new ToolError(
          'not_found',
          `No project ${input.project}. Call list_projects for the keys.`,
        );
      }
      if (input.cursor !== undefined && !/^\d+$/.test(input.cursor)) {
        throw new ToolError(
          'validation',
          'That cursor is not valid. Pass cursor from get_digest or next_cursor from get_changes.',
          { details: { fields: { cursor: 'not a change cursor' } } },
        );
      }
      const latest = (
        sql.prepare('SELECT coalesce(max(seq), 0) AS m FROM events').get() as { m: number }
      ).m;

      // With a cursor: the events since it, and the items they touched.
      const since = input.cursor === undefined ? null : Math.min(Number(input.cursor), latest);
      const events =
        since === null
          ? []
          : (sql
              .prepare(
                'SELECT seq, type, item_id FROM events WHERE project_key = ? AND seq > ? ORDER BY seq DESC',
              )
              .all(input.project, since) as {
              seq: number;
              type: string;
              item_id: string | null;
            }[]);
      const touched = new Set(events.flatMap((e) => (e.item_id ? [e.item_id] : [])));
      const keep = (id: string | null) => since === null || (id !== null && touched.has(id));

      const ready = allOf(deps, r, input.project, 'ready_to_start').filter((x) => keep(x.id));
      const blocked = allOf(deps, r, input.project, 'blocked')
        .filter((x) => keep(x.id))
        .sort(
          (a, b) => a.priority - b.priority || b.unblocks - a.unblocks || a.id.localeCompare(b.id),
        );

      const agents = deps.services().views.agents(r, { scope: input.project });
      const runs = agents.rows
        .filter(
          (x) =>
            x.row_kind === 'run' &&
            x.run_id !== null &&
            x.run_state !== null &&
            ACTIVE_RUN_STATES.has(x.run_state) &&
            keep(x.item_id),
        )
        .map((x) => ({
          item_id: x.item_id,
          run_id: x.run_id!,
          state: x.run_state!,
          label: x.label,
          resume_ready: x.lead_parked?.resume_ready ?? false,
          waiting: x.lead_parked ? waitingText(x.lead_parked.waiting_on) : null,
        }))
        .sort(
          (a, b) =>
            Number(b.resume_ready) - Number(a.resume_ready) ||
            (RUN_ORDER[a.state] ?? 9) - (RUN_ORDER[b.state] ?? 9) ||
            a.item_id.localeCompare(b.item_id),
        );

      const view = deps.services().views.needsYou(r, { scope: input.project });
      const owner = ownerRows(view).filter((x) => since === null || keep(x.item_id));
      const problems = problemRows(view).filter((x) => since === null || keep(x.item_id));

      const leases = (
        sql
          .prepare(
            `SELECT part_key AS part, item_id, expires_at AS until FROM part_leases
             WHERE project_key = ? AND ended_at IS NULL AND expires_at > ?
             ORDER BY expires_at, part_key`,
          )
          .all(input.project, r.now) as Digest['leases']['rows']
      ).filter((x) => keep(x.item_id));

      const overlaps = (
        sql
          .prepare(
            `SELECT item_a, item_b, parts, state, outcome FROM part_overlaps
             WHERE project_key = ? AND state IN ('open', 'sequenced')
             ORDER BY raised_at DESC, id DESC`,
          )
          .all(input.project) as {
          item_a: string;
          item_b: string;
          parts: string;
          state: string;
          outcome: string | null;
        }[]
      )
        .filter((x) => since === null || touched.has(x.item_a) || touched.has(x.item_b))
        .map((x) => ({
          items: [x.item_a, x.item_b],
          parts: JSON.parse(x.parts) as string[],
          outcome: x.outcome ?? (x.state === 'sequenced' ? 'sequence' : 'owner'),
        }));
      const radar = (view.radar_findings ?? [])
        .map((x) => ({
          items: [x.item_a?.id ?? x.branch_a, x.item_b?.id ?? x.branch_b],
          parts: x.files,
          outcome: 'radar',
        }))
        .filter((x) => since === null || x.items.some((i) => touched.has(i)));

      return {
        project: input.project,
        cursor: String(latest),
        since: since === null ? null : String(since),
        ready: section(
          ready.map((x) => ({
            id: x.id,
            title: x.title,
            priority: x.priority,
            unblocks: x.unblocks,
          })),
          DIGEST_CAPS.ready,
        ),
        runs: section(runs, DIGEST_CAPS.runs),
        blocked: section(
          blocked.map((x) => ({
            id: x.id,
            title: x.title,
            priority: x.priority,
            unblocks: x.unblocks,
            blocked_by: x.blocked_by,
          })),
          DIGEST_CAPS.blocked,
        ),
        owner: section(owner, DIGEST_CAPS.owner),
        problems: section(problems, DIGEST_CAPS.problems),
        leases: section(leases, DIGEST_CAPS.leases),
        conflicts: section([...overlaps, ...radar], DIGEST_CAPS.conflicts),
        changed: section(
          events.map((e) => ({ cursor: String(e.seq), item_id: e.item_id, type: e.type })),
          DIGEST_CAPS.changed,
        ),
      };
    },
  };
}
