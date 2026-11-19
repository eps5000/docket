/**
 * Jira import (BUILD_SPEC §9, §7; FR-090–FR-092; UI_SPEC §9.2): the
 * `jiraImport` service. The reader, mapper, report and commit live in
 * server/src/import/jira/.
 *
 * An import is a session held **in memory only** (data-model ImportSession):
 * the Jira site, the target, the client holding the API token, the plan and
 * the report. Nothing about it is written until the owner commits.
 *
 * - `dryRun` checks the target, then reads Jira in the background and
 *   returns at once (`running`); the dialog polls `get` for progress
 *   ("Reading 140 of 512 issues…") and then the report (`ready`). The dry
 *   run writes nothing: no rows, no events, no documents, no files.
 * - `commit` writes everything in the caller's one write-path transaction
 *   (`committing`). After that transaction, attachment bytes download one
 *   at a time through `documents.stage` (streaming, sha256), each stored by
 *   its own small write; a failed one is listed and never undoes the
 *   import. The report document then gets a second version listing the
 *   attachment results, and the session is `committed`.
 * - `cancel` aborts a running read or download and drops the session.
 *
 * **The token** (constitution Principle VI; FR-092) lives only in the
 * session's `JiraClient` and in the in-memory list of values the secret
 * check matches. It is dropped on cancel, on a failed dry run, when the
 * import finishes, and when the session expires an hour after the dry run
 * started. It never reaches the write path, an event, a document, a log or
 * an error message, and no response carries it.
 */
