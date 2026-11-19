/**
 * Onboarding (owner decision 31; BUILD_SPEC §5.20; FR-135–FR-140; MCP_SPEC
 * §5.11; tasks.md T164): `onboard_project`, `finish_onboarding`, the `onboard`
 * prompt's guide, and the owner's list and *Mark reviewed*.
 *
 * - **Start** (`onboard_project`, agents only): a free key creates the project
 *   (name required; `created_by` is the caller, `project.created`); a live
 *   key adopts it; a deleted key still being cleaned up is `conflict`, as for
 *   imports. Then a session starts (`onboarding.started`). The same client
 *   calling again while its own session is in progress gets that session back
 *   and writes nothing; another client's session in progress is `forbidden`.
 * - **Tagging:** every event the client writes on the project while its
 *   session is in progress carries `data.onboarding_session` (write.ts;
 *   onboarding-tag.ts has the rule). `changesOf` counts them.
 * - **Finish** (`finish_onboarding`): the session's own client only; ready for
 *   review, with the summary, questions and counts (`onboarding.finished`,
 *   for you).
 * - **Review** (owner): *Mark reviewed* (`onboarding.reviewed`). An
 *   agent-created project shows `created_by` until one of its sessions is
 *   reviewed (views.ts).
 * - **Safety:** while a session is in progress its client can't move items
 *   to Ready (items.ts), and agents never change project settings or delete
 *   projects (projects.ts).
 */
