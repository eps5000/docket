/**
 * Projects pull their own Docket updates (owner decision 56; BUILD_SPEC §5.38):
 * the real `docket-update` scripts against a listening Docket, in temporary git
 * repos, for each client and each shell on this machine: fresh, already
 * current, an older manifest, a locally edited file, damaged markers, no git,
 * Docket down, protected mode with and without the variable, and the bootstrap
 * from an install that has no updater. No commit is ever made, and no
 * credential reaches a written file.
 *
 * A shell that isn't on this machine is skipped.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import {
  DOCKET_BEGIN,
  DOCKET_END,
  UPDATE_SCRIPT_PS1,
  UPDATE_SCRIPT_SH,
  updateCommands,
  updateNotice,
  type InstallClient,
} from '@docket/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { saveAgentFileEdit } from '../../src/domain/agent-files.js';
import { SHIPPED_CHECK_SHA256, checkPs1, checkSh } from '../../src/domain/check-scripts.js';
import { readContext } from '../../src/domain/contracts.js';
import { hashText } from '../../src/domain/installs.js';
import { updatePs1, updateSh } from '../../src/domain/update-scripts.js';
import { OWNER_ACTOR, SYSTEM_ACTOR } from '../../src/domain/write.js';
import { driftCheckOnce } from '../../src/jobs/sweeper.js';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { insertProject, tempDir, type TempDir } from '../helpers.js';
import { PROTECTED_MODE, createTestServer, type TestServer } from './harness.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

function findBash(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [process.env.DOCKET_TEST_BASH, 'C:/Program Files/Git/bin/bash.exe'].filter(Boolean)
      : ['bash'];
  for (const c of candidates as string[]) {
    if (process.platform === 'win32' && !existsSync(c)) continue;
    const probe = spawnSync(c, ['-c', 'command -v curl && command -v tar && command -v git'], {
      stdio: 'ignore',
    });
    if (probe.status === 0) return c;
  }
  return null;
}

function findPowerShell(): string | null {
  for (const c of process.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh']) {
    const ok = spawnSync(c, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    if (ok.status === 0) return c;
  }
  return null;
}

const SHELLS = { bash: findBash(), powershell: findPowerShell() };
type Shell = keyof typeof SHELLS;
const shells = (Object.keys(SHELLS) as Shell[]).filter((k) => SHELLS[k]);
const CLIENTS: InstallClient[] = ['claude', 'codex'];
const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const runnable = hasGit && shells.length > 0;

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });

const listen = (s: TestServer, port: number) =>
  new Promise<ServerType>((resolve) => {
    const http: ServerType = serve({ fetch: s.app.fetch, hostname: '127.0.0.1', port }, () =>
      resolve(http),
    );
  });

const stop = (http: ServerType) =>
  new Promise<void>((resolve) => {
    (http as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    http.close(() => resolve());
  });

let tmp: TempDir;
let scripts: string;
let n = 0;

/**
 * Output with colour codes, PowerShell's wrapped-error gutter and all spacing
 * removed, because pwsh wraps its error text at any width.
 */
const squash = (out: string) =>
  // eslint-disable-next-line no-control-regex
  out.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\s|]+/g, '');

interface Ran {
  status: number | null;
  out: string;
}

/** Run a command line in a shell, in `cwd`, with the server still serving (async spawn). */
function spawnIn(
  exe: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  stdin?: string,
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd,
      env: { ...process.env, DOCKET_TOKEN: undefined, DOCKET_URL: undefined, ...env },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, out: out.replace(/\r\n/g, '\n').trimEnd() });
    });
    child.stdin.end(stdin ?? '');
  });
}

function runUpdate(
  shell: Shell,
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
) {
  const exe = SHELLS[shell]!;
  return shell === 'bash'
    ? spawnIn(exe, [join(scripts, UPDATE_SCRIPT_SH).replace(/\\/g, '/'), ...args], cwd, env)
    : spawnIn(
        exe,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(scripts, UPDATE_SCRIPT_PS1),
          ...args,
        ],
        cwd,
        env,
      );
}

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A git repo with one commit, on a branch the "agent" chose. */
function newRepo(extra: Record<string, string> = {}): string {
  const repo = join(tmp.dir, `repo-${(n += 1)}`);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# A project\n');
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(repo, f), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'start');
  git(repo, 'checkout', '-q', '-b', 'docket-update');
  return repo;
}

