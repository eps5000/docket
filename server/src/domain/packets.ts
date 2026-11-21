/**
 * Packets, rounds, staleness and deferred reviews (BUILD_SPEC §5.6): the `packets` service.
 *
 * US3 (T092).
 * - `submit_packet` is refused when a packet is already open, the item is
 *   not In progress, it is blocked, nothing is declared (close it with
 *   set_status instead), or an agent check is `fail` and no gap mentions it
 *   (by the check's id or its text). It snapshots every declared item (or
 *   the given subset) into a new round, sets them `ready`, stores the
 *   commit (recording it with report_commit if it isn't yet), how,
 *   checked, gaps and attachments, moves the item to Review, and hashes the
 *   canonical JSON (`pkt-` + the first 4 hex characters).
 * - Staleness is derived on read (views.openPackets): an open packet is out
 *   of date once a commit with another SHA is reported after it, on the
 *   item or, for an epic-level packet, on any child. `markStale` reports
 *   which open packets a new commit made stale and records `packet.stale`
 *   the first time.
 * - *Ask for a fresh packet* withdraws the packet, puts its `ready` items
 *   back to `declared`, returns the item to In progress, and leaves the
 *   agent an owner note. It is undoable.
 */
import { createHash } from 'node:crypto';
import { ToolError, type ReviewResponse } from '@docket/shared';
import type { Db } from '../db/client.js';
import type { PacketsService, ServiceDeps } from './contracts.js';
import { hrRows } from './human-review.js';
import { newId } from './ids.js';
import {
  BlockIndex,
  assertCallerRun,
  callerName,
  checkRows,
  ms,
  requireItem,
  summaryOf,
  windowsOf,
  type ItemRow,
} from './model.js';
import { deferredOf, openPackets, scoped } from './views.js';
import { declaredKeys, endLeasesOf, raiseHold, settleUndeclared } from './shared-changes.js';
import { canonicalJson, type InverseOp } from './write.js';
import { addReportedBranch } from './radar.js';

export interface PacketRow {
  id: string;
  item_id: string;
  round: number;
  content_hash: string;
  built_from_commit: string | null;
  estimate: string | null;
  how: string | null;
  checked: string | null;
  gaps: string | null;
  created_by: string;
  state: 'open' | 'decided' | 'withdrawn';
  /** Decision 36: JSON arrays as reported or held; null when absent. */
  changed_files?: string | null;
  branch?: string | null;
  held_undeclared?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DecisionRow {
  id: string;
  packet_id: string;
  hr_item_id: string;
  kind: 'approve' | 'changes' | 'defer';
  note: string | null;
  into: 'checklist' | 'bug' | null;
  follow: 'ticket' | 'none' | null;
  result_ref: string | null;
  decided_at: string;
}

export const displayId = (contentHash: string) => `pkt-${contentHash.slice(0, 4)}`;
export const sameSha = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x));
};
export const short = (sha: string | null) => (sha ?? '').slice(0, 7);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const json = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export function packetRows(db: Db, itemId: string): PacketRow[] {
  return db.sqlite
    .prepare('SELECT * FROM packets WHERE item_id = ? ORDER BY round')
    .all(itemId) as PacketRow[];
}

export function openPacketOf(db: Db, itemId: string): PacketRow | undefined {
  return db.sqlite
    .prepare("SELECT * FROM packets WHERE item_id = ? AND state = 'open'")
    .get(itemId) as PacketRow | undefined;
}

export function decisionsOf(db: Db, packetId: string): DecisionRow[] {
  return db.sqlite
    .prepare('SELECT * FROM review_decisions WHERE packet_id = ? ORDER BY created_at, id')
    .all(packetId) as DecisionRow[];
}

function packetItems(db: Db, packetId: string) {
  return db.sqlite
    .prepare(
      `SELECT pi.hr_item_id, pi.text_snapshot, h.state FROM packet_items pi
       JOIN hr_items h ON h.id = pi.hr_item_id
       WHERE pi.packet_id = ? ORDER BY h.position, pi.id`,
    )
    .all(packetId) as {
    hr_item_id: string;
    text_snapshot: string;
    state: 'declared' | 'ready' | 'approved' | 'deferred';
  }[];
}

