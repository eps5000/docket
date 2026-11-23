/**
 * Installs stay in scope (owner decision 50; B64; BUILD_SPEC §5.36):
 * - a new user-wide install is refused, and an old one never counts as
 *   installed for a project, raises drift or reaches Problems;
 * - All projects shows each project's real state, and a worktree install says
 *   so instead of "up to date";
 * - *Mark as removed* on a legacy user-wide row, with Undo;
 * - the uninstall command, run for real in each shell on this machine.
 *
 * Every shell runs with HOME and USERPROFILE pointed at a temporary folder,
 * and every install goes into a temporary folder. The real home is never read.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { DOCKET_BEGIN, DOCKET_END, markedSection } from '@docket/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { insertItem, insertProject, tempDir, type TempDir } from '../helpers.js';
import { createTestServer, parseSetCookies, type TestServer } from './harness.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

type S = Record<string, unknown>;
interface Row {
  project: string;
  client: string;
  state: string;
  install: { id: string };
  worktree: { name: string; branch: string; merged: boolean } | null;
}

const sha = (t: string) => createHash('sha256').update(t.replace(/\r/g, ''), 'utf8').digest('hex');

function which(cmd: string, probe: string[]): string | null {
  const r = spawnSync(cmd, probe, { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? cmd : null;
}
function findBash(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [process.env.DOCKET_TEST_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe'].filter(Boolean)
      : [process.env.DOCKET_TEST_BASH ?? 'bash'];
  for (const c of candidates as string[]) {
    if (process.platform === 'win32' && !existsSync(c)) continue;
    if (which(c, ['-c', 'command -v curl && command -v tar'])) return c;
  }
  return null;
}
const SHELLS = {
  bash: findBash(),
  pwsh: which('pwsh', ['-NoProfile', '-Command', 'exit 0']),
  powershell:
    process.platform === 'win32' ? which('powershell', ['-NoProfile', '-Command', 'exit 0']) : null,
} as const;
type ShellName = keyof typeof SHELLS;
const AVAILABLE = (Object.keys(SHELLS) as ShellName[]).filter((n) => SHELLS[n]);

let s: TestServer;
let http: ServerType;
let tmp: TempDir;
let home: string;
let n = 0;
let base = '';
const origin = () => base;
let api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: S }>;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  tmp = tempDir('docket-b64-');
  home = join(tmp.dir, 'home');
  mkdirSync(home);
  s = createTestServer({ env: { DOCKET_ALLOWED_HOSTS: `127.0.0.1:${port}` }, log: () => {} });
  insertProject(s.runtime.db, 'RCP');
  insertProject(s.runtime.db, 'OTH');
  insertItem(s.runtime.db, { id: 'RCP-1' });
  syncBundledFiles(s.runtime);
  http = serve({ fetch: s.app.fetch, hostname: '127.0.0.1', port });
  const origin = `http://127.0.0.1:${port}`;
  base = origin;
  const unlock = await fetch(`${origin}/api/session/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(unlock);
  const cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${cookies.docket_csrf!.value}`;
  api = async (method, path, body) => {
    const r = await fetch(`${origin}${path}`, {
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
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await s.cleanup();
  tmp.cleanup();
});

beforeEach(() => {
  s.runtime.db.sqlite.prepare('DELETE FROM drift').run();
  s.runtime.db.sqlite.prepare('DELETE FROM installs').run();
  s.runtime.db.sqlite.prepare('DELETE FROM runs').run();
  s.runtime.db.sqlite.prepare('DELETE FROM artifacts').run();
});

/** Run one pasted command with a temporary home. */
async function run(shell: ShellName, command: string, cwd: string) {
  const args =
    shell === 'bash'
      ? ['-s']
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', '-'];
  return new Promise<{ status: number | null; out: string }>((resolve) => {
    const child = spawn(SHELLS[shell]!, args, {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, out: out.replace(/\r\n/g, '\n') });
    });
    child.stdin.end(
      shell === 'bash' ? `${command}\n` : `${command}\nif (-not $?) { exit 1 }\nexit 0\n`,
    );
  });
}

const cmd = (shell: ShellName, c: { bash: string; powershell: string }) =>
  shell === 'bash' ? c.bash : c.powershell;

function newRepo(): string {
  const repo = join(tmp.dir, `repo-${++n}`);
  mkdirSync(join(repo, '.git'), { recursive: true });
  return repo;
}

