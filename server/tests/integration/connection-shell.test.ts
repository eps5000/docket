/**
 * The connection-file scanners agree across the three implementations
 * (decision 32; BUILD_SPEC §5.17a; T168): TypeScript (push install, push
 * check, drift), awk (the bash install step and check command) and
 * PowerShell (the PowerShell install step and check command, in both its
 * multi-line and one-line forms). Each runs over the same files, read as
 * bytes, and must give the same verdict, the same offsets and the same
 * canonical `docket` entry.
 *
 * A shell that isn't installed skips (CI's runner has bash and pwsh).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONNECTION_AWK,
  CONNECTION_PS1,
  CONNECTION_PS1_ONE_LINE,
  installedConnection,
  scanJson,
  scanToml,
} from '@docket/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tempDir, type TempDir } from '../helpers.js';

// Dozens of shell runs: well over the default 5 s on a busy machine.
vi.setConfig({ testTimeout: 120_000 });

const JSON_FILES: Record<string, string> = {
  empty: '',
  blank: ' \r\n',
  emptyObject: '{}',
  fresh:
    '{\n  "mcpServers": {\n    "docket": {\n      "type": "http",\n      "url": "http://127.0.0.1:7420/mcp"\n    }\n  }\n}\n',
  others:
    '{\r\n  "mcpServers": {\r\n    "github": { "command": "gh-mcp", "args": ["--x", "caf\u00e9 \\"q\\" \\\\"] }\r\n  },\r\n  "other": [1, -2.5e3, true, null, {"a": []}]\r\n}\r\n',
  docketMiddle:
    '{"x":1,"mcpServers":{"a":{"url":"u"},"docket":{"type":"http","url":"http://old:1/mcp","headers":{"A":"b"}},"z":{}}}',
  docketScalar: '{"mcpServers": {"docket": "off"}}',
  emptyServers: '{ "mcpServers": { } }\n',
  noFinalNewline: '{"a": 1}',
  nested: '{"a": {"mcpServers": {"docket": 1}}, "mcpServers": {"b": {"docket": 2}}}',
  trailingComma: '{"mcpServers": {"a": {},}}',
  comment: '{"a": 1 // mine\n}',
  unclosed: '{"mcpServers": {"a',
  missingBrace: '{"mcpServers": {}',
  array: '[]',
  two: '{} {}',
  serversList: '{"mcpServers": []}',
  serversTwice: '{"mcpServers": {}, "mcpServers": {}}',
  docketTwice: '{"mcpServers": {"docket": {}, "docket": {}}}',
  badLiteral: '{"a": tru}',
  mismatched: '{"a": [1}',
  newlineInString: '{"a": "x\ny"}',
  bom: '\ufeff{}',
};

const TOML_FILES: Record<string, string> = {
  empty: '',
  fresh: '[mcp_servers.docket]\nurl = "http://127.0.0.1:7420/mcp"\n',
  others: [
    'model = "gpt-5"',
    '',
    '[mcp_servers.github]',
    'command = "gh-mcp"',
    'args = [',
    '  "--read-only", # comment [',
    '  "x]",',
    ']',
    "env = { TOKEN_VAR = 'GH' }",
    'notes = """',
    '[not a table]',
    '"""',
    "lit = '''a",
    "b'''",
    '',
  ].join('\n'),
  replace: [
    '# my config',
    '[mcp_servers.docket]',
    'url = "http://old:1/mcp"   # old',
    'bearer_token_env_var = "DOCKET_TOKEN"',
    '',
    '# the next one',
    '[mcp_servers."other"]',
    'url = "x"',
    '',
  ].join('\r\n'),
  quoted: '[ mcp_servers . "docket" ]  # mine\nurl = "x"',
  subtable: '[mcp_servers.docket]\nurl = "x"\n[mcp_servers.docket.env]\nA = "caf\u00e9"\n',
  arrayTable: '[[mcp_servers.docket]]\nurl = "x"\n',
  strayLine: 'model = "x"\njust words\n',
  unclosedString: 'a = "x\n',
  unclosedArray: 'a = [1,\n2\n',
  unclosedMl: 'a = """\nx\n',
  badHeader: '[mcp_servers.x\n',
  twice: '[mcp_servers.docket]\na = 1\n[mcp_servers.docket]\n',
  dotted: 'mcp_servers.docket.url = "x"\n',
  inline: '[mcp_servers]\ndocket = { url = "x" }\n',
  dottedInTable: '[mcp_servers]\ndocket.url = "x"\n',
};

function which(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? cmd : null;
}
const BASH =
  process.platform === 'win32'
    ? existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
      ? 'C:\\Program Files\\Git\\bin\\bash.exe'
      : null
    : which('bash', ['-c', 'command -v awk']);
const PWSH = which('pwsh', ['-NoProfile', '-Command', 'exit 0']);
const POWERSHELL =
  process.platform === 'win32' ? which('powershell', ['-NoProfile', '-Command', 'exit 0']) : null;

let tmp: TempDir;
const files: { kind: 'json' | 'toml'; name: string; path: string; latin1: string }[] = [];

beforeAll(() => {
  tmp = tempDir('docket-conn-');
  for (const [kind, set] of [
    ['json', JSON_FILES],
    ['toml', TOML_FILES],
  ] as const) {
    for (const [name, text] of Object.entries(set)) {
      const path = join(tmp.dir, `${kind}-${name}`);
      writeFileSync(path, Buffer.from(text, 'utf8'));
      files.push({ kind, name, path, latin1: readFileSync(path).toString('latin1') });
    }
  }
});
afterAll(() => tmp?.cleanup());

/** What the TypeScript scanners say, in the awk `pos` line format. */
function expectedPos(kind: 'json' | 'toml', text: string): string {
  if (kind === 'json') {
    const r = scanJson(text);
    if (!r.ok) return `err ${r.error}`;
    const b = (v: boolean) => (v ? 1 : 0);
    return `ok ${b(r.nonEmpty)} ${r.topOpen} ${r.topClose} ${b(r.topEmpty)} ${r.srvOpen} ${r.srvClose} ${b(r.srvEmpty)} ${r.dkStart} ${r.dkEnd}`;
  }
  const r = scanToml(text);
  if (!r.ok) return `err ${r.error}`;
  return `ok ${r.hdrStart} ${r.regionEnd}`;
}

