import { describe, expect, it } from 'vitest';
import {
  BrokenMarkersError,
  DOCKET_BEGIN as B,
  DOCKET_END as E,
  bashQuote,
  checkCommands,
  fillsProjectKey,
  findMarkedSection,
  installCommands,
  installLayout,
  installPathOf,
  installedBlock,
  mergeMarkedSection,
  placeholdersIn,
  psQuote,
  renderAgentsBlock,
  withoutCr,
} from '../src/install.js';

describe('installLayout (BUILD_SPEC §5.17, V7)', () => {
  it.each([
    ['claude', 'repo', '.claude/skills/docket-worker/SKILL.md', 'CLAUDE.md', ''],
    ['claude', 'user', '.claude/skills/docket-worker/SKILL.md', '.claude/CLAUDE.md', '~/'],
    ['codex', 'repo', '.codex/skills/docket-worker/SKILL.md', 'AGENTS.md', ''],
    ['codex', 'user', '.codex/skills/docket-worker/SKILL.md', '.codex/AGENTS.md', '~/'],
  ] as const)('%s %s', (client, target, skill, instructions, display) => {
    const layout = installLayout(client, target);
    expect(installPathOf(layout, 'skill:docket-worker')).toBe(skill);
    expect(installPathOf(layout, 'agents_block')).toBe(instructions);
    expect(layout.manifest).toBe(`${layout.dir}/.docket-manifest.json`);
    expect(layout.display).toBe(display);
  });
});

describe('the AGENTS.md block as installed', () => {
  const template = [
    '<!--',
    'Template: paste the block below into a project’s AGENTS.md.',
    'Then replace every {{…}} placeholder.',
    '-->',
    '',
    '## Work tracking: Docket',
    '',
    'Project key **{{KEY}}**; search with project `{{KEY}}`.',
    '- {{OPTION A: Only the owner moves items to Ready.}}',
    '',
  ].join('\n');

  it('strips the leading comment and fills {{KEY}} for a project', () => {
    const out = renderAgentsBlock(template, 'RCP');
    expect(out.startsWith('## Work tracking: Docket')).toBe(true);
    expect(out).toContain('Project key **RCP**; search with project `RCP`.');
    expect(out).not.toContain('<!--');
    expect(out.endsWith('Ready.}}')).toBe(true);
    expect(placeholdersIn(out)).toEqual(['{{OPTION A: Only the owner moves items to Ready.}}']);
  });

  it('leaves {{KEY}} without a project (user-wide), and lists each placeholder once', () => {
    const out = renderAgentsBlock(template, null);
    expect(placeholdersIn(out)).toEqual([
      '{{KEY}}',
      '{{OPTION A: Only the owner moves items to Ready.}}',
    ]);
  });

  it('fills the key only for a repo install of a project', () => {
    expect(fillsProjectKey('repo', 'RCP')).toBe('RCP');
    expect(fillsProjectKey('repo', null)).toBeNull();
    expect(fillsProjectKey('user', 'RCP')).toBeNull();
  });

  it('keeps a comment that is not at the start', () => {
    expect(renderAgentsBlock('# Hi\n<!-- note -->\n', null)).toBe('# Hi\n<!-- note -->');
  });
});

