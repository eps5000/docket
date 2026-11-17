/**
 * The push-root guard (T156; FR-117, FR-125): every way out of the push
 * folder is refused, and nothing outside it is read, written or deleted.
 * Each case is printed with its result (PR evidence).
 *
 * Symlinks: folders use junctions on Windows (no admin needed); a file
 * symlink needs a privilege Windows may not grant, so those cases skip there
 * when the link can't be made. CI (Linux) runs them all.
 */
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PushRoot, isInside, rootSegments } from '../../src/domain/push-root.js';
import { tempDir, type TempDir } from '../helpers.js';

const results: string[] = [];
afterAll(() => {
  if (results.length > 0) console.log(`Push-root escape cases:\n${results.join('\n')}`);
});

let tmp: TempDir;
let rootDir: string;
let outside: string;
beforeEach(() => {
  tmp = tempDir('tasklite-push-');
  rootDir = join(tmp.dir, 'code');
  outside = join(tmp.dir, 'outside');
  mkdirSync(join(rootDir, 'recipes'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside');
});
afterEach(() => tmp.cleanup());

/** Make a folder link; junctions on Windows. */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}
/** Make a file link, or return false where the OS won't let us. */
function linkFile(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch {
    return false;
  }
}

async function refused(name: string, run: () => Promise<unknown>, match: RegExp) {
  await expect(run()).rejects.toMatchObject({
    code: 'validation',
    message: expect.stringMatching(match),
  });
  results.push(`- ${name}: refused`);
}

describe('rootSegments: the folder the owner names, mapped onto the root', () => {
  it('maps a host path under TASKLITE_PUSH_HOST_PATH (any case and slashes on Windows)', () => {
    expect(rootSegments('C:\\Users\\Me\\Code\\recipes', '/host-code', 'C:/Users/me/code')).toEqual([
      'recipes',
    ]);
    expect(rootSegments('C:/Users/me/code', '/host-code', 'C:/Users/me/code/')).toEqual([]);
  });

  it('maps a container path under the root, and a relative one', () => {
    expect(rootSegments('/host-code/recipes/app', '/host-code', null)).toEqual(['recipes', 'app']);
    expect(rootSegments('recipes/./app/', '/host-code', null)).toEqual(['recipes', 'app']);
  });

  it.each([
    ['an absolute path elsewhere', '/etc', /outside the push folder/],
    ['a sibling with the root as a name prefix', '/host-code-evil/x', /outside the push folder/],
    ['another drive', 'D:/code/recipes', /outside the push folder/],
    ['a home path', '~/code', /outside the push folder/],
    ['".." in a relative path', 'recipes/../../etc', /can't contain "\.\."/],
    ['".." after the host path', 'C:/Users/me/code/../other', /can't contain "\.\."/],
    ['".." after the container path', '/host-code/../etc', /can't contain "\.\."/],
    ['a control character', 'recipes\napp', /Give the folder/],
  ])('refuses %s', (name, input, match) => {
    expect(() => rootSegments(input, '/host-code', 'C:/Users/me/code')).toThrow(match);
    results.push(`- ${name} (${JSON.stringify(input)}): refused`);
  });

  it('isInside is not fooled by a shared prefix', () => {
    expect(isInside(join('/a', 'code'), join('/a', 'code', 'x'))).toBe(true);
    expect(isInside(join('/a', 'code'), join('/a', 'code-evil'))).toBe(false);
    expect(isInside(join('/a', 'code'), join('/a'))).toBe(false);
  });
});

describe('PushRoot: base folders, reads and writes stay inside the root', () => {
  it('resolves a folder inside the root', async () => {
    const root = await PushRoot.open(rootDir, null);
    const base = await root.base('recipes');
    expect(isInside(root.real, base)).toBe(true);
    await root.write(base, '.claude/skills/tasklite-worker/SKILL.md', Buffer.from('hi'));
    expect(
      readFileSync(join(rootDir, 'recipes/.claude/skills/tasklite-worker/SKILL.md'), 'utf8'),
    ).toBe('hi');
    expect(await root.read(base, '.claude/skills/tasklite-worker/SKILL.md')).toEqual(
      Buffer.from('hi'),
    );
    expect(await root.read(base, '.claude/skills/tasklite-nope/SKILL.md')).toBeNull();
    expect(await root.folders(base, '.claude/skills')).toEqual(['tasklite-worker']);
  });

  it('refuses a missing root, and a root that is a file', async () => {
    await refused(
      'the root unset or missing',
      () => PushRoot.open(join(tmp.dir, 'nope'), null),
      /isn't mounted/,
    );
    writeFileSync(join(tmp.dir, 'file'), 'x');
    await refused(
      'the root is a file',
      () => PushRoot.open(join(tmp.dir, 'file'), null),
      /isn't mounted/,
    );
  });

  it('refuses a folder that does not exist (it never creates the base)', async () => {
    const root = await PushRoot.open(rootDir, null);
    await refused('a base that does not exist', () => root.base('nope'), /no folder at nope/);
    expect(readdirSync(rootDir)).toEqual(['recipes']);
  });

  it('refuses an absolute path outside the root, and ".."', async () => {
    const root = await PushRoot.open(rootDir, null);
    await refused(
      'an absolute container path outside',
      () => root.base(outside),
      /outside the push folder/,
    );
    await refused('".." to a sibling', () => root.base('../outside'), /can't contain/);
  });

  it('refuses a base folder that is a symlink out of the root', async () => {
    linkDir(outside, join(rootDir, 'escape'));
    const root = await PushRoot.open(rootDir, null);
    await refused(
      'a base folder linked outside',
      () => root.base('escape'),
      /links outside the push folder/,
    );
  });

  it('follows a symlinked base folder that stays inside the root', async () => {
    linkDir(join(rootDir, 'recipes'), join(rootDir, 'alias'));
    const root = await PushRoot.open(rootDir, null);
    const base = await root.base('alias');
    expect(isInside(root.real, base)).toBe(true);
    results.push('- a base folder linked inside the root: allowed');
  });

  it('refuses a .claude folder (or skills folder) that links outside, for writes and reads', async () => {
    linkDir(outside, join(rootDir, 'recipes', '.claude'));
    const root = await PushRoot.open(rootDir, null);
    const base = await root.base('recipes');
    await refused(
      'writing through a .claude folder linked outside',
      () => root.write(base, '.claude/skills/tasklite-worker/SKILL.md', Buffer.from('x')),
      /links outside the push folder/,
    );
    await refused(
      'reading through a .claude folder linked outside',
      () => root.read(base, '.claude/skills/tasklite-worker/SKILL.md'),
      /links outside the push folder/,
    );
    await refused(
      'listing through a .claude folder linked outside',
      () => root.folders(base, '.claude/skills'),
      /links outside the push folder/,
    );
    // Nothing was written outside.
    expect(readdirSync(outside)).toEqual(['secret.txt']);
  });

  it('never writes or reads through a symlinked file, even one pointing inside', async (ctx) => {
    const target = join(outside, 'secret.txt');
    if (!linkFile(target, join(rootDir, 'recipes', 'CLAUDE.md'))) {
      results.push(
        '- writing through a CLAUDE.md symlinked outside: skipped (no symlink privilege)',
      );
      ctx.skip();
    }
    const root = await PushRoot.open(rootDir, null);
    const base = await root.base('recipes');
    await refused(
      'writing through a CLAUDE.md symlinked outside',
      () => root.write(base, 'CLAUDE.md', Buffer.from('x')),
      /symbolic link/,
    );
    await refused(
      'reading a CLAUDE.md symlinked outside',
      () => root.read(base, 'CLAUDE.md'),
      /symbolic link/,
    );
    await refused(
      'checking a CLAUDE.md symlinked outside before writing',
      () => root.checkWritable(base, 'CLAUDE.md'),
      /symbolic link/,
    );
    expect(readFileSync(target, 'utf8')).toBe('outside');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a read-only root: the write fails and nothing is created',
    async () => {
      const { chmodSync } = await import('node:fs');
      chmodSync(rootDir, 0o555);
      chmodSync(join(rootDir, 'recipes'), 0o555);
      try {
        const root = await PushRoot.open(rootDir, null);
        const base = await root.base('recipes');
        await expect(root.write(base, 'CLAUDE.md', Buffer.from('x'))).rejects.toMatchObject({
          code: 'EACCES',
        });
        expect(readdirSync(join(rootDir, 'recipes'))).toEqual([]);
        results.push('- a read-only root: the write fails (EACCES), nothing created');
      } finally {
        chmodSync(join(rootDir, 'recipes'), 0o755);
        chmodSync(rootDir, 0o755);
      }
    },
  );
});