/** A real repo install by its command; returns the install ID. */
async function install(shell: ShellName, repo: string, client: 'claude' | 'codex' = 'claude') {
  const made = await api('POST', '/api/installs', {
    client,
    target_kind: 'repo',
    project: 'RCP',
    method: 'command',
    path: repo,
  });
  expect(made.status).toBe(200);
  const r = await run(shell, cmd(shell, made.body.command as never), repo);
  expect(r.status, r.out).toBe(0);
  return made.body.install_id as string;
}

async function uninstall(shell: ShellName, id: string, cwd: string) {
  const made = await api('POST', `/api/installs/${id}/uninstall`, {});
  expect(made.status).toBe(200);
  return run(shell, cmd(shell, made.body.command as never), cwd);
}

const stateOf = async (client = 'claude') => {
  const st = await api('GET', '/api/install-state?project=RCP');
  return (st.body.clients as { client: string; state: string }[]).find((c) => c.client === client)!
    .state;
};

const logRow = async (id: string) =>
  ((await api('GET', '/api/installs')).body.installs as (S & { id: string })[]).find(
    (r) => r.id === id,
  )!;

/** A synthetic legacy user-wide install, on disk in `base` and in the database. */
function legacyUserInstall(base: string, id = 'ins_legacyuser') {
  const skill = '---\nname: docket-worker\n---\n# Synthetic worker skill\n';
  const block = '## Work tracking: Docket\n\nSynthetic block.';
  mkdirSync(join(base, '.claude/skills/docket-worker'), { recursive: true });
  writeFileSync(join(base, '.claude/skills/docket-worker/SKILL.md'), skill);
  writeFileSync(join(base, '.claude/CLAUDE.md'), `# My own notes\n\n${markedSection(block)}\n`);
  const manifest = {
    'skill:docket-worker': { version_id: 'afv_synthetic1', sha256: sha(skill) },
    agents_block: { version_id: 'afv_synthetic2', sha256: sha(block) },
  };
  writeFileSync(
    join(base, '.claude/.docket-manifest.json'),
    `${JSON.stringify({ install_id: id, target: 'user', files: [] })}\n`,
  );
  const now = s.clock.now().toISOString();
  s.runtime.db.sqlite
    .prepare(
      `INSERT INTO installs (id, at, client, target_kind, project_key, path, method, manifest,
         token_used_at, created_at, updated_at)
       VALUES (?, ?, 'claude', 'user', NULL, NULL, 'command', ?, ?, ?, ?)`,
    )
    .run(id, now, JSON.stringify(manifest), now, now, now);
  return id;
}

function repoRow(project: string, path: string | null, id: string, client = 'claude') {
  const now = s.clock.now().toISOString();
  s.runtime.db.sqlite
    .prepare(
      `INSERT INTO installs (id, at, client, target_kind, project_key, path, method, manifest,
         token_used_at, created_at, updated_at)
       VALUES (?, ?, ?, 'repo', ?, ?, 'command', '{}', ?, ?, ?)`,
    )
    .run(id, now, client, project, path, now, now, now);
}

function runIn(path: string, branch: string, repo: string | null = null) {
  const now = s.clock.now().toISOString();
  s.runtime.db.sqlite
    .prepare(
      `INSERT INTO runs (id, item_id, client, is_lead, state, last_signal_at, last_signal_kind,
         workspace, created_at, updated_at)
       VALUES (?, 'RCP-1', 'claude', 0, 'finished', ?, 'session', ?, ?, ?)`,
    )
    .run(
      `run_${++n}`,
      now,
      JSON.stringify({ path, branch, repo, base_ref: 'origin/main', updated_at: now }),
      now,
      now,
    );
}

const overview = async () => (await api('GET', '/api/install-overview')).body.rows as Row[];