const history = (repo: string) => ({
  head: git(repo, 'rev-parse', 'HEAD'),
  count: git(repo, 'rev-list', '--all', '--count'),
  branch: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
  staged: git(repo, 'diff', '--cached', '--name-only'),
});

const dirOf = (c: InstallClient) => (c === 'claude' ? '.claude' : '.codex');
const instructionsOf = (c: InstallClient) => (c === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
const connectionOf = (c: InstallClient) => (c === 'claude' ? '.mcp.json' : '.codex/config.toml');

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

function snapshot(repo: string): Map<string, string> {
  return new Map(allFiles(repo).map((f) => [f, readFileSync(f, 'latin1')]));
}

/** A new version of a skill, as the owner saving it in Agent files. */
function editSkill(s: TestServer, key: string, content: string) {
  s.runtime.write.run({ actor: OWNER_ACTOR, operation: 'test.edit', args: { key } }, (w) =>
    saveAgentFileEdit(w, {
      key,
      project: 'RCP',
      content,
      note: 'A new version',
      author: 'owner',
      how: 'Edited',
    }),
  );
}

const manifestOf = (repo: string, c: InstallClient) =>
  JSON.parse(readFileSync(join(repo, dirOf(c), '.docket-manifest.json'), 'utf8')) as {
    install_id: string;
    files: { key: string; version_id: string; sha256: string }[];
  };

beforeAll(() => {
  tmp = tempDir('docket-b72-');
  scripts = join(tmp.dir, 'updater');
  mkdirSync(scripts);
  writeFileSync(join(scripts, UPDATE_SCRIPT_SH), updateSh());
  writeFileSync(join(scripts, UPDATE_SCRIPT_PS1), updatePs1());
});
afterAll(() => tmp.cleanup());

describe.skipIf(!runnable).each(shells)('docket-update with %s', (shell) => {
  let s: TestServer;
  let http: ServerType;
  let port: number;
  let url: string;

  beforeAll(async () => {
    port = await freePort();
    url = `http://127.0.0.1:${port}`;
    s = createTestServer({ env: { DOCKET_ALLOWED_HOSTS: `127.0.0.1:${port}` }, log: () => {} });
    insertProject(s.runtime.db, 'RCP');
    syncBundledFiles(s.runtime);
    http = await listen(s, port);
  });
  afterAll(async () => {
    await stop(http);
    await s.cleanup();
  });

  describe.each(CLIENTS)('%s', (client) => {
    const fresh = () => ['--project', 'RCP', '--client', client, '--url', url];

    it('fresh, then already current, with no commit and nothing else touched', async () => {
      const repo = newRepo({ [instructionsOf(client)]: '# Our own rules\r\n\r\nKeep these.\r\n' });
      const before = history(repo);
      const first = await runUpdate(shell, repo, fresh());
      expect(first.status, first.out).toBe(0);
      expect(first.out).toContain('file(s) changed');
      expect(first.out).toContain(`${dirOf(client)}/skills/docket-worker/SKILL.md`);
      expect(first.out).toContain('Nothing was committed or pushed');
      expect(history(repo)).toEqual(before);
      for (const script of ['docket-check', 'docket-wait', 'docket-update']) {
        expect(existsSync(join(repo, dirOf(client), `${script}.sh`)), script).toBe(true);
        expect(existsSync(join(repo, dirOf(client), `${script}.ps1`)), script).toBe(true);
      }
      expect(existsSync(join(repo, connectionOf(client)))).toBe(true);
      const text = readFileSync(join(repo, instructionsOf(client)), 'latin1');
      expect(text.startsWith('# Our own rules\r\n\r\nKeep these.\r\n')).toBe(true);
      expect(text).toContain(DOCKET_BEGIN);

      const after = snapshot(repo);
      const again = await runUpdate(shell, repo, ['--url', url]);
      expect(again.status, again.out).toBe(0);
      expect(again.out).toContain('already current');
      expect(again.out).not.toContain('Nothing was committed');
      expect(snapshot(repo)).toEqual(after);
      expect(history(repo)).toEqual(before);
    });

    it('takes an older manifest forward from a subfolder, and leaves other worktrees alone', async () => {
      const repo = newRepo();
      expect((await runUpdate(shell, repo, fresh())).status).toBe(0);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'install');
      const other = join(tmp.dir, `worktree-${(n += 1)}`);
      git(repo, 'worktree', 'add', '-q', '-b', 'other-work', other);
      const untouched = snapshot(other);
      const oldId = manifestOf(repo, client).install_id;

      const key = 'skill:docket-planner';
      const skill = join(repo, dirOf(client), 'skills/docket-planner/SKILL.md');
      const next = `${readFileSync(skill, 'utf8').trimEnd()}\n\nA new line (${shell} ${client}).\n`;
      editSkill(s, key, next);

      const sub = join(repo, 'nested/folder');
      mkdirSync(sub, { recursive: true });
      const before = history(repo);
      const r = await runUpdate(shell, sub, ['--client', client, '--url', url]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/updated\s+\.(claude|codex)\/skills\/docket-planner\/SKILL\.md/);
      expect(readFileSync(skill, 'utf8')).toBe(next);
      const m = manifestOf(repo, client);
      expect(m.install_id).not.toBe(oldId);
      expect(m.files.find((f) => f.key === key)!.sha256).toBe(hashText(next));
      expect(history(repo)).toEqual(before);
      expect(snapshot(other)).toEqual(untouched);
      git(repo, 'worktree', 'remove', '--force', other);
    });

    it('keeps a locally edited file, lists it, and keeps what Docket last sent for it', async () => {
      const repo = newRepo();
      expect((await runUpdate(shell, repo, fresh())).status).toBe(0);
      const edited = join(repo, dirOf(client), 'skills/docket-review-packet/SKILL.md');
      const planner = join(repo, dirOf(client), 'skills/docket-delivery/SKILL.md');
      const sentBefore = manifestOf(repo, client).files.find(
        (f) => f.key === 'skill:docket-review-packet',
      )!;
      const local = `${readFileSync(edited, 'utf8')}\nMy own local rule.\n`;
      writeFileSync(edited, local);

      editSkill(s, 'skill:docket-review-packet', `${local}\nDocket's newer text ${n}.\n`);
      const next = `${readFileSync(planner, 'utf8').trimEnd()}\n\nDelivery note ${n}.\n`;
      editSkill(s, 'skill:docket-delivery', next);

      const r = await runUpdate(shell, repo, ['--url', url]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/kept\s+\.(claude|codex)\/skills\/docket-review-packet\/SKILL\.md/);
      expect(r.out).toContain('edited locally');
      expect(readFileSync(edited, 'utf8')).toBe(local);
      expect(readFileSync(planner, 'utf8')).toBe(next);
      const entry = manifestOf(repo, client).files.find(
        (f) => f.key === 'skill:docket-review-packet',
      )!;
      expect(entry.sha256).toBe(sentBefore.sha256);

      const after = snapshot(repo);
      const again = await runUpdate(shell, repo, ['--url', url]);
      expect(again.status, again.out).toBe(0);
      expect(again.out).toContain('already current');
      expect(again.out).toContain('edited locally');
      expect(snapshot(repo)).toEqual(after);
    });

    it('refuses damaged markers before writing anything', async () => {
      const repo = newRepo();
      expect((await runUpdate(shell, repo, fresh())).status).toBe(0);
      const file = join(repo, instructionsOf(client));
      writeFileSync(file, readFileSync(file, 'latin1').replace(DOCKET_END, ''), 'latin1');
      const skill = join(repo, dirOf(client), 'skills/docket-worker/SKILL.md');
      editSkill(
        s,
        'skill:docket-worker',
        `${readFileSync(skill, 'utf8').trimEnd()}\n\nMarkers ${n}.\n`,
      );
      const before = snapshot(repo);
      const r = await runUpdate(shell, repo, ['--url', url]);
      expect(r.status, r.out).not.toBe(0);
      expect(squash(r.out)).toContain(squash('damaged Docket section'));
      expect(squash(r.out)).toContain(squash('before writing anything'));
      expect(snapshot(repo)).toEqual(before);
    });

    it('bootstraps an old install that has no updater, with the served one-liner', async () => {
      const repo = newRepo();
      expect((await runUpdate(shell, repo, fresh())).status).toBe(0);
      // An install from before decision 56: no updater, and no manifest entry for it.
      const dir = join(repo, dirOf(client));
      rmSync(join(dir, UPDATE_SCRIPT_SH));
      rmSync(join(dir, UPDATE_SCRIPT_PS1));
      const mf = join(dir, '.docket-manifest.json');
      const lines = readFileSync(mf, 'utf8')
        .split('\n')
        .filter((l) => !l.includes('script:docket-update'));
      const fixed = lines.join('\n').replace(/,(\n {2}\])/, '$1');
      writeFileSync(mf, fixed);
      expect(() => JSON.parse(fixed) as unknown).not.toThrow();

      const cmd = updateCommands(url, false);
      const before = history(repo);
      const r =
        shell === 'bash'
          ? await spawnIn(SHELLS.bash!, ['-s'], repo, {}, `${cmd.bash}\n`)
          : await spawnIn(
              SHELLS.powershell!,
              ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', '-'],
              repo,
              {},
              `${cmd.powershell}\nif (-not $?) { exit 1 }\nexit 0\n`,
            );
      expect(r.status, r.out).toBe(0);
      expect(existsSync(join(dir, UPDATE_SCRIPT_SH))).toBe(true);
      expect(existsSync(join(dir, UPDATE_SCRIPT_PS1))).toBe(true);
      expect(manifestOf(repo, client).files.map((f) => f.key)).toContain(
        `script:${UPDATE_SCRIPT_SH}`,
      );
      expect(history(repo)).toEqual(before);
    });
  });

  it('refuses a folder that is not a git repo', async () => {
    const folder = join(tmp.dir, `plain-${(n += 1)}`);
    mkdirSync(folder);
    const r = await runUpdate(
      shell,
      folder,
      ['--project', 'RCP', '--client', 'claude', '--url', url],
      {
        GIT_CEILING_DIRECTORIES: tmp.dir,
      },
    );
    expect(r.status, r.out).not.toBe(0);
    expect(squash(r.out)).toContain(squash("isn't in a git repository"));
    expect(readdirSync(folder)).toEqual([]);
  });

  it('fails clearly when Docket is down, and writes nothing', async () => {
    const repo = newRepo();
    const closed = await freePort();
    const before = snapshot(repo);
    const r = await runUpdate(shell, repo, [
      '--project',
      'RCP',
      '--client',
      'claude',
      '--url',
      `http://127.0.0.1:${closed}`,
    ]);
    expect(r.status, r.out).not.toBe(0);
    expect(squash(r.out)).toContain(squash("Docket isn't reachable"));
    expect(snapshot(repo)).toEqual(before);
  });

  it('protected mode: refused without the variable, and no credential is written', async () => {
    const p = await freePort();
    const guarded = createTestServer({
      env: { ...PROTECTED_MODE, DOCKET_ALLOWED_HOSTS: `127.0.0.1:${p}` },
      log: () => {},
    });
    insertProject(guarded.runtime.db, 'RCP');
    syncBundledFiles(guarded.runtime);
    const server = await listen(guarded, p);
    try {
      const token = guarded.runtime.secrets.agentToken();
      const args = ['--project', 'RCP', '--client', 'claude', '--url', `http://127.0.0.1:${p}`];
      const repo = newRepo();
      const before = snapshot(repo);
      const refused = await runUpdate(shell, repo, args);
      expect(refused.status, refused.out).not.toBe(0);
      expect(squash(refused.out)).toContain('DOCKET_TOKEN');
      expect(snapshot(repo)).toEqual(before);

      const ok = await runUpdate(shell, repo, args, { DOCKET_TOKEN: token });
      expect(ok.status, ok.out).toBe(0);
      expect(ok.out).not.toContain(token);
      for (const [file, text] of snapshot(repo)) {
        expect(text.includes(token), `${file} holds the token`).toBe(false);
      }
      // The connection file names the variable instead.
      expect(readFileSync(join(repo, '.mcp.json'), 'utf8')).toContain('${DOCKET_TOKEN}');
    } finally {
      await stop(server);
      await guarded.cleanup();
    }
  });
});