function expectedCanon(kind: 'json' | 'toml', text: string): string {
  const c = installedConnection(kind === 'json' ? 'claude' : 'codex', text);
  return c === null ? '!absent' : c;
}

describe.skipIf(!BASH)('awk (bash)', () => {
  function awk(mode: string, out: string, path: string): string {
    const r = spawnSync(
      BASH!,
      ['-c', 'LC_ALL=C awk -v mode="$1" -v out="$2" "$A" "$3"', '_', mode, out, path],
      {
        env: { ...process.env, A: CONNECTION_AWK },
        encoding: 'latin1',
      },
    );
    expect(r.stderr).toBe('');
    return r.stdout;
  }

  it('gives the same verdicts and offsets as TypeScript', () => {
    for (const f of files) {
      expect(awk(f.kind, 'pos', f.path).trim(), `${f.kind} ${f.name}`).toBe(
        expectedPos(f.kind, f.latin1),
      );
    }
  });

  it('gives the same canonical docket entry', () => {
    for (const f of files) {
      const want = expectedCanon(f.kind, f.latin1);
      expect(awk(f.kind, 'canon', f.path), `${f.kind} ${f.name}`).toBe(
        want === 'invalid' ? '!invalid' : want,
      );
    }
  });
});

for (const [name, exe, source] of [
  ['pwsh, one-line form', PWSH, CONNECTION_PS1_ONE_LINE],
  ['pwsh, script form', PWSH, CONNECTION_PS1],
  ['Windows PowerShell 5.1', POWERSHELL, CONNECTION_PS1],
] as const) {
  describe.skipIf(!exe)(`PowerShell (${name})`, () => {
    it('gives the same verdicts, offsets and canonical entries as TypeScript', () => {
      const list = join(tmp.dir, `list-${name.replace(/\W+/g, '-')}.txt`);
      writeFileSync(list, files.map((f) => `${f.kind}\t${f.path}`).join('\n'));
      const script = [
        source,
        `$enc = [Text.Encoding]::GetEncoding(28591)`,
        `foreach ($l in [IO.File]::ReadAllLines('${list.replace(/'/g, "''")}')) {`,
        `$p = $l.Split([char]9); $s = $enc.GetString([IO.File]::ReadAllBytes($p[1]))`,
        `if ($p[0] -ceq 'json') { $r = DkJson $s; if ($r.ok) { $b = { param($v) if ($v) { 1 } else { 0 } }; $pos = 'ok ' + (& $b $r.nonEmpty) + ' ' + $r.topOpen + ' ' + $r.topClose + ' ' + (& $b $r.topEmpty) + ' ' + $r.srvOpen + ' ' + $r.srvClose + ' ' + (& $b $r.srvEmpty) + ' ' + $r.dkStart + ' ' + $r.dkEnd } else { $pos = 'err ' + $r.error }; $c = DkCanon 'claude' $s }`,
        `else { $r = DkToml $s; if ($r.ok) { $pos = 'ok ' + $r.hdrStart + ' ' + $r.regionEnd } else { $pos = 'err ' + $r.error }; $c = DkCanon 'codex' $s }`,
        `if ($null -eq $c) { $c = '!absent' }`,
        `[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ pos = $pos; canon = $enc.GetBytes($c) }))`,
        `}`,
      ].join('\n');
      // A script file: PowerShell reads `-Command -` line by line, which splits multi-line blocks.
      const ps1 = join(tmp.dir, `run-${name.replace(/W+/g, '-')}.ps1`);
      writeFileSync(ps1, script);
      const r = spawnSync(
        exe!,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
        {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      expect(r.stderr).toBe('');
      const lines = r.stdout
        .split(/\r?\n/)
        .map((l) => l.slice(Math.max(0, l.indexOf('{'))))
        .filter((l) => l.startsWith('{'));
      expect(lines, r.stdout.slice(0, 3000)).toHaveLength(files.length);
      lines.forEach((line, i) => {
        const f = files[i]!;
        const got = JSON.parse(line) as { pos: string; canon: number[] | number | null };
        const bytes = Array.isArray(got.canon) ? got.canon : got.canon === null ? [] : [got.canon];
        const want = expectedCanon(f.kind, f.latin1);
        expect(got.pos, `${f.kind} ${f.name}`).toBe(expectedPos(f.kind, f.latin1));
        expect(Buffer.from(bytes).toString('latin1'), `${f.kind} ${f.name}`).toBe(
          want === 'invalid' ? '!invalid' : want,
        );
      });
    });
  });
}