import {
  ONBOARDING_GUIDE_KEY,
  ToolError,
  type OnboardingChange,
  type OnboardingChanges,
  type OnboardingSession,
  type OnboardingState,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { effectiveText } from './agent-files.js';
import type { OnboardingService, ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import { callerName } from './model.js';
import { insertProject } from './projects.js';
import type { WriteContext } from './write.js';

interface SessionRow {
  id: string;
  project_key: string;
  started_by: string;
  client: string;
  run_id: string | null;
  started_at: string;
  state: OnboardingState;
  summary: string | null;
  questions: string;
  finished_at: string | null;
  reviewed_at: string | null;
}

/** Event types that count as enriching an item that existed before the session. */
const ENRICHING = new Set([
  'item.updated',
  'item.status_changed',
  'link.added',
  'link.updated',
  'document.added',
  'human_review.declared',
  'decision.published',
  'note.added',
]);

export interface SessionChanges {
  counts: OnboardingChanges;
  created: Set<string>;
  enriched: Set<string>;
  workflow_proposal_id: string | null;
}

/** What a session changed, from its tagged events (the review card's counts and links). */
export function changesOf(db: Db, session: { id: string; project_key: string }): SessionChanges {
  const rows = db.sqlite
    .prepare(
      `SELECT seq, type, item_id, data FROM events
        WHERE project_key = @key AND json_extract(data, '$.onboarding_session') = @id
       UNION ALL
       SELECT e.seq, e.type, e.item_id, e.data FROM events e JOIN items i ON i.id = e.item_id
        WHERE e.project_key IS NULL AND i.project_key = @key
          AND json_extract(e.data, '$.onboarding_session') = @id
       ORDER BY seq`,
    )
    .all({ key: session.project_key, id: session.id }) as {
    type: string;
    item_id: string | null;
    data: string;
  }[];
  const created = new Set<string>();
  const touched = new Set<string>();
  const documents = new Set<string>();
  let decisions = 0;
  let proposals = 0;
  let workflow: string | null = null;
  for (const row of rows) {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    if (row.type === 'item.created' && row.item_id) created.add(row.item_id);
    else if (ENRICHING.has(row.type) && row.item_id) touched.add(row.item_id);
    if (row.type === 'document.added' && typeof data.document_id === 'string') {
      documents.add(data.document_id);
    }
    if (row.type === 'decision.published') decisions += 1;
    if (row.type === 'agent_file.proposed') {
      proposals += 1;
      if (data.key === 'workflow' && typeof data.proposal_id === 'string') {
        workflow = data.proposal_id;
      }
    }
  }
  const enriched = new Set([...touched].filter((id) => !created.has(id)));
  return {
    counts: {
      created: created.size,
      enriched: enriched.size,
      documents: documents.size,
      decisions,
      proposals,
    },
    created,
    enriched,
    workflow_proposal_id: workflow,
  };
}

/** The items Work shows for the card's links: created, enriched, or both. */
export function onboardingItemIds(
  db: Db,
  sessionId: string,
  change: OnboardingChange | undefined,
): Set<string> {
  const row = db.sqlite
    .prepare('SELECT id, project_key FROM onboarding_sessions WHERE id = ?')
    .get(sessionId) as { id: string; project_key: string } | undefined;
  if (!row) {
    throw new ToolError('not_found', `No onboarding session ${sessionId}.`);
  }
  const c = changesOf(db, row);
  if (change === 'created') return c.created;
  if (change === 'enriched') return c.enriched;
  return new Set([...c.created, ...c.enriched]);
}

function sessionRow(db: Db, id: string): SessionRow | undefined {
  return db.sqlite.prepare('SELECT * FROM onboarding_sessions WHERE id = ?').get(id) as
    SessionRow | undefined;
}

function toSession(db: Db, row: SessionRow): OnboardingSession {
  const project = db.sqlite
    .prepare('SELECT name FROM projects WHERE key = ?')
    .get(row.project_key) as { name: string } | undefined;
  const changes = changesOf(db, row);
  return {
    id: row.id,
    project: row.project_key,
    project_name: project?.name ?? row.project_key,
    started_by: row.started_by,
    run_id: row.run_id,
    state: row.state,
    summary: row.summary,
    questions: JSON.parse(row.questions) as string[],
    changes: changes.counts,
    workflow_proposal_id: changes.workflow_proposal_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    reviewed_at: row.reviewed_at,
  };
}

/** Ready-for-review sessions in scope, newest first (Needs you; the badge counts them). */
export function readySessions(db: Db, scope: string): OnboardingSession[] {
  const rows = db.sqlite
    .prepare(
      `SELECT s.* FROM onboarding_sessions s JOIN projects p ON p.key = s.project_key
        WHERE p.deleted_at IS NULL AND s.state = 'ready_for_review' AND (@scope = 'all' OR s.project_key = @scope)
        ORDER BY s.finished_at DESC, s.id DESC`,
    )
    .all({ scope }) as SessionRow[];
  return rows.map((r) => toSession(db, r));
}

/** How many sessions are ready for review in scope (the for-you count). */
export function readySessionCount(db: Db, scope: string): number {
  return (
    db.sqlite
      .prepare(
        `SELECT count(*) AS n FROM onboarding_sessions s JOIN projects p ON p.key = s.project_key
          WHERE p.deleted_at IS NULL AND s.state = 'ready_for_review' AND (@scope = 'all' OR s.project_key = @scope)`,
      )
      .get({ scope }) as { n: number }
  ).n;
}

/** `created_by` as the UI shows it: the agent, until an onboarding of the project is reviewed. */
export const CREATED_BY_SQL = (p: string) =>
  `CASE WHEN EXISTS (SELECT 1 FROM onboarding_sessions s WHERE s.project_key = ${p}.key AND s.state = 'reviewed') THEN NULL ELSE ${p}.created_by END`;

/** The effective guide for `key` (the project's copy if it exists, else the default), filled in. */
function guideFor(db: Db, key: string, name: string | null): string {
  const live = db.sqlite
    .prepare('SELECT name FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(key) as { name: string } | undefined;
  const text = effectiveText(db, ONBOARDING_GUIDE_KEY, live ? key : null);
  if (text === null) {
    throw new ToolError(
      'unavailable',
      'The onboarding guide is not loaded yet; it loads when Docket starts. Ask the owner to restart Docket.',
    );
  }
  return text.replaceAll('{{KEY}}', key).replaceAll('{{NAME}}', live?.name ?? name ?? key);
}

function counts(db: Db, key: string) {
  const n = (sql: string) => (db.sqlite.prepare(sql).get({ key }) as { n: number }).n;
  return {
    items: n('SELECT count(*) AS n FROM items WHERE project_key = @key'),
    jira_items: n(
      'SELECT count(*) AS n FROM items WHERE project_key = @key AND jira_key IS NOT NULL',
    ),
    documents: n('SELECT count(*) AS n FROM documents WHERE project_key = @key'),
  };
}

function requireAgent(w: WriteContext, what: string): string {
  if (w.actor.kind !== 'agent' || !w.actor.client) {
    throw new ToolError('forbidden', `Only agents ${what}, through MCP.`);
  }
  return w.actor.client;
}

export function createOnboardingService(deps: ServiceDeps): OnboardingService {
  return {
    start(w, input) {
      const client = requireAgent(w, 'start onboarding');
      const sql = w.db.sqlite;
      const by = callerName(w.db, w.actor);
      const live = sql
        .prepare('SELECT key, name FROM projects WHERE key = ? AND deleted_at IS NULL')
        .get(input.key) as { key: string; name: string } | undefined;

      let project: { key: string; name: string; created: boolean };
      if (live) {
        project = { key: live.key, name: live.name, created: false };
      } else {
        const name = input.name?.trim();
        if (!name) {
          throw new ToolError(
            'validation',
            `No project ${input.key} yet: pass name to create it, or check the key with list_projects.`,
            { details: { fields: { name: 'is required to create a project' } } },
          );
        }
        const created = insertProject(w, deps.config.paths.docs, {
          key: input.key,
          name,
          color: input.color,
          created_by: by,
        });
        project = { key: created.key, name: created.name, created: true };
      }

      const open = sql
        .prepare(
          "SELECT * FROM onboarding_sessions WHERE project_key = ? AND state = 'in_progress'",
        )
        .get(project.key) as SessionRow | undefined;
      let sessionId: string;
      if (open) {
        if (open.client !== client) {
          throw new ToolError(
            'forbidden',
            `${open.started_by} is onboarding ${project.key} (since ${open.started_at}). Wait for it to finish, or ask the owner.`,
            {
              current: {
                session_id: open.id,
                started_by: open.started_by,
                started_at: open.started_at,
              },
            },
          );
        }
        // The same client again: its own session, unchanged (MCP_SPEC §5.11).
        sessionId = open.id;
      } else {
        sessionId = newId('onb', Date.parse(w.now));
        const runId =
          w.actor.run_id && sql.prepare('SELECT 1 FROM runs WHERE id = ?').get(w.actor.run_id)
            ? w.actor.run_id
            : null;
        w.insert('onboarding_sessions', {
          id: sessionId,
          project_key: project.key,
          started_by: by,
          client,
          run_id: runId,
          started_at: w.now,
          state: 'in_progress',
          questions: '[]',
        });
        w.event({
          type: 'onboarding.started',
          summary: `${by} started onboarding ${project.name} (${project.key})`,
          project_key: project.key,
          data: { onboarding_session: sessionId, created: project.created },
          objects: [
            { kind: 'onboarding', id: sessionId },
            { kind: 'project', id: project.key },
          ],
        });
      }
      return {
        project,
        session_id: sessionId,
        guide: guideFor(w.db, project.key, project.name),
        existing: counts(w.db, project.key),
      };
    },

    finish(w, input) {
      const client = requireAgent(w, 'finish onboarding');
      const row = sessionRow(w.db, input.session_id);
      if (!row) {
        throw new ToolError(
          'not_found',
          `No onboarding session ${input.session_id}. Pass the session_id onboard_project returned.`,
        );
      }
      if (row.client !== client) {
        throw new ToolError(
          'forbidden',
          `${row.started_by} started session ${row.id}; only that agent can finish it.`,
        );
      }
      if (row.state !== 'in_progress') {
        throw new ToolError(
          'conflict',
          `Session ${row.id} is already ${row.state === 'reviewed' ? 'reviewed' : 'ready for review'}. Stop here; the owner reviews it from Needs you.`,
          { current: toSession(w.db, row) },
        );
      }
      const changes = changesOf(w.db, row).counts;
      const summary = input.summary.trim();
      const questions = (input.questions ?? []).map((q) => q.trim());
      w.update('onboarding_sessions', row.id, {
        state: 'ready_for_review',
        summary,
        questions,
        finished_at: w.now,
      });
      const name =
        (
          w.db.sqlite.prepare('SELECT name FROM projects WHERE key = ?').get(row.project_key) as
            { name: string } | undefined
        )?.name ?? row.project_key;
      w.event({
        type: 'onboarding.finished',
        summary: `${callerName(w.db, w.actor)} finished onboarding ${name}: ${changes.created} created, ${changes.enriched} enriched, ready for your review`,
        project_key: row.project_key,
        data: { onboarding_session: row.id, changes, questions: questions.length },
        objects: [
          { kind: 'onboarding', id: row.id },
          { kind: 'project', id: row.project_key },
        ],
      });
      return { session_id: row.id, state: 'ready_for_review', changes };
    },

    guide(r, input) {
      return guideFor(r.db, input.project_key, input.project_name ?? null);
    },

    list(r, input) {
      const rows = r.db.sqlite
        .prepare(
          `SELECT s.* FROM onboarding_sessions s JOIN projects p ON p.key = s.project_key
            WHERE p.deleted_at IS NULL AND (@project IS NULL OR s.project_key = @project)
              AND (@state IS NULL OR s.state = @state)
            ORDER BY s.started_at DESC, s.id DESC`,
        )
        .all({ project: input.project ?? null, state: input.state ?? null }) as SessionRow[];
      return { sessions: rows.map((row) => toSession(r.db, row)) };
    },

    markReviewed(w, input) {
      if (w.actor.kind !== 'owner') {
        throw new ToolError('forbidden', 'Only the owner marks an onboarding reviewed.');
      }
      const row = sessionRow(w.db, input.id);
      const live =
        row &&
        w.db.sqlite
          .prepare('SELECT name FROM projects WHERE key = ? AND deleted_at IS NULL')
          .get(row.project_key);
      if (!row || !live) {
        throw new ToolError('not_found', `No onboarding session ${input.id}.`);
      }
      if (row.state === 'reviewed') return toSession(w.db, row);
      if (row.state === 'in_progress') {
        throw new ToolError(
          'conflict',
          `The onboarding of ${row.project_key} is still in progress; review it once ${row.started_by} finishes.`,
          { current: toSession(w.db, row) },
        );
      }
      w.update('onboarding_sessions', row.id, { state: 'reviewed', reviewed_at: w.now });
      const { name } = live as { name: string };
      w.event({
        type: 'onboarding.reviewed',
        summary: `You reviewed ${row.started_by}'s onboarding of ${name}`,
        project_key: row.project_key,
        data: { onboarding_session: row.id },
        objects: [
          { kind: 'onboarding', id: row.id },
          { kind: 'project', id: row.project_key },
        ],
      });
      return toSession(w.db, sessionRow(w.db, row.id)!);
    },
  };
}
