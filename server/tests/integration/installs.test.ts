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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  DOCKET_BEGIN,
  DOCKET_END,
  connectionCanonical,
  connectionEntry,
  mergeConnection,
} from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { readBundledFiles, syncBundledFiles } from '../../src/jobs/bundled.js';
import { SYSTEM_ACTOR } from '../../src/domain/write.js';
import { waitPs1, waitSh } from '../../src/domain/wait-scripts.js';
import { driftCheckOnce } from '../../src/jobs/sweeper.js';
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
  'docket-coordinator',
  'docket-delivery',
  'docket-lead-subagents',
  'docket-planner',
  'docket-producer',
  'docket-review-packet',
  'docket-worker',
];

/**
 * Each shipped skill's files in install order (decision 66): its `SKILL.md`,
 * then its `references/<topic>.md`, keyed `skill:<name>--<topic>`.
 */
const SKILL_FILES: { key: string; rel: string }[] = SKILLS.flatMap((n) => {
  const refs = join(__dirname, '../../../skills', n, 'references');
  const topics = existsSync(refs)
    ? readdirSync(refs)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -'.md'.length))
        .sort()
    : [];
  return [
    { key: `skill:${n}`, rel: `skills/${n}/SKILL.md` },
    ...topics.map((t) => ({ key: `skill:${n}--${t}`, rel: `skills/${n}/references/${t}.md` })),
  ];
});
/** The skill files, the block, four scripts and the connection file. */
const FILE_COUNT = SKILL_FILES.length + 6;

/** A server with RCP and the shipped agent files; `push` mounts a temporary push root. */
const MCP_URL = 'http://127.0.0.1:7420/mcp';

