/**
 * The push-root guard (owner decision 29; BUILD_SPEC §5.17; FR-117, FR-125).
 *
 * The push install is the one place Docket touches host files, and only
 * inside the folder the owner mounted (`DOCKET_PUSH_ROOT`). Every path goes
 * through here, and each escape is blocked as follows:
 *
 * - **`..`**: a path the owner gives may not contain a `..` segment at all,
 *   and the joined path must still be inside the root lexically.
 * - **Absolute paths:** accepted only under the push folder's host path
 *   (`DOCKET_PUSH_HOST_PATH`) or its container path, which are mapped onto
 *   the root; any other absolute path (or `~`) is refused.
 * - **Symlinks:** the root is resolved with `realpath` once. The base folder
 *   and every folder on the way to a file are checked one at a time with
 *   `lstat`; a symlinked folder is followed only if its real path is inside
 *   the root. A symlinked *file* is never written or read through, and files
 *   are opened with `O_NOFOLLOW` (where the OS has it), so a link swapped in
 *   after the check still isn't followed.
 * - **Never delete, with one exception:** folders are created one level at
 *   a time, files are written in place. The callers write only the
 *   `docket-*` skill files, the manifest and the instructions file (whose
 *   text outside the Docket markers is kept byte for byte). The one removal
 *   (B28) is `removeRecordedSkillFolder`: an old `tasklite-*` skill folder
 *   an earlier install recorded, only while it holds nothing but its
 *   unmodified `SKILL.md`.
 *
 * Errors are `validation` ToolErrors with a plain message; none of them
 * quote anything from outside the root.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ToolError, hasControlChars } from '@docket/shared';

const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** True when `p` is `root` or inside it (both already absolute and normalized). */
export function isInside(root: string, p: string): boolean {
  const r = relative(root, p);
  if (r === '') return true;
  return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}

const refuse = (message: string) => new ToolError('validation', message);

const looksAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('~');

/** Windows-style host paths compare without case. */
const caseless = (p: string) => /^[A-Za-z]:/.test(p) || p.startsWith('//');

function stripPrefix(p: string, prefix: string): string | null {
  const pre = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
  const fold = caseless(pre);
  const a = fold ? p.toLowerCase() : p;
  const b = fold ? pre.toLowerCase() : pre;
  if (a === b) return '';
  if (b === '' ? a.startsWith('/') : a.startsWith(`${b}/`)) return p.slice(pre.length + 1);
  return null;
}

/**
 * The folder the owner named, as segments under the root. It may be a host
 * path under `DOCKET_PUSH_HOST_PATH`, a container path under the root, or
 * relative to the root.
 */
export function rootSegments(
  input: string,
  containerRoot: string,
  hostPath: string | null,
): string[] {
  const p = input.trim().replace(/\\/g, '/');
  if (p === '' || hasControlChars(p)) {
    throw refuse('Give the folder to install into, inside the push folder.');
  }
  let rest = hostPath ? stripPrefix(p, hostPath) : null;
  rest ??= stripPrefix(p, containerRoot);
  const shown = hostPath ?? containerRoot;
  if (rest === null) {
    if (looksAbsolute(p)) {
      throw refuse(`That folder is outside the push folder (${shown}). Choose a folder inside it.`);
    }
    rest = p;
  }
  const segs = rest.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) {
    throw refuse(`A folder path can't contain "..". Give the folder inside ${shown} directly.`);
  }
  return segs;
}

export class SymlinkRefused extends ToolError {
  constructor(path: string) {
    super('validation', `${path} is a symbolic link; Docket never writes or reads through one.`);
  }
}

/** The opened push root: its real path, and guarded file access under it. */
export class PushRoot {
  private constructor(
    /** The root's real path (symlinks resolved). */
    readonly real: string,
    readonly containerPath: string,
    readonly hostPath: string | null,
  ) {}

  /** Resolve the root; throws `validation` when it is missing or not a folder. */
  static async open(containerPath: string, hostPath: string | null): Promise<PushRoot> {
    let real: string;
    try {
      real = await realpath(containerPath);
      if (!(await stat(real)).isDirectory()) throw new Error('not a folder');
    } catch {
      throw refuse(
        `The push folder ${containerPath} isn't mounted or isn't a folder. Check the volume in docker/compose.yaml.`,
      );
    }
    return new PushRoot(real, containerPath, hostPath);
  }

  /** The base folder for an install: it must exist, and its real path must be inside the root. */
  async base(input: string): Promise<string> {
    const segs = rootSegments(input, this.containerPath, this.hostPath);
    const joined = join(this.real, ...segs);
    if (!isInside(this.real, joined)) {
      throw refuse(`That folder is outside the push folder. Choose a folder inside it.`);
    }
    let real: string;
    try {
      real = await realpath(joined);
    } catch {
      throw refuse(`There's no folder at ${input} in the push folder. Check the path.`);
    }
    if (!isInside(this.real, real)) {
      throw refuse(`${input} links outside the push folder; Docket won't follow it.`);
    }
    if (!(await stat(real)).isDirectory()) throw refuse(`${input} isn't a folder.`);
    return real;
  }

