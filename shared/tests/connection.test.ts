/**
 * Connection files (owner decision 32; BUILD_SPEC §5.17a; T168): merging the
 * `docket` entry into `.mcp.json` and `.codex/config.toml`, refusing files
 * that can't be updated safely, and the canonical text the check compares.
 * The awk and PowerShell versions are checked against these in
 * server/tests/integration/install-shell.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  ConnectionFileError,
  connectionCanonical,
  connectionEntry,
  installedConnection,
  mergeConnection,
  scanJson,
  scanToml,
} from '../src/index.js';

const URL = 'http://127.0.0.1:7420/mcp';
const claude = (pm = false) => connectionEntry('claude', URL, pm);
const codex = (pm = false) => connectionEntry('codex', URL, pm);
const mergeJ = (text: string | null, pm = false) =>
  mergeConnection('claude', text, claude(pm)).text;
const mergeT = (text: string | null, pm = false) => mergeConnection('codex', text, codex(pm)).text;

describe('.mcp.json (Claude Code)', () => {
  it('creates the file with only the docket server', () => {
    const out = mergeConnection('claude', null, claude());
    expect(out.how).toBe('created');
    expect(JSON.parse(out.text)).toEqual({ mcpServers: { docket: { type: 'http', url: URL } } });
    expect(out.text).toBe(
      '{\n  "mcpServers": {\n    "docket": {\n      "type": "http",\n      "url": "http://127.0.0.1:7420/mcp"\n    }\n  }\n}\n',
    );
  });

  it('adds docket next to other servers and keeps every other byte', () => {
    const before =
      '{\r\n  "mcpServers": {\r\n    "github": { "command": "gh-mcp", "args": ["--x"] }\r\n  },\r\n  "other": [1, 2.5e3, true, null]\r\n}\r\n';
    const out = mergeConnection('claude', before, claude());
    expect(out.how).toBe('added');
    const parsed = JSON.parse(out.text) as { mcpServers: Record<string, unknown>; other: unknown };
    expect(Object.keys(parsed.mcpServers)).toEqual(['docket', 'github']);
    expect(parsed.other).toEqual([1, 2500, true, null]);
    // Only an insertion: what was there before is still there, in order.
    const at = before.indexOf('{', 10) + 1;
    expect(out.text.startsWith(before.slice(0, at))).toBe(true);
    expect(out.text.endsWith(before.slice(at))).toBe(true);
  });

  it('replaces only the docket entry, wherever it is', () => {
    const before =
      '{"x":1,"mcpServers":{"a":{"url":"u"},"docket":{"type":"http","url":"http://old:1/mcp","headers":{"A":"b"}},"z":{}}}';
    const out = mergeConnection('claude', before, claude());
    expect(out.how).toBe('replaced');
    const parsed = JSON.parse(out.text) as { x: number; mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers).toEqual({
      a: { url: 'u' },
      docket: { type: 'http', url: URL },
      z: {},
    });
    expect(out.text.startsWith('{"x":1,"mcpServers":{"a":{"url":"u"},"docket":')).toBe(true);
    expect(out.text.endsWith(',"z":{}}}')).toBe(true);
    // Merging again changes nothing.
    expect(mergeJ(out.text)).toBe(out.text);
  });

  it.each([
    ['an empty object', '{}', { mcpServers: { docket: { type: 'http', url: URL } } }],
    [
      'an empty mcpServers',
      '{ "mcpServers": { } }\n',
      { mcpServers: { docket: { type: 'http', url: URL } } },
    ],
    [
      'other settings only',
      '{"a": 1}',
      { a: 1, mcpServers: { docket: { type: 'http', url: URL } } },
    ],
    ['a blank file', ' \n', { mcpServers: { docket: { type: 'http', url: URL } } }],
  ])('merges into %s', (_label, before, expected) => {
    expect(JSON.parse(mergeJ(before))).toEqual(expected);
  });

  it.each([
    ['a trailing comma', '{"mcpServers": {"a": {},}}', 'unexpected character'],
    ['a comment first', '// mine\n{}', 'not an object'],
    ['a comment inside', '{"a": 1 // mine\n}', 'unexpected character'],
    ['an unclosed string', '{"mcpServers": {"a', 'unclosed string'],
    ['a missing brace', '{"mcpServers": {}', 'ends early'],
    ['an array at the top', '[]', 'not an object'],
    ['two objects', '{} {}', 'text after the end'],
    ['mcpServers as a list', '{"mcpServers": []}', 'mcpServers is not an object'],
    ['mcpServers twice', '{"mcpServers": {}, "mcpServers": {}}', 'mcpServers appears twice'],
    ['docket twice', '{"mcpServers": {"docket": {}, "docket": {}}}', 'docket appears twice'],
    ['a bad literal', '{"a": tru}', 'unexpected value'],
    ['a mismatched bracket', '{"a": [1}', 'mismatched bracket'],
    ['a newline in a string', '{"a": "x\ny"}', 'control character in a string'],
  ])('refuses %s, and says why', (_label, before, detail) => {
    expect(scanJson(before)).toEqual({ ok: false, error: detail });
    expect(() => mergeJ(before)).toThrow(ConnectionFileError);
    expect(() => mergeJ(before)).toThrow(`.mcp.json isn't valid JSON (${detail})`);
    expect(() => mergeJ(before)).toThrow(/Nothing was written/);
  });

  it('protected mode names the token through ${DOCKET_TOKEN}, never its value', () => {
    const out = JSON.parse(mergeJ(null, true)) as {
      mcpServers: { docket: { headers: Record<string, string> } };
    };
    expect(out.mcpServers.docket.headers).toEqual({ Authorization: 'Bearer ${DOCKET_TOKEN}' });
    expect(connectionCanonical('claude', URL, true)).toBe(
      '{"type":"http","url":"http://127.0.0.1:7420/mcp","headers":{"Authorization":"Bearer ${DOCKET_TOKEN}"}}',
    );
  });

  it('the check compares only the docket entry, ignoring whitespace', () => {
    const installed = mergeJ('{"mcpServers": {"github": {"command": "gh"}}}');
    const sent = connectionCanonical('claude', URL, false);
    expect(installedConnection('claude', installed)).toBe(sent);
    // Another server edited: still the same entry.
    const other = installed.replace('"gh"', '"gh2", "args": ["a b"]');
    expect(installedConnection('claude', other)).toBe(sent);
    // Reformatted onto one line: the same.
    expect(installedConnection('claude', JSON.stringify(JSON.parse(installed)))).toBe(sent);
    // The docket entry edited: different.
    expect(installedConnection('claude', installed.replace('7420', '7421'))).not.toBe(sent);
    // Gone, or a broken file.
    expect(installedConnection('claude', '{"mcpServers": {"github": {}}}')).toBeNull();
    expect(installedConnection('claude', '{"mcpServers": ')).toBe('invalid');
  });
});

describe('.codex/config.toml (Codex)', () => {
  it('creates the table', () => {
    expect(mergeConnection('codex', null, codex())).toEqual({
      text: '[mcp_servers.docket]\nurl = "http://127.0.0.1:7420/mcp"\n',
      how: 'created',
    });
    expect(mergeT(null, true)).toBe(
      '[mcp_servers.docket]\nurl = "http://127.0.0.1:7420/mcp"\nbearer_token_env_var = "DOCKET_TOKEN"\n',
    );
  });

  const OTHER = [
    'model = "gpt-5"',
    'approval_policy = "on-request"',
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
    '',
  ].join('\n');

  it('appends the table after the existing text, which stays an exact prefix', () => {
    const out = mergeConnection('codex', OTHER, codex());
    expect(out.how).toBe('added');
    expect(out.text).toBe(`${OTHER}\n${codex()}`);
    expect(mergeT('a = 1')).toBe(`a = 1\n\n${codex()}`);
  });

  it('replaces only the docket table, keeping what follows it', () => {
    const before = [
      '# my config',
      '[mcp_servers.docket]',
      'url = "http://old:1/mcp"',
      'bearer_token_env_var = "DOCKET_TOKEN"',
      '',
      '# the next one',
      '[mcp_servers."other"]',
      'url = "x"',
      '',
    ].join('\r\n');
    const out = mergeConnection('codex', before, codex());
    expect(out.how).toBe('replaced');
    expect(out.text).toBe(
      `# my config\r\n${codex()}\r\n# the next one\r\n[mcp_servers."other"]\r\nurl = "x"\r\n`,
    );
    expect(mergeT(out.text)).toBe(out.text);
  });

  it('finds the table written with quotes and spaces', () => {
    const before = '[ mcp_servers . "docket" ]  # mine\nurl = "x"\n';
    expect(mergeT(before)).toBe(codex());
  });

  it.each([
    ['a stray line', 'model = "x"\njust words\n', 'bad line 2'],
    ['an unclosed string', 'a = "x\n', 'unclosed string'],
    ['an unclosed array', 'a = [1,\n2\n', 'unclosed bracket'],
    ['an unclosed multi-line string', 'a = """\nx\n', 'unclosed string'],
    ['a bad header', '[mcp_servers.x\n', 'bad table header on line 1'],
    [
      'the table twice',
      '[mcp_servers.docket]\na = 1\n[mcp_servers.docket]\n',
      'docket table twice',
    ],
  ])('refuses %s, and says why', (_label, before, detail) => {
    expect(scanToml(before)).toEqual({ ok: false, error: detail });
    expect(() => mergeT(before)).toThrow(`.codex/config.toml isn't valid TOML (${detail})`);
  });

  it.each([
    ['a dotted key', 'mcp_servers.docket.url = "x"\n'],
    ['an inline table', '[mcp_servers]\ndocket = { url = "x" }\n'],
    ['a dotted key in a table', '[mcp_servers]\ndocket.url = "x"\n'],
  ])('refuses docket defined as %s, which it can’t update', (_label, before) => {
    expect(() => mergeT(before)).toThrow(
      /defines the docket MCP server in a form Docket can't update/,
    );
  });

  it('keeps a docket subtable, and other servers’ subtables', () => {
    const before = '[mcp_servers.docket]\nurl = "x"\n[mcp_servers.docket.env]\nA = "1"\n';
    expect(mergeT(before)).toBe(`${codex()}[mcp_servers.docket.env]\nA = "1"\n`);
  });

  it('the check compares only the docket table', () => {
    const installed = mergeT(OTHER);
    const sent = connectionCanonical('codex', URL, false);
    expect(sent).toBe('[mcp_servers.docket]\nurl = "http://127.0.0.1:7420/mcp"');
    expect(installedConnection('codex', installed)).toBe(sent);
    expect(installedConnection('codex', installed.replace('gh-mcp', 'gh-mcp2'))).toBe(sent);
    expect(
      installedConnection('codex', installed.replace('url = "http', '  url  = "http')),
    ).not.toBe(sent);
    expect(installedConnection('codex', installed.replace(':7420', ':7421'))).not.toBe(sent);
    expect(installedConnection('codex', `${installed}# a comment\n\n`)).toBe(sent);
    expect(installedConnection('codex', OTHER)).toBeNull();
    expect(installedConnection('codex', 'a = "')).toBe('invalid');
  });
});