describe('status: project-only, user-only, both and none (decision 50)', () => {
  it('none', async () => {
    expect(await overview()).toEqual([]);
    expect(await stateOf()).toBe('not_installed');
  });

  it('project-only: the project shows its install', async () => {
    repoRow('RCP', 'C:/code/recipes', 'ins_repo1');
    const rows = await overview();
    expect(rows.map((r) => [r.project, r.client, r.install.id])).toEqual([
      ['RCP', 'claude', 'ins_repo1'],
    ]);
    expect(await stateOf()).not.toBe('not_installed');
  });

  it('user-only: a legacy install counts for no project, and stays in the log', async () => {
    const base = join(tmp.dir, `legacy-${++n}`);
    const id = legacyUserInstall(base);
    expect(await overview()).toEqual([]);
    expect(await stateOf()).toBe('not_installed');
    const noProject = await api('GET', '/api/install-state');
    expect(
      (noProject.body.clients as { state: string }[]).every((c) => c.state === 'not_installed'),
    ).toBe(true);
    expect((await logRow(id)).target_kind).toBe('user');
  });

  it('both: only the project install counts', async () => {
    legacyUserInstall(join(tmp.dir, `legacy-${++n}`));
    repoRow('OTH', 'C:/code/other', 'ins_repo2', 'codex');
    const rows = await overview();
    expect(rows.map((r) => [r.project, r.client])).toEqual([['OTH', 'codex']]);
    expect(await stateOf()).toBe('not_installed');
  });

  it('shows the latest install at each folder, and one removed there hides older ones', async () => {
    repoRow('RCP', 'C:/code/a', 'ins_old');
    s.clock.advance(1000);
    repoRow('RCP', 'C:/code/a', 'ins_new');
    repoRow('RCP', 'C:/code/b', 'ins_b');
    expect((await overview()).map((r) => r.install.id).sort()).toEqual(['ins_b', 'ins_new']);
    s.runtime.db.sqlite
      .prepare(`UPDATE installs SET removed_at = ? WHERE id = 'ins_new'`)
      .run(s.clock.now().toISOString());
    expect((await overview()).map((r) => r.install.id)).toEqual(['ins_b']);
  });
});

describe('where a repo install lives (decision 50)', () => {
  it('a run on a feature branch in that folder marks it a worktree, not merged yet', async () => {
    repoRow('RCP', 'C:/worktrees/feature-x', 'ins_wt');
    runIn('C:\\worktrees\\feature-x\\', 'eps/feature-x', 'C:/code/recipes');
    const [row] = await overview();
    expect(row!.worktree).toEqual({ name: 'feature-x', branch: 'eps/feature-x', merged: false });
  });

  it('says merged only when that run’s ticket has a merged PR', async () => {
    repoRow('RCP', 'C:/worktrees/done', 'ins_wt2');
    runIn('C:/worktrees/done', 'eps/done', 'C:/code/recipes');
    const now = s.clock.now().toISOString();
    s.runtime.db.sqlite
      .prepare(
        `INSERT INTO artifacts (id, item_id, kind, label, state, created_at, updated_at)
         VALUES ('art_1', 'RCP-1', 'pr', 'PR', 'merged', ?, ?)`,
      )
      .run(now, now);
    expect((await overview())[0]!.worktree?.merged).toBe(true);
  });

  it('the main branch, the repo root, or a folder no run reported is not a worktree', async () => {
    repoRow('RCP', 'C:/code/main-branch', 'ins_m');
    runIn('C:/code/main-branch', 'main', 'C:/code/recipes');
    repoRow('RCP', 'C:/code/root', 'ins_r');
    runIn('C:/code/root', 'eps/on-root', 'C:/code/root');
    repoRow('RCP', 'C:/code/unknown', 'ins_u');
    expect((await overview()).every((r) => r.worktree === null)).toBe(true);
  });
});

describe('a legacy user-wide install raises nothing (decision 50)', () => {
  it('its reports and old open drift reach neither drift nor Problems', async () => {
    const id = legacyUserInstall(join(tmp.dir, `legacy-${++n}`));
    const now = s.clock.now().toISOString();
    s.runtime.write.run({ actor: { kind: 'system' } as never, operation: 't', args: {} }, (w) =>
      s.runtime.services.drift.recordChecks(w, {
        reports: [
          {
            source: 'push_check',
            install_id: id,
            files: [{ key: 'skill:docket-worker', sha256: 'a'.repeat(64) }],
          },
        ],
      }),
    );
    expect(
      s.runtime.db.sqlite.prepare('SELECT count(*) AS c FROM drift').get() as { c: number },
    ).toEqual({ c: 0 });
    // A record from before decision 50 stays stored but isn't shown.
    s.runtime.db.sqlite
      .prepare(
        `INSERT INTO drift (id, install_id, project_key, file_key, change, state, local_sha256,
           detected_at, created_at, updated_at)
         VALUES ('dft_old', ?, NULL, 'skill:docket-worker', 'edited', 'open', ?, ?, ?, ?)`,
      )
      .run(id, 'b'.repeat(64), now, now, now);
    expect((await api('GET', '/api/drift')).body.drift).toEqual([]);
    const needs = await api('GET', '/api/needs-you?scope=all');
    expect(JSON.stringify(needs.body)).not.toContain('dft_old');
  });
});

