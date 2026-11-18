/**
 * Agent proposals (owner decision 30; BUILD_SPEC §5.19; FR-128–FR-130;
 * tasks.md T160): `get_agent_files`, `propose_agent_file_change`, and the
 * owner's list, approve (optionally edited) and decline.
 *
 * **Reading.** `files` lists what a project uses: each agent file in effect
 * (its copy, else the default; agent-files.ts `effectiveAgentFiles`) and the
 * Workflow notes, always listed (no notes yet: `version_id` null, content
 * ""). The listing carries no text (token cost, B26); `file` returns that
 * one file with its full text.
 *
 * **Proposing** stores a pending row and changes nothing else. A target is a
 * file Task Lite ships, or `workflow` for a project. `based_on_version_id`
 * must be a version of that file (any layer) or of the project's notes, so
 * the review can show what the agent read. The write path's checks apply
 * (secrets refused, unknown item IDs warned). Two rules the schema can't
 * hold: a newer proposal from the same run replaces its own older pending
 * one for the same target (the old row is removed; the event says so), and
 * at most 5 proposals wait per target (project or default, and file).
 *
 * **Deciding** is the owner's alone (owner routes; agents have no path,
 * FR-130). *Approve* saves the agent's text, or the owner's edit of it, as a
 * new version of the target, the project's copy or the default, authored
 * "proposed by <client · label> · approved by owner". The save and the
 * decision both carry inverses, so the toast's Undo reverses both. *Decline*
 * records the optional note and can't be undone. A proposal whose target
 * changed since the agent read it is flagged `changed_since`, and the UI
 * shows the three-way view (base → current, base → proposed).
 */