describe('the marked section: insert, replace, append; nothing else changes', () => {
  const block = '## Work tracking\nUse Docket.';
  const section = `${B}\n${block}\n${E}`;

  it('creates the file when there is none', () => {
    expect(mergeMarkedSection(null, block)).toEqual({ text: `${section}\n`, how: 'created' });
  });

  it('appends after a blank line when there are no markers: the old text is an exact prefix', () => {
    const old = '# My project\r\n\r\nOur rules.\r\n';
    const { text, how } = mergeMarkedSection(old, block);
    expect(how).toBe('appended');
    expect(text.startsWith(old)).toBe(true);
    expect(text).toBe(`${old}\n${section}\n`);
  });

  it('adds the missing newline first when the file does not end with one', () => {
    const old = '# My project\nNo final newline';
    const { text } = mergeMarkedSection(old, block);
    expect(text).toBe(`${old}\n\n${section}\n`);
  });

  it('replaces between the markers and keeps every byte outside them', () => {
    const before = '# Mine\n\nKeep this — exactly, with ünïcode and CRLF\r\n\n';
    const after = '\n\n## After\nTrailing text without a newline';
    const old = `${before}${B}\nold block\nmore old\n${E}${after}`;
    const { text, how } = mergeMarkedSection(old, block);
    expect(how).toBe('replaced');
    expect(text).toBe(`${before}${section}${after}`);
    // Replacing again is a no-op.
    expect(mergeMarkedSection(text, block).text).toBe(text);
  });

  it('replaces markers that are inline, not on their own lines', () => {
    const old = `a ${B}x${E} b`;
    expect(mergeMarkedSection(old, block).text).toBe(`a ${section} b`);
  });

  it.each([
    ['an end marker without a begin', `text\n${E}\n`],
    ['a begin marker without an end', `${B}\ntext\n`],
    ['the end before the begin', `${E}\n${B}\n`],
    ['two begin markers', `${B}\n${B}\nx\n${E}\n`],
    ['two sections', `${B}\na\n${E}\n${B}\nb\n${E}\n`],
  ])('refuses %s and changes nothing', (_name, old) => {
    expect(findMarkedSection(old).kind).toBe('broken');
    expect(() => mergeMarkedSection(old, block, 'CLAUDE.md')).toThrow(BrokenMarkersError);
    expect(() => mergeMarkedSection(old, block, 'CLAUDE.md')).toThrow(/CLAUDE\.md has a damaged/);
  });

  it('reads the installed block back as the check hashes it', () => {
    const { text } = mergeMarkedSection('# Mine\n', block);
    expect(installedBlock(text)).toBe(block);
    expect(installedBlock(text.replace(/\n/g, '\r\n'))).toBe(block);
    expect(installedBlock('# Mine\n')).toBeNull();
    expect(installedBlock(`${E}`)).toBe('broken');
    expect(withoutCr('a\r\nb\r')).toBe('a\nb');
  });
});

describe('the copy-paste commands', () => {
  const url = 'http://127.0.0.1:7420/install/A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0-_x';

  it('quotes paths for each shell', () => {
    expect(bashQuote("it's")).toBe(`'it'\\''s'`);
    expect(psQuote("it's")).toBe(`'it''s'`);
    expect(psQuote('it’s')).toBe(`'it’’s'`);
  });

  it('a repo install runs in the current folder and refuses one without .git', () => {
    const c = installCommands({ client: 'claude', target_kind: 'repo', url });
    expect(c.bash).toContain('d="$PWD"');
    expect(c.bash).toContain('[ -e "$d/.git" ]');
    expect(c.bash).toContain(`'${url}'`);
    expect(c.bash.startsWith('( ') && c.bash.endsWith(' )')).toBe(true);
    expect(c.powershell).toContain('$d = $PWD.ProviderPath');
    expect(c.powershell).toContain("Join-Path $d '.git'");
    expect(c.powershell).toContain(`'${url}'`);
    for (const s of [c.bash, c.powershell]) expect(s).not.toContain('\n');
  });

  it('a user-wide install goes to the home folder, with no .git check', () => {
    const c = installCommands({ client: 'codex', target_kind: 'user', url });
    expect(c.bash).toContain('d="$HOME"');
    expect(c.bash).not.toContain('.git');
    expect(c.powershell).toContain('$d = $HOME');
  });

  it('a given path is quoted, never interpolated', () => {
    const path = `C:/code/it's $(rm -rf ~) \`x\``;
    const c = installCommands({ client: 'claude', target_kind: 'repo', path, url });
    expect(c.bash).toContain(`d=${bashQuote(path)}`);
    expect(c.powershell).toContain(`Resolve-Path -LiteralPath ${psQuote(path)}`);
  });

  it('the check commands read the client folder’s manifest and need no token', () => {
    const c = checkCommands({ client: 'claude', target_kind: 'repo' });
    expect(c.bash).toContain('m="$d/.claude/.docket-manifest.json"');
    expect(c.powershell).toContain("Join-Path $d '.claude/.docket-manifest.json'");
    expect(c.bash).not.toContain('/install/');
    const u = checkCommands({ client: 'codex', target_kind: 'user' });
    expect(u.bash).toContain('"~/.codex/skills/$y/"');
  });
});
