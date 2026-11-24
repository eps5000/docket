/**
 * The bundled delivery and producer skills (owner decisions 52 and 55; B66,
 * B71) through the real install paths: an install made before one shipped shows
 * "update available" and nothing worse, a reinstall adds it, and the check and
 * drift cover it. The real uninstall, in each shell, is in
 * b64-install-scope.test.ts.
 *
 * Every install goes into a temporary folder.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { driftCheckOnce } from '../../src/jobs/sweeper.js';
import { insertProject, tempDir, type TempDir } from '../helpers.js';
import { createTestServer, parseSetCookies, type TestServer } from './harness.js';

type S = Record<string, unknown>;
type Client = 'claude' | 'codex';
const CASES = (['docket-delivery', 'docket-producer'] as const).flatMap((skill) =>
  (['claude', 'codex'] as const).map((client) => ({ skill, client })),
);

let s: TestServer | undefined;
let tmp: TempDir | undefined;
afterEach(async () => {
  await s?.cleanup();
  tmp?.cleanup();
  s = undefined;
  tmp = undefined;
});

async function start() {
  tmp = tempDir('docket-b66-');
  const root = join(tmp.dir, 'code');
  const repo = join(root, 'recipes');
  mkdirSync(join(repo, '.git'), { recursive: true });
  s = createTestServer({ env: { DOCKET_PUSH_ROOT: root }, log: () => {} });
  insertProject(s.runtime.db, 'RCP');
  syncBundledFiles(s.runtime);
  const res = await s.request('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  const cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${cookies.docket_csrf!.value}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await s!.request(path, {
      method,
      headers: {
        cookie,
        ...(method === 'GET' ? {} : { 'x-docket-csrf': cookies.docket_csrf!.value }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as S };
  };
  return { api, repo, server: s };
}

type Api = Awaited<ReturnType<typeof start>>['api'];

async function push(api: Api, repo: string, client: Client) {
  const r = await api('POST', '/api/installs', {
    client,
    target_kind: 'repo',
    project: 'RCP',
    method: 'push',
    path: repo,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.install_id as string;
}

const stateOf = async (api: Api, client: string) => {
  const r = await api('GET', '/api/install-state?project=RCP');
  return (r.body.clients as { client: string; state: string; outdated: string[] }[]).find(
    (c) => c.client === client,
  )!;
};

/** Make an install look as if it ran before this skill shipped. */
function forgetSkill(server: TestServer, id: string, repo: string, client: Client, skill: string) {
  const KEY = `skill:${skill}`;
  const row = server.runtime.db.sqlite
    .prepare('SELECT manifest FROM installs WHERE id = ?')
    .get(id) as { manifest: string };
  const manifest = JSON.parse(row.manifest) as Record<string, unknown>;
  expect(manifest[KEY]).toBeDefined();
  delete manifest[KEY];
  server.runtime.db.sqlite
    .prepare('UPDATE installs SET manifest = ? WHERE id = ?')
    .run(JSON.stringify(manifest), id);
  const dir = join(repo, `.${client}/skills/${skill}`);
  rmSync(dir, { recursive: true });
  const file = join(repo, `.${client}`, '.docket-manifest.json');
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !l.includes(`"key":"${KEY}"`));
  writeFileSync(file, lines.join('\n'));
  server.runtime.db.sqlite.prepare('DELETE FROM drift').run();
  return dir;
}

describe.each(CASES)('$skill for $client (decisions 52 and 55)', ({ skill, client }) => {
  const KEY = `skill:${skill}`;
  const dirIn = (repo: string) => join(repo, `.${client}/skills/${skill}`);

  it('installs with the others and passes the check', async () => {
    const { api, repo } = await start();
    const id = await push(api, repo, client);
    const text = readFileSync(join(dirIn(repo), 'SKILL.md'), 'utf8');
    expect(text).toContain(`name: ${skill}`);
    expect((await stateOf(api, client)).state).toBe('up_to_date');
    const check = await api('POST', `/api/installs/${id}/check`, {});
    expect(check.body.files).toEqual([]);
  });

  it('an install from before it shipped shows update available, and a reinstall adds it', async () => {
    const { api, repo, server } = await start();
    const id = await push(api, repo, client);
    const dir = forgetSkill(server, id, repo, client, skill);

    expect(await stateOf(api, client)).toMatchObject({
      state: 'update_available',
      outdated: [KEY],
    });
    // A file the older install never wrote is not drift.
    await driftCheckOnce(server.runtime);
    expect(server.runtime.db.sqlite.prepare('SELECT count(*) AS n FROM drift').get()).toEqual({
      n: 0,
    });
    expect((await stateOf(api, client)).state).toBe('update_available');

    await push(api, repo, client);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
    expect((await stateOf(api, client)).state).toBe('up_to_date');
  });

  it('an edit to it is drift', async () => {
    const { api, repo, server } = await start();
    await push(api, repo, client);
    const file = join(dirIn(repo), 'SKILL.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nLocal note.\n`);
    await driftCheckOnce(server.runtime);
    const rows = server.runtime.db.sqlite
      .prepare('SELECT file_key, change FROM drift')
      .all() as S[];
    expect(rows).toEqual([{ file_key: KEY, change: 'edited' }]);
    expect((await stateOf(api, client)).state).toBe('changed');
  });
});