describe('the update route and its guards', () => {
  let s: TestServer;
  beforeAll(() => {
    s = createTestServer({ log: () => {} });
    insertProject(s.runtime.db, 'RCP');
    syncBundledFiles(s.runtime);
  });
  afterAll(() => s.cleanup());

  const body = (extra: object = {}) =>
    JSON.stringify({ project: 'RCP', client: 'claude', files: [], ...extra });
  const post = (b: string, headers: Record<string, string> = {}) =>
    s.request('/agent/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: b,
    });

  it('serves only the two updater scripts, as plain text', async () => {
    const sh = await s.request(`/agent/update/${UPDATE_SCRIPT_SH}`);
    expect(sh.status).toBe(200);
    expect(sh.headers.get('content-type')).toContain('text/plain');
    expect(sh.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await sh.text()).toBe(updateSh());
    expect(await (await s.request(`/agent/update/${UPDATE_SCRIPT_PS1}`)).text()).toBe(updatePs1());
    for (const name of ['docket-check.sh', '..%2F.env', 'secrets', 'docket-update.txt']) {
      expect((await s.request(`/agent/update/${name}`)).status, name).toBe(404);
    }
  });

  it('keeps the scripts ASCII, so PowerShell 5.1 reads them in any code page', () => {
    for (const text of [updateSh(), updatePs1()]) {
      expect([...text].filter((c) => c.charCodeAt(0) > 0x7e && c !== '\n')).toEqual([]);
    }
  });

  it('applies the Host and Origin guards', async () => {
    const wrongHost = await s.app.request('http://evil.example/agent/update/docket-update.sh', {
      headers: { host: 'evil.example' },
    });
    expect(wrongHost.status).toBe(421);
    expect((await post(body(), { origin: 'http://evil.example' })).status).toBe(403);
    const script = await s.request(`/agent/update/${UPDATE_SCRIPT_SH}`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(script.status).toBe(403);
  });

  it('protected mode needs the bearer token for the script and the files', async () => {
    const guarded = createTestServer({ env: { ...PROTECTED_MODE }, log: () => {} });
    insertProject(guarded.runtime.db, 'RCP');
    syncBundledFiles(guarded.runtime);
    try {
      const bearer = { authorization: `Bearer ${guarded.runtime.secrets.agentToken()}` };
      expect((await guarded.request(`/agent/update/${UPDATE_SCRIPT_SH}`)).status).toBe(401);
      const send = (headers: Record<string, string>) =>
        guarded.request('/agent/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: body(),
        });
      expect((await send({})).status).toBe(401);
      expect((await send({ authorization: 'Bearer wrong' })).status).toBe(401);
      expect((await send(bearer)).status).toBe(200);
      expect(
        (await guarded.request(`/agent/update/${UPDATE_SCRIPT_SH}`, { headers: bearer })).status,
      ).toBe(200);
    } finally {
      await guarded.cleanup();
    }
  });

  it('refuses an unknown project, a bad key and an oversized request', async () => {
    expect((await post(body({ project: 'NOPE' }))).status).toBe(404);
    expect((await post('not json')).status).toBe(400);
    const badKey = { key: '../../.env', sha256: 'a'.repeat(64) };
    expect((await post(body({ files: [badKey] }))).status).toBe(400);
    const extra = JSON.stringify({ project: 'RCP', client: 'claude', files: [], token: 'x' });
    expect((await post(extra)).status).toBe(400);
    expect((await post(`${' '.repeat(70_000)}${body()}`)).status).toBe(400);
  });

  it('every shipped docket-check is known, so an old copy is never read as an edit', () => {
    expect(SHIPPED_CHECK_SHA256).toContain(hashText(checkSh()));
    expect(SHIPPED_CHECK_SHA256).toContain(hashText(checkPs1()));
  });
});

