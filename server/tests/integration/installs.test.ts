/**
 * US13 install and check (tasks.md T155, T156; owner decision 29; FR-124 to
 * FR-127; BUILD_SPEC §5.17) through the owner's UI API and `GET
 * /install/:token`, exactly as Settings → Agent setup and the copy-paste
 * command call them:
 * - the bundle's contents and layout, the manifest, the rendered block;
 * - the single-use token: used, expired and unknown are the same 404, and
 *   the token is never in a row, an event, a log line or a file on the volume;
 * - push into a temporary push root: what is written, the marked section
 *   (nothing outside it changes), refusals, the check (edited, missing,
 *   extra) and a reinstall that restores the files;
 * - the push folder's status and *Test*, set and unset.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { TASKLITE_BEGIN, TASKLITE_END } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { insertProject, tempDir, type TempDir } from '../helpers.js';
import { createTestServer, parseSetCookies, type TestServer } from './harness.js';

type S = Record<string, unknown>;

let s: TestServer | undefined;
let tmp: TempDir | undefined;
const logs: string[] = [];
afterEach(async () => {
  await s?.cleanup();
  tmp?.cleanup();
  s = undefined;
  tmp = undefined;
  logs.length = 0;
});

const SKILLS = [
  'tasklite-coordinator',
  'tasklite-lead-subagents',
  'tasklite-planner',
  'tasklite-review-packet',
  'tasklite-worker',
];

/** A server with RCP and the shipped agent files; `push` mounts a temporary push root. */
async function start(opts: { push?: 'set' | 'missing'; hostPath?: string } = {}) {
  tmp = tempDir('tasklite-pushroot-');
  const root = join(tmp.dir, 'code');
  mkdirSync(join(root, 'recipes'), { recursive: true });
  const env: Record<string, string> = {};
  if (opts.push) env.TASKLITE_PUSH_ROOT = opts.push === 'set' ? root : join(tmp.dir, 'not-mounted');
  if (opts.hostPath) env.TASKLITE_PUSH_HOST_PATH = opts.hostPath;
  s = createTestServer({ env, log: (line) => logs.push(line) });
  insertProject(s.runtime.db, 'RCP');
  syncBundledFiles(s.runtime);
  const res = await s.request('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  const cookie = `tl_owner=${cookies.tl_owner!.value}; tl_csrf=${cookies.tl_csrf!.value}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await s!.request(path, {
      method,
      headers: {
        cookie,
        ...(method === 'GET' ? {} : { 'x-tasklite-csrf': cookies.tl_csrf!.value }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as S };
  };
  return { api, root, server: s };
}

/** Unpack a tar.gz in memory: name → text (ustar, as our writer writes it). */
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

const tokenOf = (cmd: string) => /\/install\/([A-Za-z0-9_-]{43})/.exec(cmd)![1]!;
const sha = (t: string) => createHash('sha256').update(t.replace(/\r/g, ''), 'utf8').digest('hex');

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function eventsOf(server: TestServer) {
  return server.runtime.db.sqlite
    .prepare(`SELECT * FROM events WHERE type = 'install.recorded' ORDER BY seq`)
    .all() as { summary: string; data: string; actor_kind: string; project_key: string | null }[];
}

describe('command install: the bundle and the single-use token (T155)', () => {
  it('builds the bundle for Claude Code in a repo, logs it on download, and refuses reuse', async () => {
    const { api, server } = await start();
    const created = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      method: 'command',
    });
    expect(created.status).toBe(200);
    const body = created.body as {
      install_id: string;
      command: { powershell: string; bash: string };
      check_command: { powershell: string; bash: string };
      expires_at: string;
    };
    expect(body.install_id).toMatch(/^ins_/);
    const token = tokenOf(body.command.bash);
    expect(tokenOf(body.command.powershell)).toBe(token);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(body.command.bash).toContain(`'http://127.0.0.1:7420/install/${token}'`);
    expect(body.check_command.bash).toContain('.claude/.tasklite-manifest.json');
    expect(Date.parse(body.expires_at) - server.clock.current.getTime()).toBe(10 * 60_000);

    // Not in the log until the token is used; one event, "Install command created".
    expect((await api('GET', '/api/installs')).body).toEqual({ installs: [] });
    expect(eventsOf(server).map((e) => e.summary)).toEqual([
      'Install command created: Claude Code, RCP’s repo, 6 files'.replace('’', "'"),
    ]);

    // The download: no session, the system as actor.
    const res = await server.request(`/install/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="tasklite-${body.install_id}.tar.gz"`,
    );
    const bundle = Buffer.from(await res.arrayBuffer());
    const files = untar(bundle);
    expect([...files.keys()].sort()).toEqual(
      [
        ...SKILLS.map((n) => `tasklite-install/files/.claude/skills/${n}/SKILL.md`),
        'tasklite-install/files/.claude/.tasklite-manifest.json',
        // tasklite-check, next to the manifest (decision 30, B27b).
        'tasklite-install/files/.claude/tasklite-check.sh',
        'tasklite-install/files/.claude/tasklite-check.ps1',
        'tasklite-install/files.txt',
        'tasklite-install/block.md',
        'tasklite-install/install.sh',
        'tasklite-install/install.ps1',
      ].sort(),
    );
    expect(files.get('tasklite-install/files.txt')).toBe(
      [
        ...SKILLS.map((n) => `.claude/skills/${n}/SKILL.md`),
        '.claude/.tasklite-manifest.json',
        '.claude/tasklite-check.sh',
        '.claude/tasklite-check.ps1',
        '',
      ].join('\n'),
    );
    // Each skill is the effective version's text, byte for byte.
    const worker = readFileSync(
      join(__dirname, '../../../skills/tasklite-worker/SKILL.md'),
      'utf8',
    );
    expect(files.get('tasklite-install/files/.claude/skills/tasklite-worker/SKILL.md')).toBe(
      worker,
    );
    // The block: the comment stripped; the shipped block has no placeholders (B25).
    const block = files.get('tasklite-install/block.md')!;
    expect(block.startsWith('## Work tracking: Task Lite')).toBe(true);
    expect(block).toContain('`tasklite-worker` skill');
    expect(block).not.toContain('{{');
    expect(block).not.toContain('<!--');
    // The scripts write CLAUDE.md, in the repo's root.
    expect(files.get('tasklite-install/install.sh')).toContain('instr="$base/CLAUDE.md"');
    expect(files.get('tasklite-install/install.ps1')).toContain("Join-Path $Base 'CLAUDE.md'");
    // ASCII only, so Windows PowerShell 5.1 reads it the same in any code page.
    for (const script of ['install.ps1', 'install.sh']) {
      const text = files.get(`tasklite-install/${script}`)!;
      expect(
        [...text].every((c) => c.charCodeAt(0) < 0x80),
        script,
      ).toBe(true);
    }
    // The manifest: the install ID, the client and target, and each file's key, path, version and sha256.
    const manifest = JSON.parse(
      files.get('tasklite-install/files/.claude/.tasklite-manifest.json')!,
    ) as {
      install_id: string;
      client: string;
      target: string;
      project: string;
      files: { key: string; path: string; version_id: string; sha256: string }[];
    };
    expect(manifest).toMatchObject({
      install_id: body.install_id,
      client: 'claude',
      target: 'repo',
      project: 'RCP',
    });
    expect(manifest.files.map((f) => [f.key, f.path])).toEqual([
      ...SKILLS.map((n) => [`skill:${n}`, `.claude/skills/${n}/SKILL.md`]),
      ['agents_block', 'CLAUDE.md'],
    ]);
    expect(manifest.files.find((f) => f.key === 'skill:tasklite-worker')!.sha256).toBe(sha(worker));
    expect(manifest.files.find((f) => f.key === 'agents_block')!.sha256).toBe(sha(block));
    // One file per line, for the bash check.
    for (const f of manifest.files) {
      expect(files.get('tasklite-install/files/.claude/.tasklite-manifest.json')).toContain(
        JSON.stringify({ key: f.key, path: f.path, version_id: f.version_id, sha256: f.sha256 }),
      );
    }

    // Logged now, with every file's version (FR-126).
    const log = (await api('GET', '/api/installs?project=RCP')).body as {
      installs: {
        id: string;
        method: string;
        file_count: number;
        token_used_at: string;
        manifest: S[];
      }[];
    };
    expect(log.installs).toHaveLength(1);
    expect(log.installs[0]).toMatchObject({
      id: body.install_id,
      method: 'command',
      file_count: 6,
      token_used_at: server.clock.current.toISOString(),
    });
    expect(log.installs[0]!.manifest).toEqual(
      manifest.files.map(({ key, version_id, sha256 }) => ({ key, version_id, sha256 })),
    );
    const events = eventsOf(server);
    expect(events.map((e) => e.summary)).toEqual([
      "Install command created: Claude Code, RCP's repo, 6 files",
      "Installed by command: Claude Code, RCP's repo, 6 files",
    ]);
    expect(events.map((e) => (JSON.parse(e.data) as S).stage)).toEqual([
      'command_issued',
      'downloaded',
    ]);
    expect(events[1]!.actor_kind).toBe('system');

    // Single use: the same token again is 404, like an unknown one.
    const again = await server.request(`/install/${token}`);
    expect(again.status).toBe(404);
    const unknown = await server.request(`/install/${'B'.repeat(43)}`);
    expect(unknown.status).toBe(404);
    const [a, u] = [await again.json(), await unknown.json()];
    expect(a).toEqual(u);
    expect(a).toEqual({
      error: {
        code: 'not_found',
        message:
          'This install link is unknown, expired or already used. Make a new install command in Agent files.',
      },
    });
    expect(eventsOf(server)).toHaveLength(2);

    // The token is nowhere: not in any row, event or log line, nor any file on the volume.
    const db = server.runtime.db.sqlite;
    for (const { name } of db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
      expect(dump, name).not.toContain(token);
    }
    expect(logs.join('\n')).not.toContain(token);
    server.runtime.db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    for (const f of filesUnder(server.dataDir)) {
      expect(readFileSync(f).includes(token), f).toBe(false);
    }
    expect(bundle.includes(token)).toBe(false);
    expect([...files.values()].some((t) => t.includes(token))).toBe(false);
  });

  it('expires after 10 minutes: the same 404, and nothing is logged', async () => {
    const { api, server } = await start();
    const created = await api('POST', '/api/installs', {
      client: 'codex',
      target_kind: 'user',
      method: 'command',
    });
    const token = tokenOf((created.body.command as { bash: string }).bash);
    server.clock.advance(10 * 60_000);
    const res = await server.request(`/install/${token}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: S }).error.code).toBe('not_found');
    expect((await api('GET', '/api/installs')).body).toEqual({ installs: [] });
    expect(eventsOf(server)).toHaveLength(1);
  });

  it('lays out a user-wide Codex install (no project)', async () => {
    const { api, server } = await start();
    const created = await api('POST', '/api/installs', {
      client: 'codex',
      target_kind: 'user',
      method: 'command',
    });
    const cmd = created.body.command as { bash: string; powershell: string };
    expect(cmd.bash).toContain('d="$HOME"');
    expect(cmd.bash).not.toContain('.git');
    const res = await server.request(`/install/${tokenOf(cmd.bash)}`);
    const files = untar(Buffer.from(await res.arrayBuffer()));
    expect(files.has('tasklite-install/files/.codex/skills/tasklite-worker/SKILL.md')).toBe(true);
    expect(files.has('tasklite-install/files/.codex/.tasklite-manifest.json')).toBe(true);
    expect(files.get('tasklite-install/install.sh')).toContain('instr="$base/.codex/AGENTS.md"');
    expect(files.get('tasklite-install/block.md')).toMatch(/^## Work tracking: Task Lite/);
    expect(files.get('tasklite-install/block.md')).not.toContain('{{');
    expect(eventsOf(server).at(-1)!.summary).toBe(
      'Installed by command: Codex, user-wide, 6 files',
    );
  });

  it('sends a project override as that project’s effective version', async () => {
    const { api, server } = await start();
    const put = await api(
      'PUT',
      `/api/agent-files/${encodeURIComponent('skill:tasklite-worker')}`,
      {
        layer: 'project',
        project: 'RCP',
        content: '# RCP worker\n',
        expected_version: 0,
        note: 'Ours.',
      },
    );
    expect(put.status).toBe(200);
    const created = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      method: 'command',
    });
    const res = await server.request(
      `/install/${tokenOf((created.body.command as { bash: string }).bash)}`,
    );
    const files = untar(Buffer.from(await res.arrayBuffer()));
    expect(files.get('tasklite-install/files/.claude/skills/tasklite-worker/SKILL.md')).toBe(
      '# RCP worker\n',
    );
  });

  it('refuses an unknown project, and a command path with control characters', async () => {
    const { api } = await start();
    const unknown = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'NOPE',
      method: 'command',
    });
    expect(unknown.status).toBe(404);
    const bad = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      method: 'command',
      path: 'C:/code\u0007x',
    });
    expect(bad.status).toBe(400);
  });

  it('a command install has no UI check: it says to run the check command', async () => {
    const { api, server } = await start({ push: 'set' });
    const created = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      method: 'command',
    });
    const id = created.body.install_id as string;
    expect((await api('POST', `/api/installs/${id}/check`, {})).status).toBe(404);
    await server.request(`/install/${tokenOf((created.body.command as { bash: string }).bash)}`);
    const check = await api('POST', `/api/installs/${id}/check`, {});
    expect(check.status).toBe(400);
    expect((check.body.error as S).message).toMatch(/Run its check command/);
  });
});

describe('push install and check (T156)', () => {
  const PRE = '# Recipes\r\n\r\nOur own rules — keep them.\r\n\r\n## Build\r\n`pnpm build`\r\n';

  it('writes the files, merges only the marked section, logs it, and checks edited, missing and extra', async () => {
    const { api, root, server } = await start({ push: 'set', hostPath: 'C:/Users/me/code' });
    const repo = join(root, 'recipes');
    writeFileSync(join(repo, 'CLAUDE.md'), PRE);
    writeFileSync(join(repo, 'README.md'), 'readme');

    const first = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      method: 'push',
      path: 'C:\\Users\\me\\code\\recipes',
    });
    expect(first.status).toBe(200);
    expect(first.body.result).toEqual({
      files: [
        ...SKILLS.map((n) => ({ path: `.claude/skills/${n}/SKILL.md`, change: 'created' })),
        { path: 'CLAUDE.md', change: 'updated' },
        { path: '.claude/.tasklite-manifest.json', change: 'created' },
        { path: '.claude/tasklite-check.sh', change: 'created' },
        { path: '.claude/tasklite-check.ps1', change: 'created' },
      ],
    });
    expect(first.body.command).toBeUndefined();
    const id = first.body.install_id as string;

    // Nothing outside the markers changed: the old CLAUDE.md is an exact prefix.
    const claude = readFileSync(join(repo, 'CLAUDE.md'));
    expect(claude.subarray(0, Buffer.byteLength(PRE)).equals(Buffer.from(PRE))).toBe(true);
    const tail = claude.subarray(Buffer.byteLength(PRE)).toString('utf8');
    expect(tail.startsWith(`\n${TASKLITE_BEGIN}\n## Work tracking: Task Lite`)).toBe(true);
    expect(tail.endsWith(`${TASKLITE_END}\n`)).toBe(true);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('readme');
    const manifest = JSON.parse(
      readFileSync(join(repo, '.claude/.tasklite-manifest.json'), 'utf8'),
    ) as S;
    expect(manifest.install_id).toBe(id);

    const log = (await api('GET', '/api/installs')).body.installs as S[];
    expect(log).toEqual([
      expect.objectContaining({
        id,
        method: 'push',
        path: 'C:\\Users\\me\\code\\recipes',
        file_count: 6,
      }),
    ]);
    expect(eventsOf(server).map((e) => e.summary)).toEqual([
      "Installed by push: Claude Code, RCP's repo at C:\\Users\\me\\code\\recipes, 6 files",
    ]);

    // Up to date.
    const clean = await api('POST', `/api/installs/${id}/check`, {});
    expect(clean.body).toMatchObject({ install_id: id, state: 'up_to_date', files: [] });

    // A Windows checkout's CRLF is not an edit.
    const plannerPath = join(repo, '.claude/skills/tasklite-planner/SKILL.md');
    writeFileSync(plannerPath, readFileSync(plannerPath, 'utf8').replace(/\n/g, '\r\n'));
    expect((await api('POST', `/api/installs/${id}/check`, {})).body.state).toBe('up_to_date');

    // Edit one, delete one, edit the block, add an extra tasklite-* folder and an unrelated skill.
    const workerPath = join(repo, '.claude/skills/tasklite-worker/SKILL.md');
    writeFileSync(workerPath, `${readFileSync(workerPath, 'utf8')}\nLocal tweak.\n`);
    rmSync(join(repo, '.claude/skills/tasklite-coordinator/SKILL.md'));
    writeFileSync(
      join(repo, 'CLAUDE.md'),
      readFileSync(join(repo, 'CLAUDE.md'), 'utf8').replace(
        '## Work tracking',
        '## Work tracking (ours)',
      ),
    );
    mkdirSync(join(repo, '.claude/skills/tasklite-old'));
    mkdirSync(join(repo, '.claude/skills/my-own-skill'));
    const check = await api('POST', `/api/installs/${id}/check`, {});
    expect(check.status).toBe(200);
    const files = check.body.files as {
      key: string | null;
      path: string;
      state: string;
      local_content?: string;
    }[];
    expect(check.body.state).toBe('differs');
    expect(files.map(({ key, path, state }) => ({ key, path, state }))).toEqual([
      {
        key: 'skill:tasklite-coordinator',
        path: '.claude/skills/tasklite-coordinator/SKILL.md',
        state: 'missing',
      },
      {
        key: 'skill:tasklite-worker',
        path: '.claude/skills/tasklite-worker/SKILL.md',
        state: 'edited',
      },
      { key: 'agents_block', path: 'CLAUDE.md', state: 'edited' },
      { key: null, path: '.claude/skills/tasklite-old/', state: 'extra' },
    ]);
    expect(files[1]!.local_content).toContain('Local tweak.');
    expect(files[2]!.local_content!.startsWith('## Work tracking (ours)')).toBe(true);
    expect(files[0]!.local_content).toBeUndefined();

    // Reinstall: restores the edited and missing files; deletes nothing (the extra folder stays).
    const second = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      method: 'push',
      path: '/' + 'recipes',
    });
    expect(second.status).toBe(400); // "/recipes" is absolute and not under either path
    const again = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      method: 'push',
      path: 'recipes',
    });
    expect(again.status).toBe(200);
    const changes = Object.fromEntries(
      (again.body.result as { files: { path: string; change: string }[] }).files.map((f) => [
        f.path,
        f.change,
      ]),
    );
    expect(changes).toMatchObject({
      '.claude/skills/tasklite-coordinator/SKILL.md': 'created',
      '.claude/skills/tasklite-worker/SKILL.md': 'updated',
      '.claude/skills/tasklite-planner/SKILL.md': 'updated',
      '.claude/skills/tasklite-review-packet/SKILL.md': 'unchanged',
      'CLAUDE.md': 'updated',
      '.claude/.tasklite-manifest.json': 'updated',
    });
    const recheck = await api('POST', `/api/installs/${again.body.install_id as string}/check`, {});
    expect(recheck.body.files).toEqual([
      { key: null, path: '.claude/skills/tasklite-old/', state: 'extra' },
    ]);
    expect(existsSync(join(repo, '.claude/skills/my-own-skill'))).toBe(true);
    // Still byte-identical outside the markers after the replace.
    expect(
      readFileSync(join(repo, 'CLAUDE.md'))
        .subarray(0, Buffer.byteLength(PRE))
        .equals(Buffer.from(PRE)),
    ).toBe(true);
  });

  it('refuses a damaged section, and writes nothing', async () => {
    const { api, root } = await start({ push: 'set' });
    const repo = join(root, 'recipes');
    writeFileSync(join(repo, 'CLAUDE.md'), `# Mine\n${TASKLITE_END}\n`);
    const res = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      method: 'push',
      path: 'recipes',
    });
    expect(res.status).toBe(400);
    expect((res.body.error as S).message).toMatch(/CLAUDE\.md has a damaged Task Lite section/);
    expect(readdirSync(repo)).toEqual(['CLAUDE.md']);
    expect((await api('GET', '/api/installs')).body).toEqual({ installs: [] });
  });

  it.each([
    ['".."', '../outside'],
    ['an absolute path outside', '/etc'],
    ['a folder that does not exist', 'nope'],
  ])('refuses %s, writes nothing and logs nothing', async (_name, path) => {
    const { api, root } = await start({ push: 'set' });
    const res = await api('POST', '/api/installs', {
      client: 'codex',
      target_kind: 'repo',
      method: 'push',
      path,
    });
    expect(res.status).toBe(400);
    expect((res.body.error as S).code).toBe('validation');
    expect(filesUnder(root)).toEqual([]);
    expect((await api('GET', '/api/installs')).body).toEqual({ installs: [] });
  });

  it('a user-wide push writes into .codex/ under the folder given', async () => {
    const { api, root } = await start({ push: 'set' });
    const res = await api('POST', '/api/installs', {
      client: 'codex',
      target_kind: 'user',
      method: 'push',
      path: 'recipes',
    });
    expect(res.status).toBe(200);
    expect(statSync(join(root, 'recipes/.codex/AGENTS.md')).isFile()).toBe(true);
    expect((res.body.result as { files: { path: string }[] }).files.map((f) => f.path)).toContain(
      '~/.codex/AGENTS.md',
    );
  });
});