async function start(
  opts: { push?: 'set' | 'missing'; hostPath?: string; env?: Record<string, string> } = {},
) {
  tmp = tempDir('docket-pushroot-');
  const root = join(tmp.dir, 'code');
  mkdirSync(join(root, 'recipes'), { recursive: true });
  const env: Record<string, string> = { ...opts.env };
  if (opts.push) env.DOCKET_PUSH_ROOT = opts.push === 'set' ? root : join(tmp.dir, 'not-mounted');
  if (opts.hostPath) env.DOCKET_PUSH_HOST_PATH = opts.hostPath;
  s = createTestServer({ env, log: (line) => logs.push(line) });
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
    expect(body.check_command.bash).toContain('.claude/.docket-manifest.json');
    expect(Date.parse(body.expires_at) - server.clock.current.getTime()).toBe(10 * 60_000);

    // Not in the log until the token is used; one event, "Install command created".
    expect((await api('GET', '/api/installs')).body).toEqual({ installs: [] });
    expect(eventsOf(server).map((e) => e.summary)).toEqual([
      `Install command created: Claude Code, RCP's repo, ${FILE_COUNT} files`,
    ]);

    // The download: no session, the system as actor.
    const res = await server.request(`/install/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="docket-${body.install_id}.tar.gz"`,
    );
    const bundle = Buffer.from(await res.arrayBuffer());
    const files = untar(bundle);
    expect([...files.keys()].sort()).toEqual(
      [
        ...SKILL_FILES.map((f) => `docket-install/files/.claude/${f.rel}`),
        'docket-install/files/.claude/.docket-manifest.json',
        // docket-check, next to the manifest (decision 30, B27b), and docket-wait (decision 40).
        'docket-install/files/.claude/docket-check.sh',
        'docket-install/files/.claude/docket-check.ps1',
        'docket-install/files/.claude/docket-wait.sh',
        'docket-install/files/.claude/docket-wait.ps1',
        // docket-update (decision 56): in the manifest too.
        'docket-install/files/.claude/docket-update.sh',
        'docket-install/files/.claude/docket-update.ps1',
        'docket-install/files.txt',
        'docket-install/block.md',
        // The connection file's docket entry (decision 32).
        'docket-install/connection.txt',
        'docket-install/install.sh',
        'docket-install/install.ps1',
      ].sort(),
    );
    expect(files.get('docket-install/files.txt')).toBe(
      [
        ...SKILL_FILES.map((f) => `.claude/${f.rel}`),
        '.claude/docket-wait.sh',
        '.claude/docket-wait.ps1',
        '.claude/docket-update.sh',
        '.claude/docket-update.ps1',
        '.claude/.docket-manifest.json',
        '.claude/docket-check.sh',
        '.claude/docket-check.ps1',
        '',
      ].join('\n'),
    );
    // Each skill is the effective version's text, byte for byte.
    const worker = readFileSync(join(__dirname, '../../../skills/docket-worker/SKILL.md'), 'utf8');
    expect(files.get('docket-install/files/.claude/skills/docket-worker/SKILL.md')).toBe(worker);
    // The block: the comment stripped; the shipped block has no placeholders (B25).
    const block = files.get('docket-install/block.md')!;
    expect(block.startsWith('## Work tracking: Docket')).toBe(true);
    expect(block).toContain('`docket-worker` skill');
    expect(block).not.toContain('{{');
    expect(block).not.toContain('<!--');
    // The scripts write CLAUDE.md, in the repo's root.
    expect(files.get('docket-install/install.sh')).toContain('instr="$base/CLAUDE.md"');
    expect(files.get('docket-install/install.ps1')).toContain("Join-Path $Base 'CLAUDE.md'");
    // ASCII only, so Windows PowerShell 5.1 reads it the same in any code page.
    for (const script of ['install.ps1', 'install.sh']) {
      const text = files.get(`docket-install/${script}`)!;
      expect(
        [...text].every((c) => c.charCodeAt(0) < 0x80),
        script,
      ).toBe(true);
    }
    // The manifest: the install ID, the client and target, and each file's key, path, version and sha256.
    const manifest = JSON.parse(
      files.get('docket-install/files/.claude/.docket-manifest.json')!,
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
      ...SKILL_FILES.map((f) => [f.key, `.claude/${f.rel}`]),
      ['agents_block', 'CLAUDE.md'],
      // docket-wait (decision 40): in the manifest, so Check and drift cover it.
      ['script:docket-wait.sh', '.claude/docket-wait.sh'],
      ['script:docket-wait.ps1', '.claude/docket-wait.ps1'],
      ['script:docket-update.sh', '.claude/docket-update.sh'],
      ['script:docket-update.ps1', '.claude/docket-update.ps1'],
      ['connection', '.mcp.json'],
    ]);
    expect(files.get('docket-install/files/.claude/docket-wait.sh')).toBe(waitSh());
    expect(files.get('docket-install/files/.claude/docket-wait.ps1')).toBe(waitPs1());
    for (const script of [waitSh(), waitPs1()]) {
      expect([...script].every((c) => c.charCodeAt(0) < 0x80)).toBe(true);
    }
    // The connection file (decision 32): the docket entry, no secret, the entry's canonical hash.
    expect(files.get('docket-install/connection.txt')).toBe(
      connectionEntry('claude', MCP_URL, false),
    );
    const conn = manifest.files.find((f) => f.key === 'connection')!;
    expect(conn.version_id).toBe('connection:local');
    expect(conn.sha256).toBe(sha(connectionCanonical('claude', MCP_URL, false)));
    for (const text of files.values()) {
      expect(text).not.toContain(server.runtime.secrets.agentToken());
      expect(text).not.toContain(server.runtime.secrets.ownerKey());
    }
    // The install steps merge it into .mcp.json.
    expect(files.get('docket-install/install.sh')).toContain('cf="$base/.mcp.json"');
    expect(files.get('docket-install/install.ps1')).toContain("Join-Path $Base '.mcp.json'");
    expect(manifest.files.find((f) => f.key === 'skill:docket-worker')!.sha256).toBe(sha(worker));
    expect(manifest.files.find((f) => f.key === 'agents_block')!.sha256).toBe(sha(block));
    // One file per line, for the bash check.
    for (const f of manifest.files) {
      expect(files.get('docket-install/files/.claude/.docket-manifest.json')).toContain(
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
      file_count: FILE_COUNT,
      token_used_at: server.clock.current.toISOString(),
    });
    expect(log.installs[0]!.manifest).toEqual(
      manifest.files.map(({ key, version_id, sha256 }) => ({ key, version_id, sha256 })),
    );
    const events = eventsOf(server);
    expect(events.map((e) => e.summary)).toEqual([
      `Install command created: Claude Code, RCP's repo, ${FILE_COUNT} files`,
      `Installed by command: Claude Code, RCP's repo, ${FILE_COUNT} files`,
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
      target_kind: 'repo',
      project: 'RCP',
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

  it('refuses a new user-wide install, or one with no project (decision 50)', async () => {
    const { api, server } = await start();
    for (const body of [
      { client: 'codex', target_kind: 'user', method: 'command' },
      { client: 'claude', target_kind: 'user', project: 'RCP', method: 'command' },
    ]) {
      const res = await api('POST', '/api/installs', body);
      expect(res.status).toBe(400);
      expect((res.body.error as S).code).toBe('validation');
      expect(JSON.stringify(res.body.error)).toContain('no longer supported');
    }
    const none = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      method: 'command',
    });
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body.error)).toContain('choose a project');
    expect(eventsOf(server)).toHaveLength(0);
  });

  it('a user-wide token issued before decision 50 still downloads, with no connection file', async () => {
    const { server } = await start();
    const db = server.runtime.db.sqlite;
    const versions = db
      .prepare(
        `SELECT f.key AS key, v.id AS id FROM agent_file_versions v
         JOIN agent_files f ON f.id = v.file_id
         WHERE f.layer = 'bundled' AND (f.key LIKE 'skill:docket-%' OR f.key = 'agents_block')`,
      )
      .all() as { key: string; id: string }[];
    const manifest = Object.fromEntries(
      versions.map((v) => [v.key, { version_id: v.id, sha256: '0'.repeat(64) }]),
    );
    const token = 'L'.repeat(43);
    const now = server.clock.now().toISOString();
    db.prepare(
      `INSERT INTO installs (id, at, client, target_kind, project_key, path, method, manifest,
         token_sha256, token_expires_at, created_at, updated_at)
       VALUES ('ins_legacytoken', ?, 'codex', 'user', NULL, NULL, 'command', ?, ?, ?, ?, ?)`,
    ).run(
      now,
      JSON.stringify(manifest),
      createHash('sha256').update(token, 'utf8').digest('hex'),
      new Date(server.clock.now().getTime() + 60_000).toISOString(),
      now,
      now,
    );
    const res = await server.request(`/install/${token}`);
    expect(res.status).toBe(200);
    const files = untar(Buffer.from(await res.arrayBuffer()));
    expect(files.has('docket-install/files/.codex/skills/docket-worker/SKILL.md')).toBe(true);
    expect(files.get('docket-install/install.sh')).toContain('instr="$base/.codex/AGENTS.md"');
    expect(files.has('docket-install/connection.txt')).toBe(false);
    expect(files.get('docket-install/files/.codex/.docket-manifest.json')).not.toContain(
      'connection',
    );
  });

  it('sends a project override as that project’s effective version', async () => {
    const { api, server } = await start();
    const put = await api('PUT', `/api/agent-files/${encodeURIComponent('skill:docket-worker')}`, {
      layer: 'project',
      project: 'RCP',
      content: '# RCP worker\n',
      expected_version: 0,
      note: 'Ours.',
    });
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
    expect(files.get('docket-install/files/.claude/skills/docket-worker/SKILL.md')).toBe(
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
      project: 'RCP',
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
      project: 'RCP',
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

  it('a reinstall removes an unmodified reference Docket no longer ships and keeps an edited one (decision 66)', async () => {
    const { api, root, server } = await start({ push: 'set', hostPath: 'C:/Users/me/code' });
    const repo = join(root, 'recipes');
    const push = () =>
      api('POST', '/api/installs', {
        client: 'claude',
        target_kind: 'repo',
        project: 'RCP',
        method: 'push',
        path: 'C:\\Users\\me\\code\\recipes',
      });
    expect((await push()).status).toBe(200);
    const refs = join(repo, '.claude/skills/docket-worker/references');
    expect(readFileSync(join(refs, 'exit-reports.md'), 'utf8')).toBe(
      readFileSync(
        join(__dirname, '../../../skills/docket-worker/references/exit-reports.md'),
        'utf8',
      ),
    );
    writeFileSync(join(refs, 'asking.md'), 'Our own asking rules.\n');

    const shipped = readBundledFiles(join(__dirname, '../../..')).files;
    const dropped = ['skill:docket-worker--waiting', 'skill:docket-worker--asking'];
    server.runtime.write.run({ actor: SYSTEM_ACTOR, operation: 'test.sync', args: {} }, (w) =>
      server.runtime.services.agentFiles.syncBundled(w, {
        files: shipped.filter((f) => !dropped.includes(f.key)),
      }),
    );
    const second = await push();
    expect(second.status).toBe(200);
    const result = (second.body.result as { files: { path: string; change: string }[] }).files;
    expect(result).toContainEqual({
      path: '.claude/skills/docket-worker/references/waiting.md',
      change: 'removed',
    });
    expect(result).toContainEqual({
      path: '.claude/skills/docket-worker/references/asking.md',
      change: 'kept_edited',
    });
    expect(existsSync(join(refs, 'waiting.md'))).toBe(false);
    expect(readFileSync(join(refs, 'asking.md'), 'utf8')).toBe('Our own asking rules.\n');
    const keys = (
      JSON.parse(readFileSync(join(repo, '.claude/.docket-manifest.json'), 'utf8')) as {
        files: { key: string }[];
      }
    ).files.map((f) => f.key);
    expect(keys).not.toContain(dropped[0]);
    expect(keys).not.toContain(dropped[1]);
    expect(keys).toContain('skill:docket-worker--exit-reports');
    // A third push has nothing left to remove.
    const third = (await push()).body.result as { files: { path: string; change: string }[] };
    expect(third.files.filter((f) => f.change === 'removed')).toEqual([]);
  });

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
        ...SKILL_FILES.map((f) => ({ path: `.claude/${f.rel}`, change: 'created' })),
        { path: 'CLAUDE.md', change: 'updated' },
        { path: '.claude/docket-wait.sh', change: 'created' },
        { path: '.claude/docket-wait.ps1', change: 'created' },
        { path: '.claude/docket-update.sh', change: 'created' },
        { path: '.claude/docket-update.ps1', change: 'created' },
        { path: '.mcp.json', change: 'created' },
        { path: '.claude/.docket-manifest.json', change: 'created' },
        { path: '.claude/docket-check.sh', change: 'created' },
        { path: '.claude/docket-check.ps1', change: 'created' },
      ],
    });
    expect(first.body.command).toBeUndefined();
    expect(readFileSync(join(repo, '.mcp.json'), 'utf8')).toBe(
      mergeConnection('claude', null, connectionEntry('claude', MCP_URL, false)).text,
    );
    const id = first.body.install_id as string;

    // Nothing outside the markers changed: the old CLAUDE.md is an exact prefix.
    const claude = readFileSync(join(repo, 'CLAUDE.md'));
    expect(claude.subarray(0, Buffer.byteLength(PRE)).equals(Buffer.from(PRE))).toBe(true);
    const tail = claude.subarray(Buffer.byteLength(PRE)).toString('utf8');
    expect(tail.startsWith(`\n${DOCKET_BEGIN}\n## Work tracking: Docket`)).toBe(true);
    expect(tail.endsWith(`${DOCKET_END}\n`)).toBe(true);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('readme');
    const manifest = JSON.parse(
      readFileSync(join(repo, '.claude/.docket-manifest.json'), 'utf8'),
    ) as S;
    expect(manifest.install_id).toBe(id);

    const log = (await api('GET', '/api/installs')).body.installs as S[];
    expect(log).toEqual([
      expect.objectContaining({
        id,
        method: 'push',
        path: 'C:\\Users\\me\\code\\recipes',
        file_count: FILE_COUNT,
      }),
    ]);
    expect(eventsOf(server).map((e) => e.summary)).toEqual([
      `Installed by push: Claude Code, RCP's repo at C:\\Users\\me\\code\\recipes, ${FILE_COUNT} files`,
    ]);

    // Up to date.
    const clean = await api('POST', `/api/installs/${id}/check`, {});
    expect(clean.body).toMatchObject({ install_id: id, state: 'up_to_date', files: [] });

    // A Windows checkout's CRLF is not an edit.
    const plannerPath = join(repo, '.claude/skills/docket-planner/SKILL.md');
    writeFileSync(plannerPath, readFileSync(plannerPath, 'utf8').replace(/\n/g, '\r\n'));
    expect((await api('POST', `/api/installs/${id}/check`, {})).body.state).toBe('up_to_date');

    // Edit one, delete one, edit the block, add an extra docket-* folder and an unrelated skill.
    const workerPath = join(repo, '.claude/skills/docket-worker/SKILL.md');
    writeFileSync(workerPath, `${readFileSync(workerPath, 'utf8')}\nLocal tweak.\n`);
    rmSync(join(repo, '.claude/skills/docket-coordinator/SKILL.md'));
    writeFileSync(
      join(repo, 'CLAUDE.md'),
      readFileSync(join(repo, 'CLAUDE.md'), 'utf8').replace(
        '## Work tracking',
        '## Work tracking (ours)',
      ),
    );
    mkdirSync(join(repo, '.claude/skills/docket-old'));
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
        key: 'skill:docket-coordinator',
        path: '.claude/skills/docket-coordinator/SKILL.md',
        state: 'missing',
      },
      {
        key: 'skill:docket-worker',
        path: '.claude/skills/docket-worker/SKILL.md',
        state: 'edited',
      },
      { key: 'agents_block', path: 'CLAUDE.md', state: 'edited' },
      { key: null, path: '.claude/skills/docket-old/', state: 'extra' },
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
      '.claude/skills/docket-coordinator/SKILL.md': 'created',
      '.claude/skills/docket-worker/SKILL.md': 'updated',
      '.claude/skills/docket-planner/SKILL.md': 'updated',
      '.claude/skills/docket-review-packet/SKILL.md': 'unchanged',
      'CLAUDE.md': 'updated',
      '.claude/.docket-manifest.json': 'updated',
    });
    const recheck = await api('POST', `/api/installs/${again.body.install_id as string}/check`, {});
    expect(recheck.body.files).toEqual([
      { key: null, path: '.claude/skills/docket-old/', state: 'extra' },
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
    writeFileSync(join(repo, 'CLAUDE.md'), `# Mine\n${DOCKET_END}\n`);
    const res = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      method: 'push',
      path: 'recipes',
    });
    expect(res.status).toBe(400);
    expect((res.body.error as S).message).toMatch(/CLAUDE\.md has a damaged Docket section/);
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
      project: 'RCP',
      method: 'push',
      path,
    });
    expect(res.status).toBe(400);
    expect((res.body.error as S).code).toBe('validation');
    expect(filesUnder(root)).toEqual([]);
    expect((await api('GET', '/api/installs')).body).toEqual({ installs: [] });
  });

  it('a user-wide push is refused and writes nothing (decision 50)', async () => {
    const { api, root } = await start({ push: 'set' });
    const res = await api('POST', '/api/installs', {
      client: 'codex',
      target_kind: 'user',
      method: 'push',
      path: 'recipes',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toContain('no longer supported');
    expect(filesUnder(root)).toEqual([]);
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
        "Push install is off: DOCKET_PUSH_ROOT isn't set. Mount a folder and set it, then restart Docket.",
    });
    const push = await api('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      method: 'push',
      path: 'recipes',
    });
    expect(push.status).toBe(400);
    expect((push.body.error as S).message).toMatch(/DOCKET_PUSH_ROOT isn't set/);
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

describe('connection files (decision 32; BUILD_SPEC §5.17a; T168)', () => {
  const repoInstall = (client: 'claude' | 'codex') => ({
    client,
    target_kind: 'repo',
    project: 'RCP',
    method: 'push',
    path: 'recipes',
  });

  it('push merges the docket server into .mcp.json, keeps the other servers, and checks only its entry', async () => {
    const { api, root, server } = await start({ push: 'set' });
    const repo = join(root, 'recipes');
    const BEFORE =
      '{\r\n  "mcpServers": {\r\n    "github": { "command": "gh-mcp" }\r\n  },\r\n  "x": true\r\n}\r\n';
    writeFileSync(join(repo, '.mcp.json'), BEFORE);
    const res = await api('POST', '/api/installs', repoInstall('claude'));
    expect(res.status).toBe(200);
    expect((res.body.result as { files: S[] }).files).toContainEqual({
      path: '.mcp.json',
      change: 'updated',
    });
    const id = res.body.install_id as string;
    const mcp = readFileSync(join(repo, '.mcp.json'), 'utf8');
    expect(mcp).toBe(
      mergeConnection('claude', BEFORE, connectionEntry('claude', MCP_URL, false)).text,
    );
    expect(mcp.endsWith(BEFORE.slice(BEFORE.indexOf('{', 5) + 1))).toBe(true);
    expect(mcp).not.toContain(server.runtime.secrets.agentToken());

    // Another server edited: up to date, and the drift check finds nothing.
    writeFileSync(join(repo, '.mcp.json'), mcp.replace('"gh-mcp"', '"gh-mcp", "args": ["-v"]'));
    expect((await api('POST', `/api/installs/${id}/check`, {})).body).toMatchObject({
      state: 'up_to_date',
    });
    expect((await driftCheckOnce(server.runtime)).drift_ids).toEqual([]);

    // The docket entry edited: the check says so with the entry's text, and so does drift.
    writeFileSync(join(repo, '.mcp.json'), mcp.replace(':7420/mcp', ':7499/mcp'));
    const check = await api('POST', `/api/installs/${id}/check`, {});
    expect(check.body.files).toEqual([
      {
        key: 'connection',
        path: '.mcp.json',
        state: 'edited',
        local_content: '{"type":"http","url":"http://127.0.0.1:7499/mcp"}',
      },
    ]);
    const found = await driftCheckOnce(server.runtime);
    expect(found.drift_ids).toHaveLength(1);
    const drift = (await api('GET', '/api/drift?state=open')).body.drift as S[];
    expect(drift).toEqual([
      expect.objectContaining({
        file_key: 'connection',
        change: 'edited',
        sent_version_id: 'connection:local',
      }),
    ]);
    // Adopt is refused (it isn't an agent file); Restore puts the entry back.
    const adopt = await api('POST', `/api/drift/${drift[0]!.id as string}/adopt`, {});
    expect(adopt.status).toBe(400);
    const restore = await api('POST', `/api/drift/${drift[0]!.id as string}/restore`, {});
    expect(restore.status).toBe(200);
    const restored = readFileSync(join(repo, '.mcp.json'), 'utf8');
    expect(restored).toContain('"url": "http://127.0.0.1:7420/mcp"');
    expect(restored).toContain('"gh-mcp"');

    // Removing the docket entry reads as missing.
    writeFileSync(join(repo, '.mcp.json'), BEFORE);
    const latest = (await api('GET', '/api/installs')).body.installs as S[];
    const gone = await api('POST', `/api/installs/${latest[0]!.id as string}/check`, {});
    expect(gone.body.files).toEqual([{ key: 'connection', path: '.mcp.json', state: 'missing' }]);
  });

  it('refuses an invalid .mcp.json or config.toml, and writes nothing at all', async () => {
    const { api, root } = await start({ push: 'set' });
    const repo = join(root, 'recipes');
    writeFileSync(join(repo, '.mcp.json'), '{"mcpServers": {"a": {}},}');
    const bad = await api('POST', '/api/installs', repoInstall('claude'));
    expect(bad.status).toBe(400);
    expect((bad.body.error as S).message).toBe(
      ".mcp.json isn't valid JSON (unexpected character). Fix it, then install again. Nothing was written.",
    );
    mkdirSync(join(repo, '.codex'));
    writeFileSync(join(repo, '.codex/config.toml'), '[mcp_servers]\ndocket = { url = "x" }\n');
    const conflict = await api('POST', '/api/installs', repoInstall('codex'));
    expect(conflict.status).toBe(400);
    expect((conflict.body.error as S).message).toMatch(
      /^\.codex\/config\.toml defines the docket MCP server in a form Docket can't update/,
    );
    expect(
      filesUnder(repo)
        .map((p) => p.slice(repo.length + 1).replace(/\\/g, '/'))
        .sort(),
    ).toEqual(['.codex/config.toml', '.mcp.json']);
    expect((await api('GET', '/api/installs')).body.installs).toEqual([]);
  });

  it('Codex: appends the [mcp_servers.docket] table to config.toml', async () => {
    const { api, root } = await start({ push: 'set' });
    const repo = join(root, 'recipes');
    mkdirSync(join(repo, '.codex'));
    const BEFORE = 'model = "gpt-5"\n\n[mcp_servers.github]\ncommand = "gh"\n';
    writeFileSync(join(repo, '.codex/config.toml'), BEFORE);
    const res = await api('POST', '/api/installs', repoInstall('codex'));
    expect(res.status).toBe(200);
    expect(readFileSync(join(repo, '.codex/config.toml'), 'utf8')).toBe(
      `${BEFORE}\n[mcp_servers.docket]\nurl = "${MCP_URL}"\n`,
    );
    const id = res.body.install_id as string;
    expect((await api('POST', `/api/installs/${id}/check`, {})).body.state).toBe('up_to_date');
  });

  it('protected mode names DOCKET_TOKEN from the environment, never the token', async () => {
    const { api, root, server } = await start({
      push: 'set',
      env: { DOCKET_PROTECTED_MODE: 'on' },
    });
    const repo = join(root, 'recipes');
    expect((await api('POST', '/api/installs', repoInstall('claude'))).status).toBe(200);
    expect((await api('POST', '/api/installs', repoInstall('codex'))).status).toBe(200);
    const mcp = JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8')) as {
      mcpServers: { docket: S };
    };
    expect(mcp.mcpServers.docket).toEqual({
      type: 'http',
      url: MCP_URL,
      headers: { Authorization: 'Bearer ${DOCKET_TOKEN}' },
    });
    const toml = readFileSync(join(repo, '.codex/config.toml'), 'utf8');
    expect(toml).toBe(
      `[mcp_servers.docket]\nurl = "${MCP_URL}"\nbearer_token_env_var = "DOCKET_TOKEN"\n`,
    );
    for (const text of [JSON.stringify(mcp), toml]) {
      expect(text).not.toContain(server.runtime.secrets.agentToken());
    }
    const log = (await api('GET', '/api/installs')).body.installs as { manifest: S[] }[];
    expect(log[0]!.manifest).toContainEqual(
      expect.objectContaining({ key: 'connection', version_id: 'connection:protected' }),
    );
  });
});