/** A round's outcome on the packet screen's round buttons. */
export function roundOutcome(
  state: PacketRow['state'],
  decisions: Pick<DecisionRow, 'kind'>[],
): 'sent_back' | 'approved' | 'closed_with_deferred' | null {
  if (state !== 'decided' || decisions.length === 0) return null;
  if (decisions.some((d) => d.kind === 'changes')) return 'sent_back';
  if (decisions.some((d) => d.kind === 'defer')) return 'closed_with_deferred';
  return 'approved';
}

/**
 * Where an approval's note was kept (owner decision 35): `item`, or the scope
 * of the owner decision it became (its `result_ref`); null without a note.
 */
export function keepOf(db: Db, d: DecisionRow): 'item' | 'epic' | 'project' | null {
  if (d.kind !== 'approve' || !d.note) return null;
  if (!d.result_ref) return 'item';
  const row = db.sqlite
    .prepare('SELECT scope_kind FROM decision_records WHERE id = ?')
    .get(d.result_ref) as { scope_kind: 'epic' | 'project' } | undefined;
  return row?.scope_kind ?? 'item';
}

/** What a decision produced, as the packet screen says it ("→ bug RCP-30"). */
export function resultText(
  d: DecisionRow,
  keep: 'item' | 'epic' | 'project' | null = null,
): string | null {
  if (d.kind === 'changes') {
    return d.into === 'bug' ? `→ bug ${d.result_ref ?? ''}`.trim() : '→ checklist item';
  }
  if (d.kind === 'defer' && d.result_ref) return `→ test ticket ${d.result_ref}`;
  if (keep === 'epic') return '→ decision for the epic’s future tickets';
  if (keep === 'project') return '→ decision for all the project’s work';
  return null;
}

/** A decision as the packet screen shows it. */
function verdictView(db: Db, d: DecisionRow) {
  const keep = keepOf(db, d);
  return {
    kind: d.kind,
    note: d.note,
    into: d.into,
    follow: d.follow,
    keep,
    decision_id: keep === 'epic' || keep === 'project' ? d.result_ref : null,
    result_ref: resultText(d, keep),
    decided_at: d.decided_at,
  };
}

/** Does a known gap explain this failing check? It names the check's id, or quotes its text. */
function gapMentions(gaps: string[], check: { id: string; text: string }): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[.!?:;,\s]+$/, '')
      .trim();
  const text = norm(check.text);
  return gaps.some((g) => {
    const gap = norm(g);
    return gap.includes(check.id.toLowerCase()) || (text.length > 0 && gap.includes(text));
  });
}

// ---- Cursors (opaque to agents) ----

const encodeCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

function decodeCursor(cursor: string): number {
  try {
    const o = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown }).o;
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // Falls through to the error.
  }
  throw new ToolError(
    'validation',
    'That cursor is not valid here. Pass next_cursor from the previous page, or leave it out.',
    { details: { fields: { cursor: 'not a cursor from this list' } } },
  );
}

/**
 * What a packet says about shared changes (decision 36; BUILD_SPEC §5.21
 * Hand-off): the changed files and branch as reported, whether it is held for
 * undeclared parts (and the hold to decide), and "Changed files not
 * reported" when an item with declarations handed off without them.
 */
function sharedOf(db: Db, itemId: string, packet: PacketRow) {
  const held = packet.held_undeclared ? (JSON.parse(packet.held_undeclared) as string[]) : null;
  const hold = held
    ? (db.sqlite
        .prepare("SELECT id FROM undeclared_holds WHERE packet_id = ? AND state = 'open'")
        .get(packet.id) as { id: string } | undefined)
    : undefined;
  const files = packet.changed_files ? (JSON.parse(packet.changed_files) as string[]) : null;
  return {
    changed_files: files,
    branch: packet.branch ?? null,
    held_undeclared: held,
    hold_id: hold?.id ?? null,
    not_reported: files === null && declaredKeys(db, itemId).length > 0,
  };
}

