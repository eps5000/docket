/**
 * The step dialog's contents (owner decision 33; B34, tasks.md T172;
 * UI_SPEC §6.3.1a; BUILD_SPEC §7): `GET /api/items/:id/work/:stepId`.
 *
 * - returns the step with its details and the history exactly as `get_step`
 *   reads them (one implementation), for any step on the item, a removed
 *   one included;
 * - `jira_site` is the normalised origin the project's latest Jira import
 *   recorded, and nothing else from the import (no path, no account);
 *   null for a project that wasn't imported;
 * - unknown steps are `404 not_found`; it reads, so it records nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import { expectOk, startHarness, type ContractHarness } from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type S = Record<string, unknown>;

async function ownerGet() {
  const app = h!.server.app;
  const res = await app.request(`${ORIGIN}/api/session/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: h!.server.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  const cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${cookies.docket_csrf!.value}`;
  return async (path: string) => {
    const r = await app.request(`${ORIGIN}${path}`, { headers: { cookie } });
    return { status: r.status, body: (await r.json()) as S };
  };
}

const eventCount = () =>
  (h!.server.runtime.db.sqlite.prepare('SELECT count(*) AS n FROM events').get() as { n: number })
    .n;

/** Record a Jira import on RCP the way the commit does (its `project.updated` event). */
function recordImport(site: string) {
  const sql = h!.server.runtime.db.sqlite;
  const at = (
    sql.prepare(`SELECT created_at FROM projects WHERE key = 'RCP'`).get() as {
      created_at: string;
    }
  ).created_at;
  sql
    .prepare(
      `INSERT INTO events (at, actor_kind, project_key, type, summary, data, mutation_id)
       VALUES (?, 'owner', 'RCP', 'project.updated', 'Imported', ?, 'mut_test')`,
    )
    .run(at, JSON.stringify({ import_id: 'imp_1', jira_project: 'GF', site }));
}

describe('GET /api/items/:id/work/:stepId (decision 33; UI_SPEC §6.3.1a)', () => {
  it('returns get_step’s step and history, and jira_site null for a project not imported', async () => {
    h = await startHarness();
    const { run_id } = expectOk(await h.call('claim_lead', { id: 'RCP-17', agent_label: 'w1' }))
      .structured as { run_id: string };
    const work = expectOk(
      await h.call('set_plan', {
        id: 'RCP-17',
        run_id,
        steps: [{ text: 'Reproduce', details: '## Steps\n\n1. Reload', source: 'GF-12' }],
      }),
    ).structured.work as { id: string }[];
    const id = work[0]!.id;
    expectOk(await h.call('update_step', { id: 'RCP-17', run_id, step_id: id, state: 'current' }));
    const viaTool = expectOk(await h.call('get_step', { id: 'RCP-17', step_id: id })).structured;
    const get = await ownerGet();
    const before = eventCount();
    const r = await get(`/api/items/RCP-17/work/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.step).toEqual(viaTool.step);
    expect(r.body.history).toEqual(viaTool.history);
    expect(r.body).toMatchObject({
      step: { details_md: '## Steps\n\n1. Reload', details_version: 1, source: 'GF-12' },
      jira_site: null,
    });
    expect((r.body.history as { change: string }[]).map((e) => e.change)).toEqual([
      'added',
      'state',
    ]);
    expect(eventCount()).toBe(before);
  });

  it('jira_site is the origin of the latest import, normalised; unknown steps are not_found', async () => {
    h = await startHarness();
    const steps = (
      expectOk(await h.call('get_item', { id: 'RCP-14' })).structured.item as {
        checklist: { work: { id: string }[] };
      }
    ).checklist.work;
    const get = await ownerGet();
    recordImport('https://old.atlassian.net');
    recordImport('https://gameflow.atlassian.net/jira/software/projects/GF?x=1#top');
    const r = await get(`/api/items/RCP-14/work/${steps[0]!.id}`);
    expect(r.status).toBe(200);
    expect(r.body.jira_site).toBe('https://gameflow.atlassian.net');

    const missing = await get('/api/items/RCP-14/work/wst_nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'not_found' } });
    // A step on another item is not this item's.
    const other = await get(`/api/items/RCP-17/work/${steps[0]!.id}`);
    expect(other.status).toBe(404);
  });

  it('a recorded site that is not https is ignored', async () => {
    h = await startHarness();
    const steps = (
      expectOk(await h.call('get_item', { id: 'RCP-14' })).structured.item as {
        checklist: { work: { id: string }[] };
      }
    ).checklist.work;
    recordImport('http://insecure.example.com');
    const r = await (await ownerGet())(`/api/items/RCP-14/work/${steps[0]!.id}`);
    expect(r.body.jira_site).toBeNull();
  });
});
