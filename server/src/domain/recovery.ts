/**
 * Recovery (BUILD_SPEC §5.16; MCP_SPEC §5.9): the `recovery` service:
 * workspace state, `Item.resume`, `recovery_report`, Agents → Workspaces and
 * the owner's *Mark released*, *Keep for later* and *Safe to discard*.
 *
 * US11 (T100). Everything here is derived from what agents reported
 * (recovery-model.ts), plus the radar's read-only git check of what ended
 * runs left behind (decision 41; worktree-check.ts). Docket never fetches,
 * and never changes a folder, a process or a remote (FR-117). The coordinator
 * acts on the restart list; the owner acts on the Problems rows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ToolError,
  type ItemResume,
  type Question,
  type RepoWorktreeRow,
  type WorkspaceRow,
  type WorkspaceState,
} from '@docket/shared';
import type { RecoveryService, ServiceDeps, ReadContext } from './contracts.js';
import {
  OPEN_STORED_SQL,
  currentSteps,
  displayRunState,
  getRun,
  isResumable,
  isRunOpen,
  isoPlus,
  requireItem,
  summarize,
  windowsOf,
  type ItemRow,
  type RunRow,
} from './model.js';
import {
  RecoveryReader,
  awaitsRestart,
  endedAt,
  orphans,
  pathKey,
  resourceView,
  storedWorkspace,
  type ResourceRow,
  type WorkspaceFacts,
} from './recovery-model.js';
import { leadingItems } from './problems.js';
import { treeKey } from './worktree-check.js';
import { hostFactsFor, mergeHostFacts } from './host-worktrees.js';
import { WorktreeScans, removeCommand, worktreeVerdict } from './worktree-cleanup.js';
import { atRiskOwner } from './worktree-owner.js';

/** `recovery_report` looks back this far by default (MCP_SPEC §5.9). */
export const REPORT_SINCE_MS = 7 * 24 * 60 * 60_000;

/** Agents → Workspaces and the report list worktrees in this order (UI_SPEC §6.6). */
export const WORKSPACE_ORDER: readonly WorkspaceState[] = [
  'at_risk',
  'in_use',
  'parked',
  'unknown',
  'safe_to_prune',
];

// ---- Cursors: opaque to agents ----

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ r: offset })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const r = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { r?: unknown }).r;
    if (typeof r === 'number' && Number.isInteger(r) && r >= 0) return r;
  } catch {
    // Falls through to the error.
  }
  throw new ToolError(
    'validation',
    'That cursor is not valid here. Pass next_cursor from the previous recovery_report, or leave it out.',
    { details: { fields: { cursor: 'not a recovery_report cursor' } } },
  );
}