describe('the push folder: status and Test', () => {
  it('unset: not configured, push refused with the reason, Test says why', async () => {
    const { api } = await start();
    expect((await api('GET', '/api/push-target')).body).toEqual({
      configured: false,
      writable: null,
      container_path: null,
      host_path: null,
    });
    const test = await api('POST', '/api/push-target/test', {});
    expect(test.body).toEqual({
      ok: false,
      message:
        "Push install is off: TASKLITE_PUSH_ROOT isn't set. Mount a folder and set it, then restart Task Lite.",
    });
    const push = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      method: 'push',
      path: 'recipes',
    });
    expect(push.status).toBe(400);
    expect((push.body.error as S).message).toMatch(/TASKLITE_PUSH_ROOT isn't set/);
  });

  it('set: writable, and Test writes and removes a probe file', async () => {
    const { api, root } = await start({ push: 'set', hostPath: 'C:/Users/me/code' });
    expect((await api('GET', '/api/push-target')).body).toEqual({
      configured: true,
      writable: true,
      container_path: root,
      host_path: 'C:/Users/me/code',
    });
    const test = await api('POST', '/api/push-target/test', {});
    expect(test.body).toEqual({
      ok: true,
      message: 'Wrote and removed a test file in C:/Users/me/code. Push install works.',
    });
    expect(readdirSync(root)).toEqual(['recipes']);
  });

  it('set but not mounted: not writable, and Test says so', async () => {
    const { api } = await start({ push: 'missing' });
    expect((await api('GET', '/api/push-target')).body).toMatchObject({
      configured: true,
      writable: false,
    });
    const test = await api('POST', '/api/push-target/test', {});
    expect(test.body.ok).toBe(false);
    expect(test.body.message).toMatch(/isn't mounted/);
  });
});