describe('Mark as removed (decision 50)', () => {
  it('records it with an event, and Undo puts it back', async () => {
    const id = legacyUserInstall(join(tmp.dir, `legacy-${++n}`));
    const res = await api('POST', `/api/installs/${id}/mark-removed`, {});
    expect(res.status).toBe(200);
    const marked = res.body.install as { removed_at: string; removal: { how: string } };
    expect(marked.removed_at).toBeTruthy();
    expect(marked.removal.how).toBe('marked');
    const events = s.runtime.db.sqlite
      .prepare(`SELECT summary FROM events WHERE type = 'install.recorded' ORDER BY seq DESC`)
      .all() as { summary: string }[];
    expect(events[0]!.summary).toContain('You marked as removed');

    const undone = await api('POST', `/api/mutations/${res.body.mutation_id as string}/undo`, {});
    expect(undone.status).toBe(200);
    expect((await logRow(id)).removed_at).toBeNull();
  });

  it('is only for a legacy user-wide install, and only once', async () => {
    repoRow('RCP', 'C:/code/recipes', 'ins_repo3');
    expect((await api('POST', '/api/installs/ins_repo3/mark-removed', {})).status).toBe(400);
    const id = legacyUserInstall(join(tmp.dir, `legacy-${++n}`));
    expect((await api('POST', `/api/installs/${id}/mark-removed`, {})).status).toBe(200);
    expect((await api('POST', `/api/installs/${id}/mark-removed`, {})).status).toBe(400);
    expect((await api('POST', '/api/installs/ins_nope/mark-removed', {})).status).toBe(404);
  });
});

describe('the uninstall token (decision 50)', () => {
  it('is single use, and its report names only files the install wrote', async () => {
    const id = legacyUserInstall(join(tmp.dir, `legacy-${++n}`));
    const made = await api('POST', `/api/installs/${id}/uninstall`, {});
    const token = /\/uninstall\/([A-Za-z0-9_-]{43})/.exec(
      (made.body.command as { bash: string }).bash,
    )![1]!;
    // Before the download, a report is refused.
    const early = await fetch(`${origin()}/uninstall/${token}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removed: [], kept: [], gone: [] }),
    });
    expect(early.status).toBe(404);
    expect((await fetch(`${origin()}/uninstall/${token}`)).status).toBe(200);
    expect((await fetch(`${origin()}/uninstall/${token}`)).status).toBe(404);
    const foreign = await fetch(`${origin()}/uninstall/${token}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removed: ['.ssh/id_rsa'], kept: [], gone: [] }),
    });
    expect(foreign.status).toBe(400);
    const good = await fetch(`${origin()}/uninstall/${token}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removed: ['.claude/CLAUDE.md'], kept: [], gone: [] }),
    });
    expect(good.status).toBe(200);
    const replay = await fetch(`${origin()}/uninstall/${token}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removed: [], kept: [], gone: [] }),
    });
    expect(replay.status).toBe(404);
    expect((await logRow(id)).removed_at).toBeTruthy();
  });
});