export function createPacketsService(deps: ServiceDeps): PacketsService {
  const windows = () => windowsOf(deps.config);

  /** Commits on the item, and on its children when it's an epic (an epic-level packet). */
  function commitsFor(db: Db, item: ItemRow): { sha: string; reported_at: string }[] {
    return db.sqlite
      .prepare(
        `SELECT sha, reported_at FROM commits
         WHERE item_id = ? OR item_id IN (SELECT id FROM items WHERE epic_id = ?)`,
      )
      .all(item.id, item.type === 'Epic' ? item.id : '') as { sha: string; reported_at: string }[];
  }

  return {
    submit(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      const open = openPacketOf(w.db, item.id);
      if (open) {
        throw new ToolError(
          'validation',
          `A packet is already open on ${item.id} (round ${open.round}, ${displayId(open.content_hash)}). Wait for the owner's decision; read it with get_review.`,
          { details: { reason: 'packet_open', packet_id: open.id, round: open.round } },
        );
      }
      if (item.status !== 'progress') {
        throw new ToolError(
          'validation',
          `${item.id} is ${item.status}; packets are submitted from In progress. Claim it with claim_lead first.`,
          { details: { reason: 'status', status: item.status } },
        );
      }
      const block = new BlockIndex(w.db).state(item.id);
      if (block.blocked) {
        throw new ToolError(
          'validation',
          `${item.id} is blocked by ${block.blocked_by.join(', ')}, so it can't go to review yet. Submit once they clear.`,
          { details: { reason: 'blocked', blocked_by: block.blocked_by } },
        );
      }
      const all = hrRows(w.db, item.id);
      const declared = all.filter((h) => h.state === 'declared');
      if (declared.length === 0) {
        throw new ToolError(
          'validation',
          `${item.id} has no declared human review items, so there is nothing for the owner to verify. Close it with set_status "done" instead.`,
          { details: { reason: 'nothing_declared' } },
        );
      }
      let chosen = declared;
      if (input.hr_item_ids) {
        chosen = [];
        for (const id of [...new Set(input.hr_item_ids)]) {
          const h = all.find((x) => x.id === id);
          if (!h) {
            throw new ToolError(
              'validation',
              `Unknown human review item ${id} on ${item.id}. Use an id from get_item.`,
              { details: { fields: { hr_item_ids: 'unknown id' }, unknown_id: id } },
            );
          }
          if (h.state !== 'declared') {
            throw new ToolError(
              'validation',
              `${id} is ${h.state}; only declared items go into a packet. Leave it out of hr_item_ids.`,
              { details: { fields: { hr_item_ids: `${id} is ${h.state}` } } },
            );
          }
          chosen.push(h);
        }
      }
      const gaps = input.gaps ?? [];
      const failing = checkRows(w.db, item.id).filter(
        (c) => c.state === 'fail' && !gapMentions(gaps, c),
      );
      if (failing.length > 0) {
        const c = failing[0]!;
        throw new ToolError(
          'validation',
          `Check ${c.id} “${c.text}” is failing and no known gap explains it. Fix it, or add a gap that names the check.`,
          { details: { reason: 'failing_check', checks: failing.map((f) => f.id) } },
        );
      }
      const attachments = (input.attachments ?? []).map((a) => {
        const doc = w.db.sqlite
          .prepare(
            `SELECT v.id, d.item_id, d.name FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ?`,
          )
          .get(a.document_version_id) as
          { id: string; item_id: string | null; name: string } | undefined;
        if (!doc) {
          throw new ToolError(
            'not_found',
            `No document version ${a.document_version_id}. Upload it with put_document first.`,
          );
        }
        if (doc.item_id !== item.id) {
          throw new ToolError(
            'validation',
            `${a.document_version_id} (${doc.name}) belongs to ${doc.item_id ?? 'a project'}, not ${item.id}. Upload attachments to this item with put_document.`,
            { details: { fields: { attachments: 'not on this item' } } },
          );
        }
        return { document_version_id: doc.id, caption: a.caption ?? null };
      });

      // The commit it was built from, recorded if this is the first we hear of it.
      const sha = input.built_from_commit.toLowerCase();
      if (!commitsFor(w.db, item).some((c) => sameSha(c.sha, sha))) {
        deps.services().evidence.reportCommit(w, { id: item.id, sha, pushed: false });
      }

      const round =
        (
          w.db.sqlite
            .prepare('SELECT coalesce(max(round), 0) AS n FROM packets WHERE item_id = ?')
            .get(item.id) as { n: number }
        ).n + 1;
      const snapshot = {
        item: item.id,
        round,
        built_from_commit: sha,
        estimate: input.estimate,
        items: chosen.map((h) => ({ hr_item_id: h.id, text: h.text })),
        how: input.how,
        checked: input.checked,
        gaps,
        attachments,
      };
      const contentHash = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
      const packetId = newId('pkt', ms(w.now));
      const who = callerName(w.db, w.actor);
      w.insert('packets', {
        id: packetId,
        item_id: item.id,
        round,
        content_hash: contentHash,
        built_from_commit: sha,
        estimate: input.estimate,
        how: input.how,
        checked: input.checked,
        gaps,
        created_by: who,
        state: 'open',
        // Decision 36: stored as reported, then mapped through the parts' paths below.
        changed_files: input.changed_files ?? null,
        branch: input.branch ?? null,
        version: 1,
      });
      // B41: the hand-off's branch joins the item's reported branches.
      addReportedBranch(w, item.id, input.branch);
      for (const h of chosen) {
        w.insert('packet_items', {
          id: newId('pki', ms(w.now)),
          packet_id: packetId,
          hr_item_id: h.id,
          text_snapshot: h.text,
        });
        w.update('hr_items', h.id, { state: 'ready' });
      }
      for (const a of attachments) {
        w.insert('packet_attachments', {
          id: newId('pka', ms(w.now)),
          packet_id: packetId,
          document_version_id: a.document_version_id,
          caption: a.caption,
        });
      }
      const display = displayId(contentHash);
      w.event({
        type: 'packet.submitted',
        summary: `${who} handed off packet round ${round} (${display}) on ${item.id}: ${plural(chosen.length, 'thing')} to verify, about ${input.estimate}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          packet_id: packetId,
          round,
          content_hash: contentHash,
          built_from_commit: sha,
          hr_item_ids: chosen.map((h) => h.id),
        },
        objects: [{ kind: 'packet', id: packetId }],
      });
      w.update('items', item.id, { status: 'review' });
      w.event({
        type: 'item.status_changed',
        summary: `${who} moved ${item.id} from progress to review`,
        item_id: item.id,
        project_key: item.project_key,
        data: { status: { old: 'progress', new: 'review' }, packet_id: packetId },
      });
      // Decisions 36 and 39 (FR-162, FR-181): undeclared parts get the three questions. Safe
      // ones join the declaration; one that needs the owner holds the packet: it is created,
      // but its review gate stays closed until they decide. A hand-off ends the item's leases.
      const held = settleUndeclared(w, deps.services().links, item, input.changed_files ?? []);
      if (held.parts.length > 0) {
        w.update('packets', packetId, { held_undeclared: held.parts });
        raiseHold(w, item, {
          via: 'submit_packet',
          packet_id: packetId,
          parts: held.parts,
          files: held.files,
        });
      }
      endLeasesOf(w, item.id, 'handed_off');
      return {
        packet_id: packetId,
        round,
        display_id: display,
        item: summaryOf({ db: w.db, windows: windows(), now: w.now }, item.id),
        ...(held.parts.length > 0 ? { held_undeclared: held.parts } : {}),
      };
    },

    getReview(r, input) {
      const item = requireItem(r.db, input.id);
      const stale = openPackets(r.db, [item.id]).get(item.id);
      return {
        rounds: packetRows(r.db, item.id).map((p) => {
          const decisions = decisionsOf(r.db, p.id);
          const byHr = new Map(decisions.map((d) => [d.hr_item_id, d]));
          return {
            packet_id: p.id,
            round: p.round,
            state: p.state,
            stale: p.state === 'open' && stale?.id === p.id && stale.stale,
            built_from_commit: p.built_from_commit ?? '',
            submitted_at: p.created_at,
            decided_at:
              decisions.length > 0
                ? decisions.map((d) => d.decided_at).sort((a, b) => b.localeCompare(a))[0]!
                : null,
            items: packetItems(r.db, p.id).map((pi) => {
              const d = byHr.get(pi.hr_item_id);
              return {
                hr_item_id: pi.hr_item_id,
                text: pi.text_snapshot,
                decision: d
                  ? {
                      kind: d.kind,
                      note: d.note,
                      into: d.into,
                      follow: d.follow,
                      result_ref: d.result_ref,
                    }
                  : null,
              };
            }),
          };
        }),
      };
    },

    deferredReviews(r, input) {
      if (input.project) {
        const project = r.db.sqlite
          .prepare('SELECT key FROM projects WHERE key = ? AND deleted_at IS NULL')
          .get(input.project);
        if (!project) {
          throw new ToolError(
            'not_found',
            `No project ${input.project}. Check the key with list_projects.`,
          );
        }
      }
      const rows = deferredOf(scoped(r, windows(), input.project ?? 'all')).rows;
      const offset = input.cursor ? decodeCursor(input.cursor) : 0;
      const limit = input.limit;
      return {
        items: rows.slice(offset, offset + limit),
        next_cursor: offset + limit < rows.length ? encodeCursor(offset + limit) : null,
      };
    },

    screen(r, input): ReviewResponse {
      const { db } = r;
      const item = requireItem(db, input.id);
      const rounds = packetRows(db, item.id);
      if (rounds.length === 0) {
        throw new ToolError(
          'not_found',
          `No handoff packet on ${item.id} yet. It appears here when the agent submits one.`,
        );
      }
      const packet =
        input.round === undefined ? rounds.at(-1)! : rounds.find((p) => p.round === input.round);
      if (!packet) {
        throw new ToolError(
          'not_found',
          `${item.id} has no round ${input.round}; it has ${plural(rounds.length, 'round')}.`,
        );
      }

      // "Ready for you": every open packet in a live project, oldest first.
      const queueRows = db.sqlite
        .prepare(
          `SELECT p.item_id, i.title, p.round, p.estimate FROM packets p
           JOIN items i ON i.id = p.item_id JOIN projects pr ON pr.key = i.project_key
           WHERE p.state = 'open' AND pr.deleted_at IS NULL
           ORDER BY p.created_at, p.item_id`,
        )
        .all() as { item_id: string; title: string; round: number; estimate: string | null }[];
      const open = openPackets(db, [...new Set([...queueRows.map((q) => q.item_id), item.id])]);

      const decisions = decisionsOf(db, packet.id);
      const byHr = new Map(decisions.map((d) => [d.hr_item_id, d]));
      const attachments = db.sqlite
        .prepare(
          `SELECT pa.document_version_id, d.name, v.mime, pa.caption FROM packet_attachments pa
           JOIN document_versions v ON v.id = pa.document_version_id
           JOIN documents d ON d.id = v.document_id
           WHERE pa.packet_id = ? ORDER BY pa.created_at, pa.id`,
        )
        .all(packet.id) as {
        document_version_id: string;
        name: string;
        mime: string;
        caption: string | null;
      }[];
      const index = new BlockIndex(db);
      return {
        item: summaryOf({ db, windows: windows(), now: r.now, index }, item.id),
        queue: queueRows.map((q) => ({
          item_id: q.item_id,
          title: q.title,
          round: q.round,
          estimate: q.estimate ?? '',
          stale: open.get(q.item_id)?.stale ?? false,
        })),
        rounds: rounds.map((p) => ({
          round: p.round,
          state: p.state,
          outcome: roundOutcome(p.state, decisionsOf(db, p.id)),
        })),
        packet: {
          packet_id: packet.id,
          display_id: displayId(packet.content_hash),
          round: packet.round,
          state: packet.state,
          stale: packet.state === 'open' && (open.get(item.id)?.stale ?? false),
          built_from_commit: packet.built_from_commit ?? '',
          estimate: packet.estimate ?? '',
          created_by: packet.created_by,
          created_at: packet.created_at,
          items: packetItems(db, packet.id).map((pi) => {
            const d = byHr.get(pi.hr_item_id);
            return {
              hr_item_id: pi.hr_item_id,
              text: pi.text_snapshot,
              state: pi.state,
              decision: d ? verdictView(db, d) : null,
            };
          }),
          how: json<string[]>(packet.how, []),
          checked: json<ReviewResponse['packet']['checked']>(packet.checked, []),
          gaps: json<string[]>(packet.gaps, []),
          attachments,
          shared: sharedOf(db, item.id, packet),
        },
        unblocks: index.unblocks(item.id),
      };
    },

    refresh(w, input) {
      const item = requireItem(w.db, input.id);
      const packet = w.get('packets', input.packet_id) as PacketRow | undefined;
      if (!packet || packet.item_id !== item.id) {
        throw new ToolError('not_found', `No packet ${input.packet_id} on ${item.id}.`);
      }
      if (packet.state !== 'open') {
        throw new ToolError(
          'conflict',
          `Round ${packet.round} on ${item.id} is already ${packet.state}; there is no open packet to refresh.`,
          { current: { state: packet.state, round: packet.round } },
        );
      }
      const ops: InverseOp[] = [w.update('packets', packet.id, { state: 'withdrawn' })];
      const back = hrRows(w.db, item.id).filter((h) => h.state === 'ready');
      for (const h of back) ops.push(w.update('hr_items', h.id, { state: 'declared' }));
      w.event({
        type: 'packet.withdrawn',
        summary: `You asked for a fresh packet on ${item.id}: round ${packet.round} withdrawn`,
        item_id: item.id,
        project_key: item.project_key,
        data: { packet_id: packet.id, round: packet.round, reason: 'fresh_packet' },
        inverse: ops,
        objects: [{ kind: 'packet', id: packet.id }],
      });
      if (item.status === 'review') {
        const inverse = w.update('items', item.id, { status: 'progress' });
        w.event({
          type: 'item.status_changed',
          summary: `You moved ${item.id} from review to progress for a fresh packet`,
          item_id: item.id,
          project_key: item.project_key,
          data: { status: { old: 'review', new: 'progress' } },
          inverse: [inverse],
        });
      }
      const text = `Please submit a fresh packet; code changed after ${short(packet.built_from_commit)}.`;
      const noteId = newId('note', ms(w.now));
      const noteInverse = w.insert('owner_notes', { id: noteId, item_id: item.id, text });
      w.event({
        type: 'owner_note.added',
        summary: `You left a note: ${text}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { note_id: noteId, text },
        inverse: [noteInverse],
      });
      return summaryOf({ db: w.db, windows: windows(), now: w.now }, item.id);
    },

    markStale(w, input) {
      const item = requireItem(w.db, input.item_id);
      const sha = input.sha.toLowerCase();
      const candidates = w.db.sqlite
        .prepare(
          `SELECT p.*, i.type AS item_type FROM packets p JOIN items i ON i.id = p.item_id
           WHERE p.state = 'open' AND (p.item_id = ? OR (p.item_id = ? AND i.type = 'Epic'))`,
        )
        .all(item.id, item.epic_id ?? '') as (PacketRow & { item_type: string })[];
      const who = callerName(w.db, w.actor);
      const out: { item_id: string; packet_id: string; round: number }[] = [];
      for (const p of candidates) {
        const built = p.built_from_commit ?? '';
        if (sameSha(sha, built)) continue;
        out.push({ item_id: p.item_id, packet_id: p.id, round: p.round });
        // Already out of date from an earlier commit? Then it was recorded then.
        const owner = requireItem(w.db, p.item_id);
        const earlier = commitsFor(w.db, owner).some(
          (c) =>
            c.sha.toLowerCase() !== sha &&
            ms(c.reported_at) > ms(p.created_at) &&
            !sameSha(c.sha, built),
        );
        if (earlier) continue;
        w.event({
          type: 'packet.stale',
          summary: `Packet round ${p.round} on ${p.item_id} is out of date: ${who} reported ${short(sha)}${item.id !== p.item_id ? ` on ${item.id}` : ''} after it was built from ${short(built)}`,
          item_id: p.item_id,
          project_key: owner.project_key,
          data: { packet_id: p.id, round: p.round, sha, built_from_commit: built },
          objects: [{ kind: 'packet', id: p.id }],
        });
      }
      return out;
    },
  };
}
