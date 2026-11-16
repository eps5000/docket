/**
 * Notes, artifacts and commits (BUILD_SPEC §5.6; A08): the `evidence` service.
 *
 * US1 (T074). None of this is approval (FR-018): a note is an activity row,
 * an artifact is a link to external evidence, a commit is agent-reported.
 *
 * - `report_commit` with a SHA already recorded for the item is a no-op
 *   (it may still mark the commit pushed). It stores `pushed` and the
 *   reporting run, and moves that run's workspace (US11, T099; BUILD_SPEC
 *   §5.16): a new commit becomes `head_sha`, and `pushed: true` sets
 *   `pushed_sha`. Without a `run_id` it moves the item's active lead.
 * - Packet staleness belongs to `packets.markStale` (US3, T09x). It is
 *   called when the item, or its epic, has an open packet; until US3
 *   implements it, no packet is reported stale.
 */
import { isNotImplemented, type EvidenceService, type ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import {
  EVENT_COLUMNS,
  EVENT_FROM,
  activeLead,
  assertCallerRun,
  callerName,
  eventRow,
  ms,
  requireItem,
  type RunRow,
  type StoredEvent,
} from './model.js';
import { storedWorkspace, type StoredWorkspace } from './recovery-model.js';
import type { WriteContext } from './write.js';

/**
 * Move the reporting run's workspace (BUILD_SPEC §5.16): `head_sha` from the
 * latest reported commit, `pushed_sha` once it is on the remote.
 */
function moveWorkspace(
  w: WriteContext,
  run: RunRow | undefined,
  patch: Pick<StoredWorkspace, 'head_sha' | 'pushed_sha'>,
): void {
  if (!run) return;
  const ws: StoredWorkspace = { ...(storedWorkspace(run) ?? {}), ...patch, updated_at: w.now };
  w.update('runs', run.id, { workspace: ws });
}

export function createEvidenceService(deps: ServiceDeps): EvidenceService {
  return {
    addNote(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      const seq = w.event({
        type: 'note.added',
        summary: input.text,
        item_id: item.id,
        project_key: item.project_key,
        data: { text: input.text },
      });
      const row = w.db.sqlite
        .prepare(`SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM} WHERE e.seq = ?`)
        .get(seq) as StoredEvent;
      return eventRow(row);
    },

    linkArtifact(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      w.insert('artifacts', {
        id: newId('art', ms(w.now)),
        item_id: item.id,
        kind: input.kind,
        label: input.label,
        url: input.url ?? null,
        state: input.state ?? null,
        provenance: 'agent',
      });
      w.event({
        type: 'artifact.linked',
        summary: `${callerName(w.db, w.actor)} linked ${input.kind} ${input.label}${input.state ? ` (${input.state})` : ''}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          kind: input.kind,
          label: input.label,
          url: input.url ?? null,
          state: input.state ?? null,
        },
      });
      return {
        kind: input.kind,
        label: input.label,
        url: input.url ?? null,
        state: input.state ?? null,
      };
    },

    reportCommit(w, input) {
      const run = assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      const sha = input.sha.toLowerCase();
      const pushed = input.pushed ?? false;
      const existing = w.db.sqlite
        .prepare('SELECT id, pushed FROM commits WHERE item_id = ? AND lower(sha) = ?')
        .get(item.id, sha) as { id: string; pushed: number } | undefined;
      const who = callerName(w.db, w.actor);
      // The run whose workspace this commit moves: the caller's, else the item's lead.
      const target = run && run.item_id === item.id ? run : activeLead(w.db, item.id);
      if (existing) {
        // The same SHA again is a no-op, except that it may now be on the remote.
        if (pushed && !existing.pushed) {
          w.update('commits', existing.id, { pushed: true });
          moveWorkspace(w, target, { pushed_sha: sha });
          w.event({
            type: 'commit.reported',
            summary: `${who} reported commit ${sha.slice(0, 7)} pushed`,
            item_id: item.id,
            project_key: item.project_key,
            data: { sha, pushed: true },
          });
        }
        return { recorded: true as const, stale_packets: [] };
      }
      w.insert('commits', {
        id: newId('cmt', ms(w.now)),
        item_id: item.id,
        run_id: run && run.item_id === item.id ? run.id : null,
        sha,
        branch: input.branch ?? null,
        message: input.message ?? null,
        pr_url: input.pr_url ?? null,
        pushed,
        reported_by: who,
        reported_at: w.now,
      });
      moveWorkspace(w, target, pushed ? { head_sha: sha, pushed_sha: sha } : { head_sha: sha });
      w.event({
        type: 'commit.reported',
        summary: `${who} reported commit ${sha.slice(0, 7)}${input.message ? ` “${input.message}”` : ''}${pushed ? ' (pushed)' : ''}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { sha, branch: input.branch ?? null, pushed, pr_url: input.pr_url ?? null },
      });
      const openPacket = w.db.sqlite
        .prepare("SELECT 1 FROM packets WHERE state = 'open' AND item_id IN (?, ?) LIMIT 1")
        .get(item.id, item.epic_id ?? '');
      let stale: { item_id: string; packet_id: string; round: number }[] = [];
      if (openPacket) {
        try {
          stale = deps.services().packets.markStale(w, { item_id: item.id, sha });
        } catch (err) {
          // US3 implements staleness; until then nothing is marked.
          if (!isNotImplemented(err)) throw err;
        }
      }
      return { recorded: true as const, stale_packets: stale };
    },
  };
}
