/**
 * The copy-paste install and check commands, run for real (T155, T156):
 * a listening Task Lite, a scratch repo with a `.git` folder and a CLAUDE.md
 * of its own, and each shell that is on this machine (bash with curl, tar
 * and sha256sum; PowerShell 7 `pwsh`; Windows PowerShell 5.1). Each shell:
 * 1. installs by the one-liner (download, unpack, the bundle's install step);
 * 2. checks: up to date;
 * 3. after one installed file is edited and another deleted, and an extra
 *    tasklite-* folder added, checks again: edited, missing, extra;
 * 4. reinstalls with a new command, which restores them;
 * and the CLAUDE.md text outside the markers stays byte-identical throughout.
 *
 * A shell that isn't installed skips (CI's no-network container has bash but
 * no curl; the GitHub runner has bash and pwsh). The transcripts are printed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { TASKLITE_BEGIN, TASKLITE_END } from '@tasklite/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { insertProject, tempDir, type TempDir } from '../helpers.js';
import { createTestServer, parseSetCookies, type TestServer } from './harness.js';

const transcript: string[] = [];

function which(cmd: string, probe: string[]): string | null {
  const r = spawnSync(cmd, probe, { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? cmd : null;
}

/** bash with curl, tar and sha256sum (or shasum). On Windows, Git's bash, never WSL's. */
function findBash(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [process.env.TASKLITE_TEST_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe'].filter(Boolean)
      : [process.env.TASKLITE_TEST_BASH ?? 'bash'];
  for (const c of candidates as string[]) {
    if (process.platform === 'win32' && !existsSync(c)) continue;
    if (
      which(c, [
        '-c',
        'command -v curl && command -v tar && { command -v sha256sum || command -v shasum; }',
      ])
    ) {
      return c;
    }
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

let s: TestServer;
let http: ServerType;
let port: number;
let tmp: TempDir;
let request: (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  if (!Object.values(SHELLS).some(Boolean)) return;
  port = await freePort();
  tmp = tempDir('tasklite-shell-');
  s = createTestServer({ env: { TASKLITE_ALLOWED_HOSTS: `127.0.0.1:${port}` }, log: () => {} });
  insertProject(s.runtime.db, 'RCP');
  syncBundledFiles(s.runtime);
  http = serve({ fetch: s.app.fetch, hostname: '127.0.0.1', port });
  const origin = `http://127.0.0.1:${port}`;
  const unlock = await fetch(`${origin}/api/session/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(unlock);
  const cookie = `tl_owner=${cookies.tl_owner!.value}; tl_csrf=${cookies.tl_csrf!.value}`;
  request = async (method, path, body) => {
    const r = await fetch(`${origin}${path}`, {
      method,
      headers: {
        cookie,
        'x-tasklite-csrf': cookies.tl_csrf!.value,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await r.json()) as Record<string, unknown>;
  };
});

afterAll(async () => {
  if (transcript.length > 0) console.log(transcript.join('\n'));
  if (!s) return;
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await s.cleanup();
  tmp.cleanup();
});

/** Run one pasted command in `cwd`, as the owner would (async: the server is in this process). */
async function run(shell: ShellName, command: string, cwd: string) {
  const exe = SHELLS[shell]!;
  const args =
    shell === 'bash'
      ? ['-c', command]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', '-'];
  const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
    const child = spawn(exe, args, { cwd, env: process.env });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, out });
    });
    // PowerShell reads the pasted line from stdin, then exits with its status.
    if (shell === 'bash') child.stdin.end();
    else child.stdin.end(`${command}\nif (-not $?) { exit 1 }\nexit 0\n`);
  });
  const out = r.out.replace(/\r\n/g, '\n').trimEnd();
  transcript.push(`$ (${shell}, in ${cwd.slice(tmp.dir.length + 1) || '.'})`, out, '');
  return { status: r.status, out };
}

const PRE =
  '# Recipes\r\n\r\nOur own rules — keep them exactly. Ünïcödé.\r\n\r\n## Build\r\n`pnpm build`';

describe.each(Object.keys(SHELLS) as ShellName[])('the %s commands', (shell) => {
  it.skipIf(!SHELLS[shell])(
    'install, check, edit, check, reinstall: byte-identical outside the markers',
    async () => {
      const repo = join(tmp.dir, `repo-${shell}`);
      mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(join(repo, 'CLAUDE.md'), PRE);
      const key = shell === 'bash' ? 'bash' : 'powershell';

      const install = async () => {
        const created = await request('POST', '/api/installs', {
          client: 'claude',
          target_kind: 'repo',
          project: 'RCP',
          method: 'command',
        });
        return {
          install: (created.command as Record<string, string>)[key]!,
          check: (created.check_command as Record<string, string>)[key]!,
        };
      };

      // 1. Install.
      const first = await install();
      transcript.push(`## ${shell}: install`);
      const i1 = await run(shell, first.install, repo);
      expect(i1.status, i1.out).toBe(0);
      expect(i1.out).toContain('wrote .claude/skills/tasklite-worker/SKILL.md');
      expect(i1.out).toContain('added the Task Lite section to the end of CLAUDE.md');
      const claude = readFileSync(join(repo, 'CLAUDE.md'));
      expect(claude.subarray(0, Buffer.byteLength(PRE)).equals(Buffer.from(PRE))).toBe(true);
      expect(claude.subarray(Buffer.byteLength(PRE)).toString('utf8')).toMatch(
        new RegExp(
          `^\\n\\n${TASKLITE_BEGIN}\\n## Work tracking: Task Lite[\\s\\S]*\\n${TASKLITE_END}\\n$`,
        ),
      );
      expect(existsSync(join(repo, '.claude/.tasklite-manifest.json'))).toBe(true);

      // The same command again: the token is used, and nothing changes.
      const reused = await run(shell, first.install, repo);
      expect(reused.status).not.toBe(0);
      expect(reused.out).toContain('Task Lite refused the download');

      // 2. Check: up to date.
      transcript.push(`## ${shell}: check`);
      const c1 = await run(shell, first.check, repo);
      expect(c1.status, c1.out).toBe(0);
      expect(c1.out).toContain('Up to date: all 6 files match what Task Lite sent.');

      // 3. Edit one file, delete another, add an extra folder: the check lists them.
      const worker = join(repo, '.claude/skills/tasklite-worker/SKILL.md');
      writeFileSync(worker, `${readFileSync(worker, 'utf8')}\nLocal tweak.\n`);
      rmSync(join(repo, '.claude/skills/tasklite-planner/SKILL.md'));
      mkdirSync(join(repo, '.claude/skills/tasklite-old'));
      transcript.push(`## ${shell}: check after an edit and a delete`);
      const c2 = await run(shell, first.check, repo);
      expect(c2.status, c2.out).toBe(0);
      expect(c2.out).toMatch(
        /^edited +\.claude\/skills\/tasklite-worker\/SKILL\.md +\(sent skill:tasklite-worker afv_/m,
      );
      expect(c2.out).toMatch(
        /^missing +\.claude\/skills\/tasklite-planner\/SKILL\.md +\(sent skill:tasklite-planner afv_/m,
      );
      expect(c2.out).toMatch(/^extra +\.claude\/skills\/tasklite-old\/$/m);
      expect(c2.out).not.toMatch(/^edited +CLAUDE\.md/m);
      expect(c2.out).toContain('Differs from what Task Lite sent: 3 file(s).');

      // An edit inside the markers is an edit of the block.
      const text = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
      writeFileSync(
        join(repo, 'CLAUDE.md'),
        text.replace('## Work tracking: Task Lite', '## Work tracking (ours)'),
      );
      const c3 = await run(shell, first.check, repo);
      expect(c3.out).toMatch(/^edited +CLAUDE\.md +\(sent agents_block afv_/m);

      // 4. Reinstall with a new command: restored; the extra folder is kept (never deleted).
      const second = await install();
      transcript.push(`## ${shell}: reinstall`);
      const i2 = await run(shell, second.install, repo);
      expect(i2.status, i2.out).toBe(0);
      expect(i2.out).toContain(
        'replaced the Task Lite section of CLAUDE.md (nothing else changed)',
      );
      const c4 = await run(shell, second.check, repo);
      expect(c4.out).not.toMatch(/^(edited|missing) /m);
      expect(c4.out).toMatch(/^extra +\.claude\/skills\/tasklite-old\/$/m);
      expect(existsSync(join(repo, '.claude/skills/tasklite-old'))).toBe(true);
      const after = readFileSync(join(repo, 'CLAUDE.md'));
      expect(after.subarray(0, Buffer.byteLength(PRE)).equals(Buffer.from(PRE))).toBe(true);
      expect(after.toString('utf8').endsWith(`${TASKLITE_END}\n`)).toBe(true);
    },
  );

  it.skipIf(!SHELLS[shell])('refuses a folder without .git before using the token', async () => {
    const dir = join(tmp.dir, `not-a-repo-${shell}`);
    mkdirSync(dir, { recursive: true });
    const created = await request('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      method: 'command',
    });
    const key = shell === 'bash' ? 'bash' : 'powershell';
    const cmd = (created.command as Record<string, string>)[key]!;
    const r = await run(shell, cmd, dir);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('Run this from the repo folder');
    // The token is still unused: the same command works from a repo.
    const repo = join(tmp.dir, `late-repo-${shell}`);
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect((await run(shell, cmd, repo)).status).toBe(0);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').startsWith(TASKLITE_BEGIN)).toBe(true);
  });

  it.skipIf(!SHELLS[shell])(
    'refuses a CLAUDE.md with a damaged section, writing nothing',
    async () => {
      const repo = join(tmp.dir, `damaged-${shell}`);
      mkdirSync(join(repo, '.git'), { recursive: true });
      const damaged = `# Mine\n${TASKLITE_BEGIN}\nno end marker\n`;
      writeFileSync(join(repo, 'CLAUDE.md'), damaged);
      const created = await request('POST', '/api/installs', {
        client: 'claude',
        target_kind: 'repo',
        method: 'command',
      });
      const key = shell === 'bash' ? 'bash' : 'powershell';
      const r = await run(shell, (created.command as Record<string, string>)[key]!, repo);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('has a damaged Task Lite section');
      expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(damaged);
      expect(existsSync(join(repo, '.claude'))).toBe(false);
    },
  );
});
