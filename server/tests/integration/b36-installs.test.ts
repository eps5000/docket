/**
 * Multi-client install and install state (owner decision 34; B36, tasks.md
 * T174–T176; BUILD_SPEC §5.17b; UI_SPEC §6.7b) through the owner's UI API,
 * as the Install dialog and Agent files call it:
 *
 * - one push install writes every ticked client: one response listing each
 *   client's files, one log row and event per client, and nothing written
 *   when any client's files would be refused;
 * - a new CLAUDE.md starts with `@AGENTS.md` when the repo had AGENTS.md
 *   before the install; an existing CLAUDE.md never gets it, and the check
 *   ignores it (it's outside the markers);
 * - the old single-`client` body still works; `client` and `clients` together
 *   is refused;
 * - a command install for both clients is one token and one bundle, with a
 *   wrapper that installs each client; the download logs both;
 * - `GET /api/install-state`: not installed, up to date, update available
 *   (an edit, a new version) and changed outside Docket (open drift), and the
 *   dialog's default clients from the folder's markers.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DOCKET_BEGIN } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { driftCheckOnce } from '../../src/jobs/sweeper.js';
import { insertProject, tempDir, type TempDir } from '../helpers.js';
import { createTestServer, parseSetCookies, type TestServer } from './harness.js';

type S = Record<string, unknown>;
interface ClientPart {
  client: string;
  install_id: string;
  files: { path: string; change?: string; note?: string }[];
}
interface StatePart {
  client: string;
  state: string;
  outdated: string[];
  drift_ids: string[];
  markers: boolean | null;
  install: S | null;
}

let s: TestServer | undefined;
let tmp: TempDir | undefined;
afterEach(async () => {
  await s?.cleanup();
  tmp?.cleanup();
  s = undefined;
  tmp = undefined;
});

async function start(push = true) {
  tmp = tempDir('docket-b36-');
  const root = join(tmp.dir, 'code');
  mkdirSync(join(root, 'recipes', '.git'), { recursive: true });
  s = createTestServer({ env: push ? { DOCKET_PUSH_ROOT: root } : {}, log: () => {} });
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
  return { api, repo: join(root, 'recipes'), server: s };
}

const state = async (api: Awaited<ReturnType<typeof start>>['api'], query = 'project=RCP') => {
  const r = await api('GET', `/api/install-state?${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { clients: StatePart[]; defaults: string[]; target_kind: string };
};
const of = (st: { clients: StatePart[] }, client: string) =>
  st.clients.find((c) => c.client === client)!;

/** Unpack a tar.gz in memory: name → text. */
function untar(gz: Buffer): Map<string, string> {
  const tar = gunzipSync(gz);
  const out = new Map<string, string>();
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim(), 8);
    out.set(name, tar.toString('utf8', at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('one install for several clients (decision 34)', () => {
  it('pushes both clients, lists each one’s files, and imports an existing AGENTS.md', async () => {
    const { api, repo, server } = await start();
    const own = '# Gameflow rules\n\nKeep scenes small.\n';
    writeFileSync(join(repo, 'AGENTS.md'), own);

    const before = await state(api, `project=RCP&path=${encodeURIComponent(repo)}`);
    // AGENTS.md is a Codex marker: only Codex is ticked by default.
    expect(before.defaults).toEqual(['codex']);
    expect(of(before, 'codex')).toMatchObject({ state: 'not_installed', markers: true });
    expect(of(before, 'claude')).toMatchObject({ state: 'not_installed', markers: false });

    const r = await api('POST', '/api/installs', {
      clients: ['claude', 'codex'],
      target_kind: 'repo',
      project: 'RCP',
      method: 'push',
      path: repo,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const parts = r.body.clients as ClientPart[];
    expect(parts.map((p) => p.client)).toEqual(['claude', 'codex']);
    expect(r.body.install_id).toBe(parts[0]!.install_id);
    const claudeFiles = parts[0]!.files.map((f) => f.path);
    expect(claudeFiles).toContain('CLAUDE.md');
    expect(claudeFiles).toContain('.mcp.json');
    expect(claudeFiles).toContain('.claude/.docket-manifest.json');
    expect(parts[1]!.files.map((f) => f.path)).toContain('.codex/config.toml');
    expect(parts[0]!.files.find((f) => f.path === 'CLAUDE.md')).toMatchObject({
      change: 'created',
      note: expect.stringContaining('@AGENTS.md'),
    });
    // The old field still lists every file.
    expect((r.body.result as { files: unknown[] }).files).toHaveLength(
      parts[0]!.files.length + parts[1]!.files.length,
    );

    expect(
      readFileSync(join(repo, 'CLAUDE.md'), 'utf8').startsWith(`@AGENTS.md\n\n${DOCKET_BEGIN}\n`),
    ).toBe(true);
    expect(
      readFileSync(join(repo, 'AGENTS.md'), 'utf8').startsWith(`${own}\n${DOCKET_BEGIN}`),
    ).toBe(true);

    // One log row and one event per client.
    const log = (await api('GET', '/api/installs?project=RCP')).body.installs as S[];
    expect(log.map((row) => row.client).sort()).toEqual(['claude', 'codex']);
    const events = server.runtime.db.sqlite
      .prepare(`SELECT summary FROM events WHERE type = 'install.recorded' ORDER BY seq`)
      .all() as { summary: string }[];
    expect(events.map((e) => e.summary)).toEqual([
      expect.stringMatching(/^Installed by push: Claude Code, RCP's repo/),
      expect.stringMatching(/^Installed by push: Codex, RCP's repo/),
    ]);

    // Both up to date; the import line is outside the markers, so the check ignores it.
    const after = await state(api, `project=RCP&path=${encodeURIComponent(repo)}`);
    expect(after.clients.map((c) => c.state)).toEqual(['up_to_date', 'up_to_date']);
    expect(after.defaults).toEqual(['claude', 'codex']);
    const check = await api('POST', `/api/installs/${parts[0]!.install_id}/check`);
    expect(check.body.state).toBe('up_to_date');
  });

  it('never adds the import to an existing CLAUDE.md, or without an earlier AGENTS.md', async () => {
    const { api, repo } = await start();
    // Neither file yet: CLAUDE.md is created without the import, even though Codex adds AGENTS.md.
    await api('POST', '/api/installs', {
      clients: ['claude', 'codex'],
      target_kind: 'repo',
      project: 'RCP',
      method: 'push',
      path: repo,
    });
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').startsWith(DOCKET_BEGIN)).toBe(true);
    // CLAUDE.md exists now: reinstalling never adds it.
    await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      method: 'push',
      path: repo,
    });
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).not.toContain('@AGENTS.md');
  });

  it('writes nothing when one client’s files would be refused', async () => {
    const { api, repo } = await start();
    const damaged = `# Mine\n${DOCKET_BEGIN}\nno end marker\n`;
    writeFileSync(join(repo, 'AGENTS.md'), damaged);
    const r = await api('POST', '/api/installs', {
      clients: ['claude', 'codex'],
      target_kind: 'repo',
      project: 'RCP',
      method: 'push',
      path: repo,
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('damaged Docket section');
    expect(() => readFileSync(join(repo, 'CLAUDE.md'))).toThrow();
    expect(((await api('GET', '/api/installs')).body.installs as S[]).length).toBe(0);
  });

  it('keeps the single-client body, and refuses client with clients', async () => {
    const { api } = await start(false);
    const one = await api('POST', '/api/installs', {
      client: 'codex',
      target_kind: 'repo',
      project: 'RCP',
      method: 'command',
    });
    expect(one.status).toBe(200);
    expect((one.body.clients as ClientPart[]).map((p) => p.client)).toEqual(['codex']);
    const both = await api('POST', '/api/installs', {
      client: 'codex',
      clients: ['claude'],
      target_kind: 'repo',
      method: 'command',
    });
    expect(both.status).toBe(400);
    const twice = await api('POST', '/api/installs', {
      clients: ['claude', 'claude'],
      target_kind: 'repo',
      method: 'command',
    });
    expect(twice.status).toBe(400);
  });

  it('a command for both clients is one token and one bundle with a wrapper; the download logs both', async () => {
    const { api, server } = await start(false);
    const r = await api('POST', '/api/installs', {
      clients: ['claude', 'codex'],
      target_kind: 'repo',
      project: 'RCP',
      method: 'command',
    });
    const parts = r.body.clients as (ClientPart & { check_command?: S })[];
    expect(parts.every((p) => p.check_command)).toBe(true);
    expect(parts[0]!.files.find((f) => f.path === 'CLAUDE.md')!.note).toContain('@AGENTS.md');
    const token = /\/install\/([A-Za-z0-9_-]{43})/.exec(
      (r.body.command as { bash: string }).bash,
    )![1]!;
    // Neither row stores the token's own hash: each has its `token:client` hash.
    const rows = server.runtime.db.sqlite.prepare('SELECT token_sha256 FROM installs').all() as {
      token_sha256: string;
    }[];
    expect(new Set(rows.map((x) => x.token_sha256)).size).toBe(2);

    const res = await server.request(`/install/${token}`);
    expect(res.status).toBe(200);
    const files = untar(Buffer.from(await res.arrayBuffer()));
    expect(files.has('docket-install/install.sh')).toBe(true);
    expect(files.get('docket-install/install.sh')).toContain('DOCKET_CHECK_ONLY=1');
    expect(files.has('docket-install/claude/install.sh')).toBe(true);
    expect(files.has('docket-install/codex/install.ps1')).toBe(true);
    expect(files.has('docket-install/claude/files/.claude/.docket-manifest.json')).toBe(true);
    expect(files.has('docket-install/codex/files/.codex/.docket-manifest.json')).toBe(true);
    expect(files.get('docket-install/claude/install.sh')).toContain('@AGENTS.md');
    expect(files.get('docket-install/codex/install.sh')).not.toContain('@AGENTS.md');

    const log = (await api('GET', '/api/installs?project=RCP')).body.installs as S[];
    expect(log).toHaveLength(2);
    expect((await server.request(`/install/${token}`)).status).toBe(404);
  });
});

describe('install state (decision 34)', () => {
  it('not installed → up to date → update available → changed outside Docket', async () => {
    const { api, repo } = await start();
    const none = await state(api);
    expect(none.target_kind).toBe('repo');
    expect(none.clients.map((c) => c.state)).toEqual(['not_installed', 'not_installed']);
    // No folder to look at, nothing installed: both ticked.
    expect(none.defaults).toEqual(['claude', 'codex']);
    expect(of(none, 'claude').markers).toBeNull();

    await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      method: 'push',
      path: repo,
    });
    expect(of(await state(api), 'claude').state).toBe('up_to_date');
    expect(of(await state(api), 'codex').state).toBe('not_installed');
    expect((await state(api)).defaults).toEqual(['claude']);

    // A project copy of a skill: Docket would now install another version.
    const file = (await api('GET', '/api/agent-files/skill:docket-worker?project=RCP')).body as {
      layers: Record<string, { versions: { content: string }[] } | null>;
    };
    const text = file.layers.bundled!.versions[0]!.content;
    const put = await api('PUT', '/api/agent-files/skill:docket-worker', {
      layer: 'project',
      project: 'RCP',
      content: `${text}\nOne more rule.\n`,
      expected_version: 0,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const outdated = of(await state(api), 'claude');
    expect(outdated).toMatchObject({
      state: 'update_available',
      outdated: ['skill:docket-worker'],
    });

    // An edit in the repo, found by the scheduled check: changed outside Docket wins.
    const skill = join(repo, '.claude/skills/docket-planner/SKILL.md');
    writeFileSync(skill, `${readFileSync(skill, 'utf8')}\nLocal note.\n`);
    await driftCheckOnce(s!.runtime);
    const changed = of(await state(api), 'claude');
    expect(changed.state).toBe('changed');
    expect(changed.drift_ids.length).toBe(1);
  });

  it('without a project nothing is installed; markers only inside the push folder', async () => {
    const { api, repo } = await start();
    const none = await state(api, '');
    expect(none.target_kind).toBe('repo');
    expect(none.clients.every((c) => c.state === 'not_installed' && c.markers === null)).toBe(true);
    mkdirSync(join(repo, '.claude'));
    const inside = await state(api, `project=RCP&path=${encodeURIComponent(repo)}`);
    expect(inside.defaults).toEqual(['claude']);
    const outside = await state(api, `project=RCP&path=${encodeURIComponent('C:/elsewhere/x')}`);
    expect(outside.clients.every((c) => c.markers === null)).toBe(true);
    expect(outside.defaults).toEqual(['claude', 'codex']);
  });
});