describe('what the main branch holds (read-only git)', () => {
  it.skipIf(!hasGit)('an update counts once its manifest is on main', async () => {
    const root = join(tmp.dir, `push-${(n += 1)}`);
    mkdirSync(root);
    const s = createTestServer({ env: { DOCKET_PUSH_ROOT: root }, log: () => {} });
    try {
      insertProject(s.runtime.db, 'RCP');
      syncBundledFiles(s.runtime);
      const repo = join(root, 'proj');
      mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'x\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'start');
      s.runtime.db.sqlite
        .prepare('UPDATE projects SET repo_path = ? WHERE key = ?')
        .run(repo, 'RCP');
      const read = () => readContext(s.runtime.db, SYSTEM_ACTOR, s.runtime.clock());
      const state = async () =>
        (await s.runtime.services.installs.state(read(), { project: 'RCP' })).clients.find(
          (c) => c.client === 'claude',
        )!;

      expect((await state()).repo_main).toEqual({ state: 'absent', branch: 'main' });

      const prepared = s.runtime.services.installs.prepareUpdate(read(), {
        project: 'RCP',
        client: 'claude',
        files: [],
      });
      const { result: id } = s.runtime.write.run(
        { actor: SYSTEM_ACTOR, operation: 'test.update', args: {} },
        (w) => s.runtime.services.installs.recordUpdate(w, prepared),
      );
      expect(id).toMatch(/^ins_/);
      // Fetched on a branch: still not installed as far as main knows.
      let st = await state();
      expect(st.state).toBe('not_installed');
      expect(st.update_on_branch?.install_id).toBe(id);

      // Merged: the manifest is on main.
      const manifest = {
        install_id: id,
        target: 'repo',
        project: 'RCP',
        files: prepared.manifest,
      };
      mkdirSync(join(repo, '.claude'));
      writeFileSync(join(repo, '.claude/.docket-manifest.json'), JSON.stringify(manifest));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'Take the Docket update');

      st = await state();
      expect(st.repo_main).toEqual({ state: 'current', branch: 'main' });
      expect(st.state).toBe('up_to_date');
      expect(st.install?.id).toBe(id);
      expect(st.update_on_branch).toBeNull();

      // The scheduled check makes it the recorded install.
      await driftCheckOnce(s.runtime);
      const row = s.runtime.db.sqlite
        .prepare('SELECT token_used_at FROM installs WHERE id = ?')
        .get(id) as { token_used_at: string | null };
      expect(row.token_used_at).not.toBeNull();

      // A newer version in Docket: main is behind.
      editSkill(s, 'skill:docket-worker', `# changed ${n}\n`);
      st = await state();
      expect(st.repo_main.state).toBe('behind');
      expect(st.state).toBe('update_available');
      expect(st.outdated).toContain('skill:docket-worker');
    } finally {
      await s.cleanup();
    }
  });

  it('says it cannot tell when Docket cannot read the repo', async () => {
    const s = createTestServer({ log: () => {} });
    try {
      insertProject(s.runtime.db, 'RCP');
      syncBundledFiles(s.runtime);
      const read = readContext(s.runtime.db, SYSTEM_ACTOR, s.runtime.clock());
      const st = await s.runtime.services.installs.state(read, { project: 'RCP' });
      expect(st.clients[0]!.repo_main.state).toBe('unknown');
      expect(st.update_command.bash).toContain('/agent/update/docket-update.sh');
    } finally {
      await s.cleanup();
    }
  });
});

describe('the update commands and notice', () => {
  it('names the variable and never a value, and stays compact', () => {
    const local = updateCommands('http://127.0.0.1:7420', false);
    expect(local.bash).not.toContain('Authorization');
    expect(local.powershell).not.toContain('Authorization');
    const guarded = updateCommands('http://127.0.0.1:7420', true);
    expect(guarded.bash).toContain('$DOCKET_TOKEN');
    expect(guarded.powershell).toContain('$env:DOCKET_TOKEN');
    expect(Math.ceil(updateNotice(3, guarded).length / 4)).toBeLessThanOrEqual(200);
    expect(Math.ceil(updateNotice(3, local).length / 4)).toBeLessThanOrEqual(150);
  });
});