/** Items in live projects, optionally one project's. */
function liveItems(r: ReadContext, project?: string): Map<string, ItemRow> {
  const rows = r.db.sqlite
    .prepare(
      `SELECT i.* FROM items i JOIN projects p ON p.key = i.project_key
       WHERE p.deleted_at IS NULL AND (? IS NULL OR i.project_key = ?)`,
    )
    .all(project ?? null, project ?? null) as ItemRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

/** Each item's latest lead run. */
function latestLeads(r: ReadContext): Map<string, RunRow> {
  const out = new Map<string, RunRow>();
  for (const run of r.db.sqlite
    .prepare('SELECT * FROM runs WHERE is_lead = 1 ORDER BY created_at, id')
    .all() as RunRow[]) {
    out.set(run.item_id, run);
  }
  return out;
}

/** Work steps done (or skipped, which needs no more work) of the current plan. */
function progress(r: ReadContext, itemId: string): { done: number; total: number } {
  const steps = currentSteps(r.db, itemId);
  return {
    done: steps.filter((s) => s.state === 'done' || s.state === 'skipped').length,
    total: steps.length,
  };
}

function openQuestion(r: ReadContext, itemId: string): Question | null {
  const q = r.db.sqlite
    .prepare(
      'SELECT id, text, created_at, answer, answered_at FROM questions WHERE item_id = ? AND answered_at IS NULL AND withdrawn_at IS NULL ORDER BY created_at DESC LIMIT 1',
    )
    .get(itemId) as
    | {
        id: string;
        text: string;
        created_at: string;
        answer: string | null;
        answered_at: string | null;
      }
    | undefined;
  return q
    ? {
        id: q.id,
        text: q.text,
        asked_at: q.created_at,
        answer: q.answer,
        answered_at: q.answered_at,
      }
    : null;
}

const byPriority = (items: Map<string, ItemRow>) => (a: RunRow, b: RunRow) => {
  const ia = items.get(a.item_id)!;
  const ib = items.get(b.item_id)!;
  return ia.priority - ib.priority || (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0);
};

export function createRecoveryService(deps: ServiceDeps): RecoveryService {
  const windows = () => windowsOf(deps.config);
  const reader = (r: ReadContext) => new RecoveryReader(r.db, windows(), r.now);
  const worktreeScans = new WorktreeScans(deps.config, () => deps.clock().toISOString(), deps.log);

  /** The brief's text, byte for byte as stored; null if its file is gone. */
  function briefText(r: ReadContext, versionId: string): string | null {
    const v = r.db.sqlite
      .prepare('SELECT path FROM document_versions WHERE id = ?')
      .get(versionId) as { path: string } | undefined;
    if (!v) return null;
    try {
      return readFileSync(join(deps.config.paths.docs, v.path), 'utf8');
    } catch {
      return null;
    }
  }

  /** Every recorded worktree's facts, in the workspace order, in scope. */
  function allWorkspaces(rr: RecoveryReader, items: Map<string, ItemRow>) {
    const out: WorkspaceFacts[] = [];
    for (const key of rr.allGroups().keys()) {
      const f = rr.factsOf(key)!;
      if (!items.has(f.latest.item_id)) continue;
      out.push(f);
    }
    return out.sort(
      (a, b) =>
        WORKSPACE_ORDER.indexOf(a.state) - WORKSPACE_ORDER.indexOf(b.state) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
  }

  const lastActivity = (f: WorkspaceFacts) =>
    [f.latest.last_signal_at, f.merged.updated_at ?? f.latest.updated_at].sort().pop()!;

  return {
    report(r, input) {
      const since = input.since ?? isoPlus(r.now, -REPORT_SINCE_MS);
      const items = liveItems(r, input.project);
      const rr = reader(r);
      const summaries = new Map<string, ReturnType<typeof summarize>[number]>();
      const summary = (id: string) => {
        if (!summaries.has(id)) {
          summaries.set(
            id,
            summarize({ db: r.db, windows: windows(), now: r.now, index: rr.blockIndex() }, [
              items.get(id)!,
            ])[0]!,
          );
        }
        return summaries.get(id)!;
      };

      // Interrupted: each item's latest lead run, ended without finishing, with nobody on it now.
      const leads = [...latestLeads(r).values()].filter((run) => items.has(run.item_id));
      const ended = endedAt(r.db, leads);
      const interrupted = leads
        .filter((run) => {
          const item = items.get(run.item_id)!;
          return (
            run.state === 'interrupted' &&
            run.end_reason !== 'canceled' &&
            item.status !== 'done' &&
            item.status !== 'canceled' &&
            (ended.get(run.id) ?? run.updated_at) >= since
          );
        })
        .sort(byPriority(items));

      // Stale: open lead runs with no signal for STALE_AFTER. Parked: every parked run.
      const open = (
        r.db.sqlite
          .prepare(`SELECT * FROM runs WHERE state IN ${OPEN_STORED_SQL}`)
          .all() as RunRow[]
      ).filter((run) => items.has(run.item_id));
      const stale = open
        .filter((run) => run.is_lead === 1 && displayRunState(run, windows(), r.now) === 'stale')
        .sort(byPriority(items));
      const parked = open
        .filter((run) => run.state === 'parked')
        .map((run) => ({ run, info: rr.parkOf(run) }))
        .sort(
          (a, b) =>
            Number(b.info.resume_ready) - Number(a.info.resume_ready) ||
            (a.run.parked_at ?? '').localeCompare(b.run.parked_at ?? ''),
        );

      // Worktrees: anything not safe always; the rest when active since `since`.
      const workspaces = allWorkspaces(rr, items).filter(
        (f) => (f.state !== 'safe_to_prune' && f.state !== 'unknown') || lastActivity(f) >= since,
      );
      const left = orphans(r.db, r.now, deps.config.orphanAfterMs).filter((o) =>
        items.has(o.run.item_id),
      );

      // One page across the sections, in order (MCP_SPEC §3 Pagination).
      type Entry =
        | { kind: 'interrupted'; run: RunRow }
        | { kind: 'stale'; run: RunRow }
        | { kind: 'parked'; run: RunRow; resume_ready: boolean }
        | { kind: 'workspace'; facts: WorkspaceFacts }
        | { kind: 'orphan'; resource: ResourceRow; run: RunRow; ended_at: string };
      const all: Entry[] = [
        ...interrupted.map((run) => ({ kind: 'interrupted' as const, run })),
        ...stale.map((run) => ({ kind: 'stale' as const, run })),
        ...parked.map((p) => ({
          kind: 'parked' as const,
          run: p.run,
          resume_ready: p.info.resume_ready,
        })),
        ...workspaces.map((facts) => ({ kind: 'workspace' as const, facts })),
        ...left.map((o) => ({
          kind: 'orphan' as const,
          resource: o.resource,
          run: o.run,
          ended_at: o.ended_at,
        })),
      ];
      const offset = input.cursor ? decodeCursor(input.cursor) : 0;
      const limit = input.limit;
      const page = all.slice(offset, offset + limit);

      const out: ReturnType<RecoveryService['report']> = {
        interrupted: [],
        stale: [],
        parked: [],
        workspaces: [],
        orphaned_resources: [],
        next_cursor: offset + limit < all.length ? encodeCursor(offset + limit) : null,
      };
      for (const e of page) {
        switch (e.kind) {
          case 'interrupted': {
            const entry: (typeof out.interrupted)[number] = {
              item: summary(e.run.item_id),
              run: rr.runView(e.run, { external: true }),
              end_reason: e.run.end_reason ?? 'service_restart',
              checklist: progress(r, e.run.item_id),
              open_question: openQuestion(r, e.run.item_id),
            };
            if (input.include_briefs && e.run.brief_document_version_id) {
              const text = briefText(r, e.run.brief_document_version_id);
              if (text !== null) entry.brief = text;
            }
            out.interrupted.push(entry);
            break;
          }
          case 'stale':
            out.stale.push({
              item: summary(e.run.item_id),
              run: rr.runView(e.run, { external: true }),
            });
            break;
          case 'parked':
            out.parked.push({
              item: summary(e.run.item_id),
              run: rr.runView(e.run, { external: true }),
              resume_ready: e.resume_ready,
            });
            break;
          case 'workspace': {
            const f = e.facts;
            out.workspaces.push({
              path: f.path,
              branch: f.merged.branch ?? null,
              item_id: f.latest.item_id,
              run_id: f.latest.id,
              state: f.state,
              head_sha: f.merged.head_sha ?? null,
              pushed_sha: f.merged.pushed_sha ?? null,
              dirty: f.merged.dirty ?? null,
              unreleased_resources: f.unreleased.length,
            });
            break;
          }
          case 'orphan':
            out.orphaned_resources.push({
              resource: resourceView(e.resource),
              item_id: e.run.item_id,
              run_id: e.run.id,
              run_ended_at: e.ended_at,
            });
            break;
        }
      }
      return out;
    },

    workspaceStates(r, input) {
      const rr = reader(r);
      return Object.fromEntries(
        input.paths.map((p) => [p, rr.factsOf(pathKey(p))?.state ?? ('unknown' as const)]),
      );
    },

    itemResume(r, input): ItemResume | null {
      const item = requireItem(r.db, input.item_id);
      const lead = r.db.sqlite
        .prepare(
          'SELECT * FROM runs WHERE item_id = ? AND is_lead = 1 ORDER BY created_at DESC, id DESC LIMIT 1',
        )
        .get(item.id) as RunRow | undefined;
      const resumable = isResumable(r.db, item.id);
      if (!resumable && lead?.state !== 'interrupted') return null;
      const pushedCommit = r.db.sqlite
        .prepare(
          'SELECT sha FROM commits WHERE item_id = ? AND pushed = 1 ORDER BY reported_at DESC, id DESC LIMIT 1',
        )
        .get(item.id) as { sha: string } | undefined;
      const unreleased = (
        r.db.sqlite
          .prepare(
            'SELECT count(*) AS n FROM run_resources rr JOIN runs r ON r.id = rr.run_id WHERE r.item_id = ? AND rr.released_at IS NULL',
          )
          .get(item.id) as { n: number }
      ).n;
      const workspace = lead ? reader(r).workspaceOf(lead) : null;
      return {
        workspace,
        last_pushed_sha: workspace?.pushed_sha ?? pushedCommit?.sha ?? null,
        brief_document_version_id: lead?.brief_document_version_id ?? null,
        last_end_reason: lead?.end_reason ?? null,
        unreleased_resources: unreleased,
      };
    },

    workspaces(r, input) {
      const items = liveItems(r, input.scope === 'all' ? undefined : input.scope);
      const rr = reader(r);
      const facts = allWorkspaces(rr, items).filter((f) => !input.state || f.state === input.state);
      // B56: who each at-risk worktree waits on, from the one Problems routing.
      const risky = facts.filter((f) => f.state === 'at_risk');
      const view =
        risky.length > 0 ? deps.services().views.needsYou(r, { scope: input.scope }) : null;
      const leading = leadingItems(r.db, [...new Set(risky.map((f) => f.latest.item_id))], r.now);
      const rows: WorkspaceRow[] = facts.map((f) => {
        const item = items.get(f.latest.item_id)!;
        return {
          path: f.path,
          state: f.state,
          at_risk_owner:
            view && f.state === 'at_risk'
              ? atRiskOwner(f, view, leading, (id) => items.get(id)?.status)
              : null,
          branch: f.merged.branch ?? null,
          host: f.merged.host ?? null,
          repo: f.merged.repo ?? null,
          item_id: item.id,
          item_title: item.title,
          project: item.project_key,
          run_id: f.latest.id,
          run_state: displayRunState(f.latest, windows(), r.now),
          client: f.latest.client,
          label: f.latest.label,
          head_sha: f.merged.head_sha ?? null,
          pushed_sha: f.merged.pushed_sha ?? null,
          unpushed_commits: f.unpushed_commits,
          dirty: f.merged.dirty ?? null,
          unreleased_resources: f.unreleased.length,
          last_activity_at: lastActivity(f),
        };
      });
      return { rows };
    },

    worktreeCleanup(r, input) {
      const project = r.db.sqlite
        .prepare(
          'SELECT key, repo_path, main_branch FROM projects WHERE key = ? AND deleted_at IS NULL',
        )
        .get(input.project) as
        { key: string; repo_path: string | null; main_branch: string } | undefined;
      if (!project) throw new ToolError('not_found', `No project ${input.project}.`);
      const base = { project: project.key, main_branch: project.main_branch };
      if (!project.repo_path) {
        return {
          ...base,
          repo: 'not_set',
          checked_at: null,
          scanning: null,
          host: { state: 'none', checked_at: null },
          rows: [],
        };
      }
      const { scan, running } = worktreeScans.read(
        project.key,
        { path: project.repo_path, main: project.main_branch },
        input.refresh === '1',
      );
      // B68: the host helper's facts where they're fresh, over the container's own read.
      const merged = mergeHostFacts(
        scan,
        hostFactsFor(r.db, { ...project, repo_path: project.repo_path }),
        r.now,
      );
      if (!merged || merged.trees.length === 0) {
        return {
          ...base,
          repo: scan && scan.status !== 'ok' ? 'unreadable' : 'ok',
          checked_at: scan?.checked_at ?? null,
          scanning: running,
          host: merged?.host ?? { state: 'none', checked_at: null },
          rows: [],
        };
      }

      const rr = reader(r);
      const items = liveItems(r);
      // Agents and git can spell one folder differently.
      const groupKeys = new Map<string, string>();
      for (const key of rr.allGroups().keys()) {
        if (!key.startsWith('run:')) groupKeys.set(treeKey(key), key);
      }
      const judged = merged.trees.map(({ tree, checkedAt, source }) => {
        const key = groupKeys.get(treeKey(tree.path));
        const facts = key ? rr.factsOf(key) : null;
        const { verdict, why } = worktreeVerdict({
          tree,
          facts,
          awaitsRestart: !!facts && awaitsRestart(r.db, facts.runs),
          checkedAt,
          now: r.now,
        });
        return { tree, facts, verdict, why, source };
      });

      // B56: the owner of each worktree Docket has at risk, from the one Problems routing.
      const risky = judged.filter((j) => j.facts?.state === 'at_risk');
      const view =
        risky.length > 0 ? deps.services().views.needsYou(r, { scope: project.key }) : null;
      const leading = leadingItems(
        r.db,
        [...new Set(risky.map((j) => j.facts!.latest.item_id))],
        r.now,
      );

      const rows: RepoWorktreeRow[] = judged.map(({ tree, facts, verdict, why, source }) => {
        const item = facts ? items.get(facts.latest.item_id) : undefined;
        const seen = facts ? lastActivity(facts) : null;
        const git = tree.last_git_at;
        return {
          path: tree.path,
          branch: tree.branch,
          last_activity_at: !seen ? git : !git ? seen : seen > git ? seen : git,
          tracked: facts !== null,
          item_id: item?.id ?? null,
          item_title: item?.title ?? null,
          uncommitted_files: tree.uncommitted_files,
          unpushed_commits: tree.unpushed_commits,
          merged: tree.merged,
          verdict,
          why,
          owner:
            view && facts?.state === 'at_risk'
              ? atRiskOwner(facts, view, leading, (id) => items.get(id)?.status)
              : null,
          command: verdict === 'safe_to_remove' ? removeCommand(merged.main_path, tree.path) : null,
          source,
        };
      });
      return {
        ...base,
        repo: 'ok',
        checked_at: merged.checked_at,
        scanning: running,
        host: merged.host,
        rows,
      };
    },

    worktreeScanSettled: (project) => worktreeScans.settled(project),
    stopWorktreeScans: () => worktreeScans.stop(),

    ownerReleaseResource(w, input) {
      const row = w.get('run_resources', input.id) as unknown as ResourceRow | undefined;
      if (!row) {
        throw new ToolError('not_found', `No resource ${input.id}. It may have been removed.`);
      }
      if (row.released_at) {
        throw new ToolError(
          'conflict',
          `${row.label} was already marked released. Showing the latest.`,
          { current: resourceView(row) },
        );
      }
      const run = getRun(w.db, row.run_id)!;
      const item = requireItem(w.db, run.item_id);
      const inverse = w.update('run_resources', row.id, {
        released_at: w.now,
        released_by: 'owner',
        release_note: input.note ?? null,
      });
      w.event({
        type: 'resource.released',
        summary: `Owner marked “${row.label}” released${input.note ? `: ${input.note}` : ''}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          run_id: run.id,
          resources: [{ id: row.id, label: row.label, run_id: run.id }],
          released_by: 'owner',
        },
        inverse: [inverse],
        objects: [{ kind: 'run', id: run.id }],
      });
      return resourceView(w.get('run_resources', row.id) as unknown as ResourceRow);
    },

    markUnpushedHandled(w, input) {
      const run = getRun(w.db, input.runId);
      if (!run) throw new ToolError('not_found', `No run ${input.runId}.`);
      if (isRunOpen(run.state)) {
        throw new ToolError(
          'validation',
          `Run ${run.id} is still going; its work isn't lost. Mark it handled once the run has ended.`,
        );
      }
      const outcome = input.outcome ?? 'discard';
      if (run.unpushed_handled_at && (run.unpushed_outcome ?? 'discard') === outcome) {
        return { run_id: run.id, unpushed_handled_at: run.unpushed_handled_at, outcome };
      }
      const item = requireItem(w.db, run.item_id);
      const ws = storedWorkspace(run);
      const inverse = w.update('runs', run.id, {
        unpushed_handled_at: w.now,
        unpushed_outcome: outcome,
      });
      const where = ws?.path ? ` (${ws.path})` : '';
      w.event({
        type: 'run.unpushed_handled',
        // Decision 41: it records a choice. Nothing was committed, pushed, saved or deleted.
        summary:
          outcome === 'keep'
            ? `Owner chose to keep the work left on ${item.id} for later${where}`
            : `Owner marked the work left on ${item.id} safe to discard${where}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { run_id: run.id, workspace: ws, outcome },
        inverse: [inverse],
        objects: [{ kind: 'run', id: run.id }],
      });
      return { run_id: run.id, unpushed_handled_at: w.now, outcome };
    },
  };
}