describe.skipIf(AVAILABLE.length === 0).each(AVAILABLE)('the uninstall command in %s', (shell) => {
  it('unchanged: removes what it wrote and keeps the surrounding content', async () => {
    const repo = newRepo();
    const own = '# Own rules\n\nKeep this.\n';
    writeFileSync(join(repo, 'CLAUDE.md'), own);
    writeFileSync(
      join(repo, '.mcp.json'),
      `${JSON.stringify({ mcpServers: { other: { command: 'x' } }, keep: 1 }, null, 2)}\n`,
    );
    const id = await install(shell, repo);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toContain(DOCKET_BEGIN);
    const r = await uninstall(shell, id, repo);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('Docket recorded the removal.');
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(own);
    expect(JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: { other: { command: 'x' } },
      keep: 1,
    });
    for (const gone of [
      '.claude/skills/docket-worker',
      '.claude/skills/docket-delivery',
      '.claude/.docket-manifest.json',
      '.claude/docket-check.sh',
      '.claude/docket-check.ps1',
      '.claude/docket-wait.sh',
      '.claude/docket-wait.ps1',
    ]) {
      expect(existsSync(join(repo, gone)), gone).toBe(false);
    }
    expect(await stateOf()).toBe('not_installed');
    expect((await logRow(id)).removal).toMatchObject({ how: 'command', kept: [] });
  });

  it('deletes an instructions or connection file only when nothing else remains', async () => {
    const repo = newRepo();
    const id = await install(shell, repo);
    const r = await uninstall(shell, id, repo);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(repo, '.mcp.json'))).toBe(false);
  });

  it('Codex: removes only the docket table from config.toml', async () => {
    const repo = newRepo();
    mkdirSync(join(repo, '.codex'));
    const toml = 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n';
    writeFileSync(join(repo, '.codex/config.toml'), toml);
    const id = await install(shell, repo, 'codex');
    expect(readFileSync(join(repo, '.codex/config.toml'), 'utf8')).toContain('mcp_servers.docket');
    const r = await uninstall(shell, id, repo);
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(repo, '.codex/config.toml'), 'utf8')).toBe(toml);
  });

  it('modified, missing, extra and changed entries are kept and listed; it can repeat', async () => {
    const repo = newRepo();
    const id = await install(shell, repo);
    const edited = join(repo, '.claude/skills/docket-planner/SKILL.md');
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}\nMy local note.\n`);
    rmSync(join(repo, '.claude/skills/docket-coordinator/SKILL.md'));
    writeFileSync(join(repo, '.claude/skills/docket-worker/notes.txt'), 'mine');
    const mcp = join(repo, '.mcp.json');
    writeFileSync(mcp, readFileSync(mcp, 'utf8').replace('/mcp', '/mcp-changed'));
    const claude = join(repo, 'CLAUDE.md');
    const before = readFileSync(claude, 'utf8');
    const editedBlock = before.replace(DOCKET_END, `An owner line.\n${DOCKET_END}`);
    writeFileSync(claude, editedBlock);

    const r = await uninstall(shell, id, repo);
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(edited, 'utf8')).toContain('My local note.');
    expect(readFileSync(claude, 'utf8')).toBe(editedBlock);
    expect(readFileSync(mcp, 'utf8')).toContain('/mcp-changed');
    expect(readFileSync(join(repo, '.claude/skills/docket-worker/notes.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(repo, '.claude/skills/docket-worker/SKILL.md'))).toBe(false);
    // Kept files leave the manifest, so a later run can finish.
    expect(existsSync(join(repo, '.claude/.docket-manifest.json'))).toBe(true);
    const removal = (await logRow(id)).removal as {
      kept: { path: string; why: string }[];
      gone: string[];
    };
    expect(removal.kept).toEqual(
      expect.arrayContaining([
        { path: '.claude/skills/docket-planner/SKILL.md', why: 'modified' },
        { path: 'CLAUDE.md', why: 'modified' },
        { path: '.mcp.json', why: 'modified' },
        { path: '.claude/skills/docket-worker/', why: 'other_files' },
      ]),
    );
    expect(removal.gone).toContain('.claude/skills/docket-coordinator/SKILL.md');

    const again = await uninstall(shell, id, repo);
    expect(again.status, again.out).toBe(0);
    expect(again.out).toContain('already gone');
    expect(readFileSync(edited, 'utf8')).toContain('My local note.');
    expect(readFileSync(claude, 'utf8')).toBe(editedBlock);
  });

  it('never follows a link', async () => {
    const repo = newRepo();
    const id = await install(shell, repo);
    const outside = join(tmp.dir, `outside-${++n}.md`);
    const target = join(repo, '.claude/skills/docket-worker/SKILL.md');
    const text = readFileSync(target, 'utf8');
    writeFileSync(outside, text);
    rmSync(target);
    try {
      symlinkSync(outside, target);
    } catch {
      return; // Windows without the symlink privilege.
    }
    const r = await uninstall(shell, id, repo);
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(outside, 'utf8')).toBe(text);
    expect((await logRow(id)).removal).toMatchObject({
      kept: expect.arrayContaining([
        { path: '.claude/skills/docket-worker/SKILL.md', why: 'link' },
      ]) as unknown,
    });
  });

  it('refuses a folder holding a different install, and removes nothing', async () => {
    const repo = newRepo();
    const first = await install(shell, repo);
    const second = await install(shell, repo);
    expect(second).not.toBe(first);
    const r = await uninstall(shell, first, repo);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('different install');
    expect(existsSync(join(repo, '.claude/skills/docket-worker/SKILL.md'))).toBe(true);
    expect((await logRow(first)).removed_at).toBeNull();
  });

  it('a legacy user-wide install, in a temporary home folder', async () => {
    rmSync(join(home, '.claude'), { recursive: true, force: true });
    const id = legacyUserInstall(home);
    const r = await uninstall(shell, id, home);
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toBe('# My own notes\n');
    expect(existsSync(join(home, '.claude/skills/docket-worker'))).toBe(false);
    expect(existsSync(join(home, '.claude/.docket-manifest.json'))).toBe(false);
    expect((await logRow(id)).removed_at).toBeTruthy();
  });
});