  /**
   * Walk `relDir` (`/`-separated, under `base`) one folder at a time. A
   * symlinked folder is followed only when its real path is inside the root.
   * Missing folders are created when `create`, else the result is null.
   */
  private async folder(base: string, relDir: string, create: boolean): Promise<string | null> {
    let cur = base;
    for (const seg of relDir.split('/').filter(Boolean)) {
      if (seg === '..' || seg === '.') throw refuse('Unexpected path segment.');
      const next = join(cur, seg);
      let info;
      try {
        info = await lstat(next);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (!create) return null;
        await mkdir(next);
        cur = next;
        continue;
      }
      if (info.isSymbolicLink()) {
        const real = await realpath(next).catch(() => null);
        if (!real || !isInside(this.real, real)) {
          throw refuse(`${relDir} links outside the push folder; Docket won't follow it.`);
        }
        if (!(await stat(real)).isDirectory()) throw refuse(`${relDir} isn't a folder.`);
        cur = real;
      } else if (info.isDirectory()) {
        cur = next;
      } else {
        throw refuse(`${relDir} isn't a folder.`);
      }
    }
    if (!isInside(this.real, cur)) throw refuse('That path is outside the push folder.');
    return cur;
  }

  private static split(rel: string): { dir: string; name: string } {
    const i = rel.lastIndexOf('/');
    return i < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, i), name: rel.slice(i + 1) };
  }

  /** A file's bytes, or null when it (or its folder) doesn't exist. Never through a symlink. */
  async read(base: string, rel: string): Promise<Buffer | null> {
    const { dir, name } = PushRoot.split(rel);
    const folder = await this.folder(base, dir, false);
    if (folder === null) return null;
    const path = join(folder, name);
    let info;
    try {
      info = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (info.isSymbolicLink()) throw new SymlinkRefused(rel);
    if (!info.isFile()) throw refuse(`${rel} isn't a file.`);
    const fh = await open(path, constants.O_RDONLY | NOFOLLOW);
    try {
      return await fh.readFile();
    } finally {
      await fh.close();
    }
  }

  /** Check that `rel` can be written (folders inside the root, the file not a symlink). */
  async checkWritable(base: string, rel: string): Promise<void> {
    const { dir, name } = PushRoot.split(rel);
    const folder = await this.folder(base, dir, false);
    if (folder === null) return;
    const info = await lstat(join(folder, name)).catch(() => null);
    if (info?.isSymbolicLink()) throw new SymlinkRefused(rel);
    if (info && !info.isFile()) throw refuse(`${rel} isn't a file.`);
  }

  /** Write a file in place, creating its folders. Never through a symlink. */
  async write(base: string, rel: string, bytes: Uint8Array): Promise<void> {
    const { dir, name } = PushRoot.split(rel);
    const folder = (await this.folder(base, dir, true))!;
    const path = join(folder, name);
    const info = await lstat(path).catch(() => null);
    if (info?.isSymbolicLink()) throw new SymlinkRefused(rel);
    if (info && !info.isFile()) throw refuse(`${rel} isn't a file.`);
    const fh = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW,
      0o644,
    );
    try {
      await fh.writeFile(bytes);
    } finally {
      await fh.close();
    }
  }

  /**
   * Remove an old skill folder an earlier install wrote and recorded (B28;
   * BUILD_SPEC §5.17): `relDir` must be a real folder (not a link) holding
   * exactly one regular file, `SKILL.md`, for which `unmodified` returns
   * true. Anything else is left alone and the result is false.
   */
  async removeRecordedSkillFolder(
    base: string,
    relDir: string,
    unmodified: (bytes: Buffer) => boolean,
  ): Promise<boolean> {
    const { dir, name } = PushRoot.split(relDir);
    const parent = await this.folder(base, dir, false);
    if (parent === null) return false;
    const path = join(parent, name);
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return false;
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length !== 1 || entries[0]!.name !== 'SKILL.md' || !entries[0]!.isFile()) {
      return false;
    }
    const file = join(path, 'SKILL.md');
    const fh = await open(file, constants.O_RDONLY | NOFOLLOW);
    let bytes: Buffer;
    try {
      bytes = await fh.readFile();
    } finally {
      await fh.close();
    }
    if (!unmodified(bytes)) return false;
    await unlink(file);
    await rmdir(path);
    return true;
  }

  /** The names of the folders (or links to folders) in `relDir`; empty when it doesn't exist. */
  async folders(base: string, relDir: string): Promise<string[]> {
    const folder = await this.folder(base, relDir, false);
    if (folder === null) return [];
    const entries = await readdir(folder, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  }
}
