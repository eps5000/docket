/**
 * The copy-paste install and check commands, run for real (T155, T156):
 * a listening Docket, a scratch repo with a `.git` folder and a CLAUDE.md
 * of its own, and each shell that is on this machine (bash with curl, tar
 * and sha256sum; PowerShell 7 `pwsh`; Windows PowerShell 5.1). Each shell:
 * 1. installs by the one-liner (download, unpack, the bundle's install step);
 * 2. checks: up to date;
 * 3. after one installed file is edited and another deleted, and an extra
 *    docket-* folder added, checks again: edited, missing, extra;
 * 4. reinstalls with a new command, which restores them;
 * and the CLAUDE.md text outside the markers stays byte-identical throughout.
 * The connection file (decision 32): the install adds the docket server to
 * an existing `.mcp.json` (or `.codex/config.toml`) and keeps every other
 * byte; the check compares only the docket entry; an invalid file stops the
 * install before anything is written.
 *
 * A shell that isn't installed skips (CI's no-network container has bash but
 * no curl; the GitHub runner has bash and pwsh). The transcripts are printed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import {
  DOCKET_BEGIN,
  DOCKET_END,
  connectionEntry,
  mergeConnection,
  LEGACY_BEGIN,
  LEGACY_END,
  instructionsInput,
  type InstructionsInput,
} from '@docket/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { insertProject, tempDir, type TempDir } from '../helpers.js';
import { createTestServer, parseSetCookies, type TestServer } from './harness.js';

// Each test runs several shells and downloads: well over the default 5 s.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

type S = Record<string, unknown>;
const transcript: string[] = [];

function which(cmd: string, probe: string[]): string | null {
  const r = spawnSync(cmd, probe, { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? cmd : null;
}

/** bash with curl, tar and sha256sum (or shasum). On Windows, Git's bash, never WSL's. */
function findBash(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [process.env.DOCKET_TEST_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe'].filter(Boolean)
      : [process.env.DOCKET_TEST_BASH ?? 'bash'];
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
  tmp = tempDir('docket-shell-');
  s = createTestServer({ env: { DOCKET_ALLOWED_HOSTS: `127.0.0.1:${port}` }, log: () => {} });
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
  const cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${cookies.docket_csrf!.value}`;
  request = async (method, path, body) => {
    const r = await fetch(`${origin}${path}`, {
      method,
      headers: {
        cookie,
        'x-docket-csrf': cookies.docket_csrf!.value,
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
      ? ['-s']
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
    // bash reads it from stdin too, as a pasted line (Windows argument quoting would mangle a long -c).
    if (shell === 'bash')
      child.stdin.end(`${command}
`);
    else child.stdin.end(`${command}\nif (-not $?) { exit 1 }\nexit 0\n`);
  });
  const out = r.out.replace(/\r\n/g, '\n').trimEnd();
  transcript.push(`$ (${shell}, in ${cwd.slice(tmp.dir.length + 1) || '.'})`, out, '');
  return { status: r.status, out };
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function readManifest(repo: string) {
  return JSON.parse(readFileSync(join(repo, '.claude/.docket-manifest.json'), 'utf8')) as {
    install_id: string;
    files: { key: string; sha256: string }[];
  };
}

/**
 * Run the installed docket-check as an agent would (one shell call), and
 * parse its one line of JSON with `claim_lead`'s own `instructions` schema.
 * PowerShell runs it as a script block, so the Restricted policy allows it.
 */
async function report(shell: ShellName, repo: string): Promise<InstructionsInput> {
  const cmd =
    shell === 'bash'
      ? 'bash .claude/docket-check.sh'
      : "& ([scriptblock]::Create([IO.File]::ReadAllText((Resolve-Path '.claude/docket-check.ps1').ProviderPath))) (Resolve-Path '.claude').ProviderPath";
  const r = await run(shell, cmd, repo);
  expect(r.status, r.out).toBe(0);
  // pwsh on Linux, fed commands on stdin, may put terminal escape codes before the line.
  const lines = r.out
    .split('\n')
    .filter((l) => l.includes('{"install_id"'))
    .map((l) => l.slice(l.indexOf('{"install_id"')));
  expect(lines, r.out).toHaveLength(1);
  return instructionsInput.parse(JSON.parse(lines[0]!));
}

const PRE =
  '# Recipes\r\n\r\nOur own rules — keep them exactly. Ünïcödé.\r\n\r\n## Build\r\n`pnpm build`';

/** The owner's own .mcp.json: another server, CRLF, non-ASCII. */
const MCP_BEFORE =
  '{\r\n  "mcpServers": {\r\n    "github": { "command": "gh-mcp", "args": ["--café"] }\r\n  }\r\n}\r\n';
const MCP_BEFORE_LATIN1 = Buffer.from(MCP_BEFORE, 'utf8').toString('latin1');
const connEntry = (client: 'claude' | 'codex') =>
  connectionEntry(client, `http://127.0.0.1:${port}/mcp`, false);

describe.each(Object.keys(SHELLS) as ShellName[])('the %s commands', (shell) => {
  it.skipIf(!SHELLS[shell])(
    'install, check, edit, check, reinstall: byte-identical outside the markers',
    async () => {
      const repo = join(tmp.dir, `repo-${shell}`);
      mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(join(repo, 'CLAUDE.md'), PRE);
      writeFileSync(join(repo, '.mcp.json'), MCP_BEFORE);
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
      expect(i1.out).toContain('wrote .claude/skills/docket-worker/SKILL.md');
      expect(i1.out).toContain('added the Docket section to the end of CLAUDE.md');
      const claude = readFileSync(join(repo, 'CLAUDE.md'));
      expect(claude.subarray(0, Buffer.byteLength(PRE)).equals(Buffer.from(PRE))).toBe(true);
      expect(claude.subarray(Buffer.byteLength(PRE)).toString('utf8')).toMatch(
        new RegExp(
          `^\\n\\n${DOCKET_BEGIN}\\n## Work tracking: Docket[\\s\\S]*\\n${DOCKET_END}\\n$`,
        ),
      );
      expect(existsSync(join(repo, '.claude/.docket-manifest.json'))).toBe(true);
      // The connection file: docket added next to the owner's server, every other byte kept.
      expect(i1.out).toContain('added the docket server to .mcp.json (nothing else changed)');
      expect(i1.out).toContain(
        'Then open Claude Code in this repo and approve Docket when it asks.',
      );
      const mcp = readFileSync(join(repo, '.mcp.json'), 'latin1');
      expect(mcp).toBe(mergeConnection('claude', MCP_BEFORE_LATIN1, connEntry('claude')).text);
      expect(Object.keys((JSON.parse(mcp) as { mcpServers: object }).mcpServers)).toEqual([
        'docket',
        'github',
      ]);
      expect(mcp).not.toContain(s.runtime.secrets.agentToken());

      // The same command again: the token is used, and nothing changes.
      const reused = await run(shell, first.install, repo);
      expect(reused.status).not.toBe(0);
      expect(reused.out).toContain('Docket refused the download');

      // 2. Check: up to date.
      transcript.push(`## ${shell}: check`);
      const c1 = await run(shell, first.check, repo);
      expect(c1.status, c1.out).toBe(0);
      expect(c1.out).toContain('Up to date: all 7 files match what Docket sent.');

      // The installed docket-check (decision 30): every file listed by hash, no text.
      const manifest = readManifest(repo);
      transcript.push(`## ${shell}: docket-check, as installed`);
      const r1 = await report(shell, repo);
      expect(r1.install_id).toBe(manifest.install_id);
      // The connection file isn't reported to claim_lead (decision 32): only the push and copy-paste checks read it.
      expect(manifest.files.some((f) => f.key === 'connection')).toBe(true);
      expect(r1.files).toEqual(
        manifest.files
          .filter((f) => f.key !== 'connection')
          .map((f) => ({ key: f.key, sha256: f.sha256 })),
      );

      // Another server's entry edited: not drift. The docket entry edited: drift.
      writeFileSync(join(repo, '.mcp.json'), mcp.replace('"gh-mcp"', '"gh-mcp2"'), 'latin1');
      const cOther = await run(shell, first.check, repo);
      expect(cOther.out).toContain('Up to date: all 7 files match what Docket sent.');
      writeFileSync(
        join(repo, '.mcp.json'),
        mcp.replace(':' + port + '/mcp', ':9999/mcp'),
        'latin1',
      );
      const cDocket = await run(shell, first.check, repo);
      expect(cDocket.out).toMatch(/^edited +\.mcp\.json +\(sent connection connection:local\)$/m);
      writeFileSync(join(repo, '.mcp.json'), mcp, 'latin1');

      // 3. Edit one file, delete another, add an extra folder: the check lists them.
      const worker = join(repo, '.claude/skills/docket-worker/SKILL.md');
      const edited = `${readFileSync(worker, 'utf8')}\nLocal tweak: "quotes", \\back\\slashes,\ttabs, Ünïcödé.\r\n`;
      writeFileSync(worker, edited);
      rmSync(join(repo, '.claude/skills/docket-planner/SKILL.md'));
      mkdirSync(join(repo, '.claude/skills/docket-old'));
      // docket-check: the edited file with its text (CRs removed, as hashed), the
      // missing one left out, the extra folder listed.
      transcript.push(`## ${shell}: docket-check after an edit, a delete and an extra folder`);
      const r2 = await report(shell, repo);
      const noCr = edited.replace(/\r/g, '');
      expect(r2.files.find((f) => f.key === 'skill:docket-worker')).toEqual({
        key: 'skill:docket-worker',
        sha256: sha256(noCr),
        content: noCr,
      });
      expect(r2.files.some((f) => f.key === 'skill:docket-planner')).toBe(false);
      expect(r2.files.find((f) => f.key === 'skill:docket-old')).toEqual({
        key: 'skill:docket-old',
        sha256: sha256(''),
      });
      // Unchanged files still carry no text.
      expect(r2.files.filter((f) => f.content !== undefined).map((f) => f.key)).toEqual([
        'skill:docket-worker',
      ]);

      transcript.push(`## ${shell}: check after an edit and a delete`);
      const c2 = await run(shell, first.check, repo);
      expect(c2.status, c2.out).toBe(0);
      expect(c2.out).toMatch(
        /^edited +\.claude\/skills\/docket-worker\/SKILL\.md +\(sent skill:docket-worker afv_/m,
      );
      expect(c2.out).toMatch(
        /^missing +\.claude\/skills\/docket-planner\/SKILL\.md +\(sent skill:docket-planner afv_/m,
      );
      expect(c2.out).toMatch(/^extra +\.claude\/skills\/docket-old\/$/m);
      expect(c2.out).not.toMatch(/^edited +CLAUDE\.md/m);
      expect(c2.out).toContain('Differs from what Docket sent: 3 file(s).');

      // An edit inside the markers is an edit of the block.
      const text = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
      writeFileSync(
        join(repo, 'CLAUDE.md'),
        text.replace('## Work tracking: Docket', '## Work tracking (ours)'),
      );
      const c3 = await run(shell, first.check, repo);
      expect(c3.out).toMatch(/^edited +CLAUDE\.md +\(sent agents_block afv_/m);
      // docket-check sends the block's text between the markers, as hashed.
      const r3 = await report(shell, repo);
      const block = r3.files.find((f) => f.key === 'agents_block')!;
      expect(block.content).toMatch(/^## Work tracking \(ours\)\n/);
      expect(block.sha256).toBe(sha256(block.content!));
      expect(block.sha256).not.toBe(manifest.files.find((f) => f.key === 'agents_block')!.sha256);

      // 4. Reinstall with a new command: restored; the extra folder is kept (never deleted).
      const second = await install();
      transcript.push(`## ${shell}: reinstall`);
      const i2 = await run(shell, second.install, repo);
      expect(i2.status, i2.out).toBe(0);
      expect(i2.out).toContain('replaced the Docket section of CLAUDE.md (nothing else changed)');
      const c4 = await run(shell, second.check, repo);
      expect(c4.out).not.toMatch(/^(edited|missing) /m);
      expect(c4.out).toMatch(/^extra +\.claude\/skills\/docket-old\/$/m);
      expect(existsSync(join(repo, '.claude/skills/docket-old'))).toBe(true);
      const after = readFileSync(join(repo, 'CLAUDE.md'));
      expect(after.subarray(0, Buffer.byteLength(PRE)).equals(Buffer.from(PRE))).toBe(true);
      expect(after.toString('utf8').endsWith(`${DOCKET_END}\n`)).toBe(true);
    },
  );

  it.skipIf(!SHELLS[shell])(
    'Codex: config.toml gets the docket table; an invalid .mcp.json stops the install before anything is written',
    async () => {
      const key = shell === 'bash' ? 'bash' : 'powershell';
      const commands = async (client: 'claude' | 'codex') => {
        const created = await request('POST', '/api/installs', {
          client,
          target_kind: 'repo',
          project: 'RCP',
          method: 'command',
        });
        return {
          install: (created.command as Record<string, string>)[key]!,
          check: (created.check_command as Record<string, string>)[key]!,
        };
      };

      const repo = join(tmp.dir, `codex-${shell}`);
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.codex'));
      const TOML =
        'model = "gpt-5"\r\n\r\n[mcp_servers.github]\r\ncommand = "gh"\r\nargs = [\r\n  "a",\r\n]\r\n';
      writeFileSync(join(repo, '.codex/config.toml'), TOML);
      transcript.push(`## ${shell}: Codex install with an existing config.toml`);
      const codex = await commands('codex');
      const i = await run(shell, codex.install, repo);
      expect(i.status, i.out).toBe(0);
      expect(i.out).toContain(
        'added the docket server to .codex/config.toml (nothing else changed)',
      );
      expect(i.out).toContain('Then open Codex in this repo and approve Docket when it asks.');
      expect(readFileSync(join(repo, '.codex/config.toml'), 'latin1')).toBe(
        `${TOML}\n${connEntry('codex')}`,
      );
      const c = await run(shell, codex.check, repo);
      expect(c.out).toContain('Up to date: all 7 files match what Docket sent.');
      // The docket table edited: drift; another table edited: not.
      const toml = readFileSync(join(repo, '.codex/config.toml'), 'latin1');
      writeFileSync(join(repo, '.codex/config.toml'), toml.replace('"gh"', '"gh2"'), 'latin1');
      expect((await run(shell, codex.check, repo)).out).toContain('Up to date: all 7 files');
      writeFileSync(
        join(repo, '.codex/config.toml'),
        `${toml}bearer_token_env_var = "X"\n`,
        'latin1',
      );
      expect((await run(shell, codex.check, repo)).out).toMatch(
        /^edited +\.codex\/config\.toml +\(sent connection connection:local\)$/m,
      );

      const bad = join(tmp.dir, `invalid-${shell}`);
      mkdirSync(join(bad, '.git'), { recursive: true });
      const INVALID = '{"mcpServers": {"a": {},}}\n';
      writeFileSync(join(bad, '.mcp.json'), INVALID);
      transcript.push(`## ${shell}: install with an invalid .mcp.json`);
      const refused = await run(shell, (await commands('claude')).install, bad);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain(".mcp.json isn't valid JSON (unexpected character)");
      expect(refused.out).toContain('Nothing was written.');
      expect(existsSync(join(bad, '.claude'))).toBe(false);
      expect(existsSync(join(bad, 'CLAUDE.md'))).toBe(false);
      expect(readFileSync(join(bad, '.mcp.json'), 'utf8')).toBe(INVALID);
    },
  );

  it.skipIf(!SHELLS[shell])(
    'an install from before the rename: old section replaced, unmodified old folders removed, the edited one kept and reported',
    async () => {
      const repo = join(tmp.dir, `old-${shell}`);
      mkdirSync(join(repo, '.git'), { recursive: true });
      const OLD_WORKER = '---\nname: tasklite-worker\n---\n# Worker\n';
      const OLD_PLANNER = '---\nname: tasklite-planner\n---\n# Planner\n';
      const OLD_BLOCK = '## Work tracking: the old name';
      for (const [name, text] of [
        ['tasklite-worker', OLD_WORKER],
        ['tasklite-planner', OLD_PLANNER],
        ['tasklite-mine', '# Never installed by Docket\n'],
      ] as const) {
        mkdirSync(join(repo, '.claude/skills', name), { recursive: true });
        writeFileSync(join(repo, '.claude/skills', name, 'SKILL.md'), text);
      }
      const line = (key: string, path: string, text: string) =>
        `    ${JSON.stringify({ key, path, version_id: 'afv_old', sha256: sha256(text) })}`;
      writeFileSync(
        join(repo, '.claude/.tasklite-manifest.json'),
        [
          '{',
          '  "install_id": "ins_old",',
          '  "files": [',
          `${line('skill:tasklite-worker', '.claude/skills/tasklite-worker/SKILL.md', OLD_WORKER)},`,
          `${line('skill:tasklite-planner', '.claude/skills/tasklite-planner/SKILL.md', OLD_PLANNER)},`,
          line('agents_block', 'CLAUDE.md', OLD_BLOCK),
          '  ]',
          '}',
          '',
        ].join('\n'),
      );
      writeFileSync(join(repo, '.claude/tasklite-check.sh'), '# the old check\n');
      const POST = '\r\nAfter the section: ours. Ünïcödé.\r\n';
      writeFileSync(
        join(repo, 'CLAUDE.md'),
        `${PRE}\r\n\r\n${LEGACY_BEGIN}\n${OLD_BLOCK}\n${LEGACY_END}${POST}`,
      );
      // Edited after the old install.
      const editedPlanner = `${OLD_PLANNER}- Our own rule.\n`;
      writeFileSync(join(repo, '.claude/skills/tasklite-planner/SKILL.md'), editedPlanner);

      const key = shell === 'bash' ? 'bash' : 'powershell';
      const created = await request('POST', '/api/installs', {
        client: 'claude',
        target_kind: 'repo',
        project: 'RCP',
        method: 'command',
      });
      const check = (created.check_command as Record<string, string>)[key]!;

      // Before reinstalling, the check command reads the old manifest and markers.
      transcript.push(`## ${shell}: check an install from before the rename`);
      const c0 = await run(shell, check, repo);
      expect(c0.status, c0.out).toBe(0);
      expect(c0.out).toContain('against Docket install ins_old');
      expect(c0.out).toMatch(/^edited +\.claude\/skills\/tasklite-planner\/SKILL\.md/m);
      expect(c0.out).not.toMatch(/CLAUDE\.md/);
      expect(c0.out).toMatch(/^extra +\.claude\/skills\/tasklite-mine\/ +\(old name\)$/m);

      transcript.push(`## ${shell}: install over it`);
      const i = await run(shell, (created.command as Record<string, string>)[key]!, repo);
      expect(i.status, i.out).toBe(0);
      expect(i.out).toContain('removed .claude/skills/tasklite-worker/ (the old name, unmodified)');
      expect(i.out).toContain('kept .claude/skills/tasklite-planner/ (old name, edited locally)');
      expect(i.out).toContain(
        'replaced the old tasklite section of CLAUDE.md with the Docket section (nothing else changed)',
      );
      expect(i.out).toContain(
        'left .claude/.tasklite-manifest.json .claude/tasklite-check.sh from before the rename',
      );
      expect(existsSync(join(repo, '.claude/skills/tasklite-worker'))).toBe(false);
      expect(readFileSync(join(repo, '.claude/skills/tasklite-planner/SKILL.md'), 'utf8')).toBe(
        editedPlanner,
      );
      expect(existsSync(join(repo, '.claude/skills/tasklite-mine/SKILL.md'))).toBe(true);
      expect(existsSync(join(repo, '.claude/.tasklite-manifest.json'))).toBe(true);
      const claude = readFileSync(join(repo, 'CLAUDE.md'));
      const pre = Buffer.from(`${PRE}\r\n\r\n`);
      expect(claude.subarray(0, pre.length).equals(pre)).toBe(true);
      expect(claude.subarray(claude.length - Buffer.byteLength(POST)).toString('utf8')).toBe(POST);
      const text = claude.toString('utf8');
      expect(text).toContain(`${DOCKET_BEGIN}\n## Work tracking: Docket`);
      expect(text).not.toContain(LEGACY_BEGIN);
      expect(text).not.toContain(OLD_BLOCK);

      // docket-check reports the old folders the new manifest doesn't list, with their text.
      transcript.push(`## ${shell}: docket-check after the install`);
      const r = await report(shell, repo);
      expect(r.files.find((f) => f.key === 'skill:tasklite-planner')).toEqual({
        key: 'skill:tasklite-planner',
        sha256: sha256(editedPlanner),
        content: editedPlanner,
      });
      expect(r.files.some((f) => f.key === 'skill:tasklite-mine')).toBe(true);
      expect(r.files.some((f) => f.key === 'skill:tasklite-worker')).toBe(false);
      const c1 = await run(shell, check, repo);
      expect(c1.out).toMatch(/^extra +\.claude\/skills\/tasklite-planner\/ +\(old name\)$/m);
      expect(c1.out).not.toMatch(/^(edited|missing) /m);

      // A second install removes nothing more: the edited folder isn't recorded by the new manifest.
      const again = await request('POST', '/api/installs', {
        client: 'claude',
        target_kind: 'repo',
        project: 'RCP',
        method: 'command',
      });
      const i2 = await run(shell, (again.command as Record<string, string>)[key]!, repo);
      expect(i2.status, i2.out).toBe(0);
      expect(existsSync(join(repo, '.claude/skills/tasklite-planner/SKILL.md'))).toBe(true);
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
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').startsWith(DOCKET_BEGIN)).toBe(true);
  });

  it.skipIf(!SHELLS[shell])(
    'refuses a CLAUDE.md with a damaged section, writing nothing',
    async () => {
      const repo = join(tmp.dir, `damaged-${shell}`);
      mkdirSync(join(repo, '.git'), { recursive: true });
      const damaged = `# Mine\n${DOCKET_BEGIN}\nno end marker\n`;
      writeFileSync(join(repo, 'CLAUDE.md'), damaged);
      const created = await request('POST', '/api/installs', {
        client: 'claude',
        target_kind: 'repo',
        method: 'command',
      });
      const key = shell === 'bash' ? 'bash' : 'powershell';
      const r = await run(shell, (created.command as Record<string, string>)[key]!, repo);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('has a damaged Docket section');
      expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(damaged);
      expect(existsSync(join(repo, '.claude'))).toBe(false);
    },
  );
  it.skipIf(!SHELLS[shell])(
    'installs both clients from one command; a new CLAUDE.md imports the repo’s AGENTS.md (decision 34)',
    async () => {
      const repo = join(tmp.dir, `both-${shell}`);
      mkdirSync(join(repo, '.git'), { recursive: true });
      const own = '# Our agent rules\n\nRun pnpm test before every commit.\n';
      writeFileSync(join(repo, 'AGENTS.md'), own);
      const created = await request('POST', '/api/installs', {
        clients: ['codex', 'claude'],
        target_kind: 'repo',
        project: 'RCP',
        method: 'command',
      });
      const parts = created.clients as { client: string; install_id: string; files: S[] }[];
      expect(parts.map((p) => p.client)).toEqual(['claude', 'codex']);
      const key = shell === 'bash' ? 'bash' : 'powershell';
      const r = await run(shell, (created.command as Record<string, string>)[key]!, repo);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('Claude Code:');
      expect(r.out).toContain('Codex:');
      // CLAUDE.md is new and starts with the import, outside the markers.
      const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
      expect(claude.startsWith(`@AGENTS.md\n\n${DOCKET_BEGIN}\n`)).toBe(true);
      // AGENTS.md keeps the owner's text exactly, with the Docket section after it.
      const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
      expect(agents.startsWith(`${own}\n${DOCKET_BEGIN}\n`)).toBe(true);
      for (const f of [
        '.claude/.docket-manifest.json',
        '.codex/.docket-manifest.json',
        '.mcp.json',
        '.codex/config.toml',
        '.claude/skills/docket-worker/SKILL.md',
        '.codex/skills/docket-worker/SKILL.md',
      ]) {
        expect(existsSync(join(repo, f)), f).toBe(true);
      }
      // One download logs both installs.
      const log = (await request('GET', '/api/installs?project=RCP')).installs as S[];
      const ids = parts.map((p) => p.install_id);
      expect(log.filter((row) => ids.includes(row.id as string))).toHaveLength(2);
      // A second install never adds the import to the CLAUDE.md that now exists.
      const again = await request('POST', '/api/installs', {
        client: 'claude',
        target_kind: 'repo',
        project: 'RCP',
        method: 'command',
      });
      expect((await run(shell, (again.command as Record<string, string>)[key]!, repo)).status).toBe(
        0,
      );
      expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').match(/@AGENTS\.md/g)).toHaveLength(1);
    },
  );

  it.skipIf(!SHELLS[shell])(
    'a damaged AGENTS.md stops every client before anything is written (decision 34)',
    async () => {
      const repo = join(tmp.dir, `both-damaged-${shell}`);
      mkdirSync(join(repo, '.git'), { recursive: true });
      const damaged = `# Mine\n${DOCKET_BEGIN}\nno end marker\n`;
      writeFileSync(join(repo, 'AGENTS.md'), damaged);
      const created = await request('POST', '/api/installs', {
        clients: ['claude', 'codex'],
        target_kind: 'repo',
        method: 'command',
      });
      const key = shell === 'bash' ? 'bash' : 'powershell';
      const r = await run(shell, (created.command as Record<string, string>)[key]!, repo);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('has a damaged Docket section');
      expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe(damaged);
      expect(existsSync(join(repo, '.claude'))).toBe(false);
      expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);
    },
  );
});