import { existsSync, rmSync } from 'node:fs';
import { ToolError, type JiraImport, type JiraReport } from '@docket/shared';
import {
  JiraClient,
  JiraError,
  readJiraProject,
  siteOrigin,
  type FetchLike,
  type Sleep,
} from '../import/jira/client.js';
import {
  checkExistingTarget,
  commitPlan,
  reportDocument,
  type CommitResult,
} from '../import/jira/commit.js';
import { mapSnapshot } from '../import/jira/mapper.js';
import { buildReport } from '../import/jira/report.js';
import type { ImportPlan } from '../import/jira/types.js';
import type { Db } from '../db/client.js';
import { readContext, type JiraImportService, type ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import { newProjectKeyProblem } from './projects.js';
import { OWNER_ACTOR, WritePath } from './write.js';

/** The import session's lifetime, and so the token's (BUILD_SPEC §9 step 4). */
export const IMPORT_TTL_MS = 60 * 60 * 1000;

export interface JiraImportOptions {
  /** Default: the global `fetch`, looked up at call time. */
  fetch?: FetchLike;
  sleep?: Sleep;
  ttlMs?: number;
}

type Target = { kind: 'new'; key: string; name: string } | { kind: 'existing'; key: string };

interface Session {
  id: string;
  state: JiraImport['state'];
  jira_project: string;
  site: string;
  target: Target;
  progress: JiraImport['progress'];
  report: JiraReport | null;
  plan: ImportPlan | null;
  result: JiraImport['result'];
  error: string | null;
  expires_at: string;
  expired: boolean;
  /** Holds the token. Null once forgotten. */
  client: JiraClient | null;
  /** Values the secret check matches: the service's own, and the token. */
  known: string[];
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
}

const notFound = (id: string) =>
  new ToolError(
    'not_found',
    `No import ${id}: it finished, expired or was canceled. Run a new dry run.`,
  );

/** A message safe to show and keep: never a credential, a header or a body. */
function messageOf(err: unknown): string {
  if (err instanceof JiraError) return err.message;
  if (err instanceof ToolError) return err.message;
  return 'The dry run failed unexpectedly. Try again.';
}

export function createJiraImportService(
  deps: ServiceDeps,
  opts: JiraImportOptions = {},
): JiraImportService {
  const sessions = new Map<string, Session>();
  const ttl = opts.ttlMs ?? IMPORT_TTL_MS;
  const docsDir = () => deps.config.paths.docs;

  function forget(s: Session): void {
    s.client?.forget();
    s.client = null;
    s.known = [];
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
  }

  function expire(s: Session): void {
    s.expired = true;
    if (s.state === 'running') {
      s.abort.abort();
      s.state = 'canceled';
    }
    forget(s);
    // A commit still downloading keeps its session until it finishes.
    if (s.state !== 'committing') sessions.delete(s.id);
  }

  function find(id: string): Session {
    const s = sessions.get(id);
    if (!s) throw notFound(id);
    if (!s.expired && deps.clock().toISOString() >= s.expires_at) expire(s);
    if (!sessions.has(id)) throw notFound(id);
    return s;
  }

  function view(s: Session): JiraImport {
    return {
      import_id: s.id,
      state: s.state,
      jira_project: s.jira_project,
      target: { kind: s.target.kind, key: s.target.key },
      progress: s.progress ? { ...s.progress } : null,
      report: s.report,
      result: s.result,
      error: s.error,
      expires_at: s.expires_at,
    };
  }

  function ownerOnly(kind: string): void {
    if (kind !== 'owner') {
      throw new ToolError('forbidden', 'Only the owner imports from Jira, in Settings.');
    }
  }

  async function read(s: Session): Promise<void> {
    try {
      const snapshot = await readJiraProject(s.client!, s.jira_project, (p) => {
        s.progress = p;
      });
      if (s.state !== 'running') return;
      const plan = mapSnapshot(snapshot, { known: s.known });
      s.plan = plan;
      s.report = buildReport(plan);
      s.progress = null;
      s.state = 'ready';
    } catch (err) {
      if (s.state !== 'running') return;
      const canceled = err instanceof JiraError && err.kind === 'canceled';
      s.state = canceled ? 'canceled' : 'failed';
      s.error = canceled ? null : messageOf(err);
      s.progress = null;
      // The kind only: messages can name the site; never anything secret.
      if (!canceled) {
        deps.log(
          `jira import ${s.id}: dry run failed (${err instanceof JiraError ? `${err.kind}${err.status ? ` ${err.status}` : ''}` : 'error'})`,
        );
      }
      forget(s);
    }
  }

  /** After the commit's transaction: attachments, then the report's second version. */
  async function afterCommit(
    s: Session,
    db: Db,
    mutationId: string,
    done: CommitResult,
  ): Promise<void> {
    const committed = db.sqlite
      .prepare('SELECT 1 FROM events WHERE mutation_id = ? LIMIT 1')
      .get(mutationId);
    if (!committed) {
      // The transaction rolled back after the plan was written into it.
      s.state = 'ready';
      s.progress = null;
      return;
    }
    const plan = s.plan!;
    const documents = deps.services().documents;
    const write = new WritePath({
      db,
      clock: deps.clock,
      knownSecrets: () => deps.secrets.known(),
    });
    const failed: { name: string; reason: string }[] = [];
    let stored = 0;
    const all = plan.items.flatMap((item) => item.attachments.map((a) => ({ item, a })));
    for (const { item, a } of all) {
      const label = `${a.name} (${item.jira_key})`;
      const client = s.client;
      if (!client || client.forgotten) {
        failed.push({
          name: label,
          reason: s.expired ? 'the import session expired first' : 'the import was canceled first',
        });
        s.progress = { phase: 'attachments', done: (s.progress?.done ?? 0) + 1, total: all.length };
        continue;
      }
      let staged: Awaited<ReturnType<typeof documents.stage>> | null = null;
      try {
        const res = await client.attachment(a.jira_id);
        staged = await documents.stage(readContext(db, OWNER_ACTOR, deps.clock()), {
          name: a.name,
          type: a.mime,
          size: a.size,
          stream: () => res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        });
        const file = staged;
        write.run(
          {
            actor: OWNER_ACTOR,
            operation: 'jira.attachment',
            args: { import_id: s.id, item_id: done.ids.get(item.jira_key), name: a.name },
          },
          (w) =>
            documents.commitUpload(w, {
              fields: {
                item_id: done.ids.get(item.jira_key)!,
                name: a.name,
                kind: 'other',
                mime: a.mime,
              },
              staged: file,
            }),
        );
        stored++;
      } catch (err) {
        failed.push({
          name: label,
          reason:
            err instanceof JiraError || err instanceof ToolError
              ? err.message
              : 'the download failed',
        });
      } finally {
        if (staged && existsSync(staged.path)) rmSync(staged.path, { force: true });
      }
      s.progress = { phase: 'attachments', done: (s.progress?.done ?? 0) + 1, total: all.length };
    }

    if (all.length > 0) {
      try {
        write.run(
          { actor: OWNER_ACTOR, operation: 'jira.report', args: { import_id: s.id } },
          (w) =>
            documents.put(w, {
              project: done.project,
              name: done.report_name,
              kind: 'import_report' as 'other',
              mime: 'application/json',
              content_text: reportDocument({
                import_id: s.id,
                site: s.site,
                jira_project: s.jira_project,
                project: done.project,
                at: w.now,
                report: s.report!,
                ids: done.ids,
                attachments: { stored, failed },
              }),
            }),
        );
      } catch {
        deps.log(`jira import ${s.id}: the report's attachment results couldn't be stored`);
      }
    }
    s.result = {
      imported: plan.items.length,
      project: done.project,
      failed_attachments: failed,
      report_document_id: done.report_document_id,
    };
    s.progress = null;
    s.state = 'committed';
    forget(s);
    if (s.expired) sessions.delete(s.id);
  }

  return {
    dryRun(r, input) {
      ownerOnly(r.actor.kind);
      let site: string;
      try {
        site = siteOrigin(input.site_url);
      } catch (err) {
        throw new ToolError('validation', messageOf(err), {
          details: { fields: { site_url: 'must be https' } },
        });
      }
      const target: Target =
        input.target.kind === 'new'
          ? { kind: 'new', key: input.target.key, name: input.target.name }
          : { kind: 'existing', key: input.target.key };
      if (target.kind === 'new') {
        const problem = newProjectKeyProblem(r.db, docsDir(), target.key);
        if (problem) throw problem;
      } else {
        checkExistingTarget(r.db, target.key);
      }
      const now = deps.clock();
      const abort = new AbortController();
      const s: Session = {
        id: newId('imp', now.getTime()),
        state: 'running',
        jira_project: input.jira_project,
        site,
        target,
        progress: { phase: 'reading', done: 0, total: null },
        report: null,
        plan: null,
        result: null,
        error: null,
        expires_at: new Date(now.getTime() + ttl).toISOString(),
        expired: false,
        client: new JiraClient({
          site,
          email: input.email,
          token: input.api_token,
          fetch: opts.fetch,
          sleep: opts.sleep,
          signal: abort.signal,
        }),
        known: [...deps.secrets.known(), input.api_token, input.api_token.trim()].filter(
          (v, i, all) => v !== '' && all.indexOf(v) === i,
        ),
        abort,
        timer: null,
      };
      s.timer = setTimeout(() => expire(s), ttl);
      s.timer.unref?.();
      sessions.set(s.id, s);
      void read(s);
      return view(s);
    },

    get(_r, input) {
      return view(find(input.import_id));
    },

    commit(w, input) {
      ownerOnly(w.actor.kind);
      const s = find(input.import_id);
      if (s.state === 'running') {
        throw new ToolError(
          'validation',
          'The dry run is still running. Wait for the report, then import.',
        );
      }
      if (s.state === 'committing' || s.state === 'committed') {
        throw new ToolError('conflict', 'This import has already run. Open the project to see it.');
      }
      if (s.state !== 'ready' || !s.plan || !s.report || !s.client) {
        throw new ToolError('validation', 'This dry run did not finish. Run a new dry run.');
      }
      const done = commitPlan(w, {
        import_id: s.id,
        site: s.site,
        plan: s.plan,
        report: s.report,
        target: s.target,
        docsDir: docsDir(),
        documents: deps.services().documents,
        known: s.known,
      });
      const attachments = s.plan.items.reduce((n, i) => n + i.attachments.length, 0);
      s.state = 'committing';
      s.progress = { phase: 'attachments', done: 0, total: attachments };
      const db = w.db;
      const mutationId = w.mutationId;
      // After the write path's transaction has committed (or rolled back).
      setImmediate(() => {
        afterCommit(s, db, mutationId, done).catch(() => {
          s.state = 'committed';
          s.progress = null;
          s.result ??= {
            imported: s.plan?.items.length ?? 0,
            project: done.project,
            failed_attachments: [],
            report_document_id: done.report_document_id,
          };
          forget(s);
        });
      });
      return view(s);
    },

    cancel(_r, input) {
      const s = sessions.get(input.import_id);
      if (!s) throw notFound(input.import_id);
      s.abort.abort();
      if (s.state === 'running' || s.state === 'ready') s.state = 'canceled';
      // A commit's downloads still need the plan; they stop for lack of the token.
      if (s.state !== 'committing') s.plan = null;
      forget(s);
      sessions.delete(s.id);
    },
  };
}