import {
  ToolError,
  WORKFLOW_KEY,
  type AgentFileInEffect,
  type Proposal,
  type ProposalState,
} from '@tasklite/shared';
import type { Db } from '../db/client.js';
import {
  agentFileName,
  currentTarget,
  effectiveAgentFiles,
  isShippedKey,
  isVersionOf,
  saveAgentFileEdit,
  saveWorkflowEdit,
  sha256,
} from './agent-files.js';
import type { AgentProposalsService, ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import { actorName } from './model.js';
import type { InverseOp } from './write.js';

/** At most this many proposals wait for the owner per target (BUILD_SPEC §5.19). */
export const MAX_PENDING_PER_TARGET = 5;

interface ProposalRow {
  id: string;
  project_key: string | null;
  file_key: string;
  content: string;
  reason: string;
  based_on_version_id: string | null;
  run_id: string | null;
  proposed_by: string;
  state: ProposalState;
  decided_at: string | null;
  decided_note: string | null;
  result_version_id: string | null;
  created_at: string;
}

/** "tasklite-worker", "AGENTS.md block", "Workflow notes". */
export function targetName(key: string): string {
  return key === WORKFLOW_KEY ? 'Workflow notes' : agentFileName(key);
}

/** "tasklite-worker (RCP's copy)" / "tasklite-worker (the default)". */
function targetWhere(key: string, project: string | null): string {
  if (key === WORKFLOW_KEY) return `the Workflow notes of ${project}`;
  return `${agentFileName(key)} (${project ? `${project}'s copy` : 'the default'})`;
}

function requireProject(db: Db, key: string): void {
  const p = db.sqlite
    .prepare('SELECT key FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(key);
  if (!p) throw new ToolError('not_found', `No project ${key}. Check the key with list_projects.`);
}

const SELECT = `SELECT p.id, p.project_key, p.file_key, p.content, p.reason, p.based_on_version_id,
  p.run_id, p.proposed_by, p.state, p.decided_at, p.decided_note, p.result_version_id, p.created_at
  FROM agent_file_proposals p`;

function toProposal(db: Db, row: ProposalRow): Proposal {
  const current = currentTarget(db, row.file_key, row.project_key);
  const run = row.run_id
    ? (db.sqlite.prepare('SELECT item_id FROM runs WHERE id = ?').get(row.run_id) as
        { item_id: string } | undefined)
    : undefined;
  return {
    id: row.id,
    project: row.project_key,
    file_key: row.file_key,
    name: targetName(row.file_key),
    content: row.content,
    reason: row.reason,
    based_on_version_id: row.based_on_version_id,
    current_version_id: current?.id ?? null,
    // Only a pending proposal can still be overtaken; a decided one shows what was decided.
    changed_since: row.state === 'pending' && row.based_on_version_id !== (current?.id ?? null),
    run_id: row.run_id,
    item_id: run?.item_id ?? null,
    proposed_by: row.proposed_by,
    state: row.state,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_note: row.decided_note,
    result_version_id: row.result_version_id,
  };
}

function proposalRow(db: Db, id: string): ProposalRow {
  const row = db.sqlite.prepare(`${SELECT} WHERE p.id = ?`).get(id) as ProposalRow | undefined;
  if (!row) throw new ToolError('not_found', `No proposal ${id}. It may have been replaced.`);
  return row;
}

/** Only a pending proposal can be decided; a second decision gets `conflict` with the current state. */
function requirePending(db: Db, row: ProposalRow): void {
  if (row.state !== 'pending') {
    throw new ToolError(
      'conflict',
      `This proposal was already ${row.state}${row.decided_at ? ` at ${row.decided_at}` : ''}.`,
      { current: toProposal(db, row) as unknown as Record<string, unknown> },
    );
  }
}

export function createAgentProposalsService(_deps: ServiceDeps): AgentProposalsService {
  return {
    files(r, input) {
      requireProject(r.db, input.project);
      const want = input.file;
      const files: AgentFileInEffect[] = effectiveAgentFiles(r.db, input.project).map((e) => ({
        key: e.key,
        kind: e.key.startsWith('skill:') ? 'skill' : 'agents_block',
        version_id: e.version.id,
        sha256: e.version.sha256,
        source: e.layer === 'project' ? 'project' : 'default',
        content: want === e.key ? e.version.content : null,
      }));
      const notes = currentTarget(r.db, WORKFLOW_KEY, input.project);
      files.push({
        key: WORKFLOW_KEY,
        kind: 'workflow',
        version_id: notes?.id ?? null,
        sha256: notes?.sha256 ?? sha256(''),
        source: 'project',
        content: want === WORKFLOW_KEY ? (notes?.content ?? '') : null,
      });
      if (want === undefined) return { project: input.project, files };
      const one = files.find((f) => f.key === want);
      if (!one) {
        throw new ToolError(
          'validation',
          `No agent file ${want}. Files: ${files.map((f) => f.key).join(', ')}.`,
          { details: { field: 'file' } },
        );
      }
      return { project: input.project, files: [one] };
    },

    propose(w, input) {
      const project = input.project ?? null;
      if (project) requireProject(w.db, project);
      const key = input.file;
      if (key !== WORKFLOW_KEY && !isShippedKey(w.db, key)) {
        throw new ToolError(
          'validation',
          `No agent file ${key}: only the files Task Lite ships can be changed. Read the list with get_agent_files.`,
          { details: { field: 'file' } },
        );
      }
      const base = input.based_on_version_id;
      if (base !== null && !isVersionOf(w.db, base, key, project)) {
        throw new ToolError(
          'validation',
          `based_on_version_id ${base} isn't a version of ${targetName(key)}. Pass the version_id get_agent_files returned.`,
          { details: { field: 'based_on_version_id' } },
        );
      }
      if (base === null && currentTarget(w.db, key, project) !== null) {
        throw new ToolError(
          'validation',
          `${targetName(key)} already exist; pass the version_id get_agent_files returned as based_on_version_id.`,
          { details: { field: 'based_on_version_id' } },
        );
      }
      const runId = input.run_id ?? w.actor.run_id ?? null;
      const run = runId
        ? (w.db.sqlite.prepare('SELECT id, item_id, label FROM runs WHERE id = ?').get(runId) as
            { id: string; item_id: string; label: string | null } | undefined)
        : undefined;
      if (runId && !run) {
        throw new ToolError('not_found', `No run ${runId}. Pass the run_id claim_lead returned.`);
      }
      const reason = input.reason.trim();
      const by = actorName({ ...w.actor, label: w.actor.label ?? run?.label ?? null });

      // A newer proposal from the same run replaces its own older one.
      const inverse: InverseOp[] = [];
      let replaced: string | null = null;
      if (run) {
        const own = w.db.sqlite
          .prepare(
            `SELECT id FROM agent_file_proposals WHERE run_id = ? AND file_key = ? AND project_key IS ? AND state = 'pending'
             ORDER BY created_at DESC, id DESC`,
          )
          .all(run.id, key, project) as { id: string }[];
        for (const o of own) inverse.push(w.remove('agent_file_proposals', o.id));
        replaced = own[0]?.id ?? null;
      }
      const pending = (
        w.db.sqlite
          .prepare(
            `SELECT count(*) AS n FROM agent_file_proposals WHERE file_key = ? AND project_key IS ? AND state = 'pending'`,
          )
          .get(key, project) as { n: number }
      ).n;
      if (pending >= MAX_PENDING_PER_TARGET) {
        throw new ToolError(
          'validation',
          `${MAX_PENDING_PER_TARGET} proposals for ${targetWhere(key, project)} already wait for the owner. Tell the user, and propose again once the owner has decided.`,
          { details: { pending, limit: MAX_PENDING_PER_TARGET } },
        );
      }

      const id = newId('afp', Date.parse(w.now));
      inverse.push(
        w.insert('agent_file_proposals', {
          id,
          project_key: project,
          file_key: key,
          content: input.content,
          reason,
          based_on_version_id: base,
          run_id: run?.id ?? null,
          proposed_by: by,
          state: 'pending',
        }),
      );
      w.event({
        type: 'agent_file.proposed',
        summary: `${by} proposed a change to ${targetWhere(key, project)}${replaced ? ', replacing its earlier proposal' : ''}: ${reason}`,
        project_key: project,
        item_id: run?.item_id ?? null,
        data: { key, project, proposal_id: id, based_on_version_id: base, replaced },
        objects: [
          { kind: 'agent_file_proposal', id },
          ...(replaced ? [{ kind: 'agent_file_proposal' as const, id: replaced }] : []),
        ],
        // Agents can't undo; kept for the record.
        inverse,
      });
      return { proposal_id: id, state: 'pending' };
    },

    list(r, input) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (input.project) {
        where.push('p.project_key = ?');
        args.push(input.project);
      }
      if (input.state) {
        where.push('p.state = ?');
        args.push(input.state);
      }
      // Proposals of deleted projects go with them (cascade); a project being deleted is hidden.
      where.push(
        '(p.project_key IS NULL OR EXISTS (SELECT 1 FROM projects x WHERE x.key = p.project_key AND x.deleted_at IS NULL))',
      );
      const rows = r.db.sqlite
        .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC`)
        .all(...args) as ProposalRow[];
      return { proposals: rows.map((row) => toProposal(r.db, row)) };
    },

    approve(w, input) {
      const row = proposalRow(w.db, input.id);
      requirePending(w.db, row);
      const content = input.content ?? row.content;
      const edited = input.content !== undefined && input.content !== row.content;
      if (row.file_key !== WORKFLOW_KEY && content.trim() === '') {
        throw new ToolError('validation', `${targetName(row.file_key)} can't be empty.`, {
          details: { field: 'content' },
        });
      }
      if (row.file_key === WORKFLOW_KEY && content.length > 10_000) {
        throw new ToolError('validation', 'Workflow notes must be at most 10000 characters.', {
          details: { field: 'content' },
        });
      }
      const author = `proposed by ${row.proposed_by} · ${edited ? 'edited and approved' : 'approved'} by owner`;
      const note = input.note?.trim() || row.reason;
      const how = edited
        ? 'Approved, with edits, a proposed change to'
        : 'Approved a proposed change to';
      let resultId: string;
      const inverse: InverseOp[] = [];
      if (row.file_key === WORKFLOW_KEY) {
        resultId = saveWorkflowEdit(w, {
          project: row.project_key!,
          content_md: content,
          note,
          author,
          how,
        }).id;
      } else {
        resultId = saveAgentFileEdit(w, {
          key: row.file_key,
          project: row.project_key,
          content,
          note,
          author,
          how,
        }).version.id;
      }
      inverse.push(
        w.update('agent_file_proposals', row.id, {
          state: 'approved',
          decided_at: w.now,
          decided_note: input.note?.trim() || null,
          result_version_id: resultId,
        }),
      );
      w.event({
        type: 'agent_file.proposal_decided',
        summary: `You approved ${row.proposed_by}'s proposed change to ${targetWhere(row.file_key, row.project_key)}${edited ? ', with edits' : ''}`,
        project_key: row.project_key,
        data: { proposal_id: row.id, decision: 'approved', edited, result_version_id: resultId },
        objects: [{ kind: 'agent_file_proposal', id: row.id }],
        inverse,
      });
      return toProposal(w.db, proposalRow(w.db, row.id));
    },

    decline(w, input) {
      const row = proposalRow(w.db, input.id);
      requirePending(w.db, row);
      const note = input.note?.trim() || null;
      w.update('agent_file_proposals', row.id, {
        state: 'declined',
        decided_at: w.now,
        decided_note: note,
      });
      w.event({
        type: 'agent_file.proposal_decided',
        summary: `You declined ${row.proposed_by}'s proposed change to ${targetWhere(row.file_key, row.project_key)}${note ? `: ${note}` : ''}`,
        project_key: row.project_key,
        data: { proposal_id: row.id, decision: 'declined', note },
        objects: [{ kind: 'agent_file_proposal', id: row.id }],
        // Not undoable (B26 resolution 8).
        inverse: null,
      });
      return toProposal(w.db, proposalRow(w.db, row.id));
    },
  };
}

/** Pending proposals in a scope, for Needs you ("n agent file changes proposed"). */
export function pendingProposalCount(db: Db, scope: string): number {
  const row = db.sqlite
    .prepare(
      `SELECT count(*) AS n FROM agent_file_proposals p
       WHERE p.state = 'pending' AND (? = 'all' OR p.project_key = ?)
       AND (p.project_key IS NULL OR EXISTS (SELECT 1 FROM projects x WHERE x.key = p.project_key AND x.deleted_at IS NULL))`,
    )
    .get(scope, scope) as { n: number };
  return row.n;
}
