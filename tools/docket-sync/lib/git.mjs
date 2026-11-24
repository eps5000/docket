/**
 * Read-only git on the host, for the worktrees source (owner decision 48; B68)
 * and the git source (B76).
 *
 * - No shell. `git` is resolved to a full path from absolute PATH entries and
 *   runs from its own folder with `-C <worktree>`. On Windows a program started
 *   by bare name is looked up in the working directory first, so a worktree
 *   holding its own `git.exe` must never be the working directory.
 * - The child gets a short allowlisted environment, so no `GIT_DIR`, trace or
 *   external-program setting from this process reaches it. A call may add only
 *   the two object-folder settings a trial merge needs (`objects`).
 * - Nothing is written: `GIT_OPTIONAL_LOCKS=0`, no gc, no filesystem monitor,
 *   no signature checks, no pager, and no lazy fetch from a partial clone.
 * - `safe.directory` is left alone. Git's refusal of a folder someone else owns
 *   is a protection on the host, and that folder simply reads as unknown.
 * - stderr is never read, and stdout is dropped once counted when `countNul` is
 *   set, so `git status` output (file names) is never kept.
 * - A call that times out, is cancelled or overflows is `unknown`.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 16 * 1024 * 1024;
const KILL_GRACE_MS = 1_000;

const PASSED_ENV = [
  'PATH',
  'Path',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_CONFIG_HOME',
];

const CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'gc.auto=0',
  '-c',
  'log.showSignature=false',
  '-c',
  'status.submoduleSummary=false',
];

export class GitError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** What `git` runs with. Never a `GIT_*` setting from this process. */
export function gitEnv(env = process.env) {
  const out = {};
  for (const key of PASSED_ENV) if (env[key] !== undefined) out[key] = env[key];
  out.GIT_OPTIONAL_LOCKS = '0';
  out.GIT_TERMINAL_PROMPT = '0';
  out.GIT_NO_LAZY_FETCH = '1';
  out.LC_ALL = 'C';
  return out;
}

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The full path of `git` from absolute PATH entries, or null. */
export function findGit(env = process.env, platform = process.platform) {
  const path = env.PATH ?? env.Path ?? '';
  const name = platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of path.split(delimiter)) {
    const clean = dir.trim().replace(/^"|"$/g, '');
    if (!clean || !isAbsolute(clean)) continue;
    const candidate = join(clean, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

const UNKNOWN = Object.freeze({ status: null, stdout: '', count: 0, unknown: true });

/**
 * The only settings a call may add (B76): a trial merge writes its trees into
 * a throwaway object folder and reads the repository's objects through it.
 */
const OBJECT_ENV = ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

function withObjects(env, objects) {
  if (!objects) return env;
  const out = { ...env };
  for (const key of OBJECT_ENV) if (typeof objects[key] === 'string') out[key] = objects[key];
  return out;
}

function run(
  exe,
  baseEnv,
  dir,
  args,
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS, countNul = 0, objects } = {},
) {
  const env = withObjects(baseEnv, objects);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(UNKNOWN);
      return;
    }
    let child;
    try {
      child = spawn(exe, [...CONFIG, '-C', dir, ...args], {
        cwd: dirname(exe),
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(UNKNOWN);
      return;
    }
    const chunks = [];
    let size = 0;
    let count = 0;
    let enough = false;
    let stopped = false;
    let settled = false;
    let killTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      resolve(result);
    };
    const halt = () => {
      child.kill();
      killTimer = setTimeout(() => {
        child.stdout?.destroy();
        finish(enough ? { status: 0, stdout: '', count, unknown: false } : UNKNOWN);
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    function stop() {
      if (stopped || settled) return;
      stopped = true;
      halt();
    }
    const timer = setTimeout(stop, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk) => {
      if (countNul > 0) {
        // Counted and dropped: this output is file names.
        for (const byte of chunk) if (byte === 0) count += 1;
        if (count >= countNul && !enough && !stopped) {
          count = countNul;
          enough = true;
          halt();
        }
        return;
      }
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        chunks.length = 0;
        stop();
      } else if (!stopped) {
        chunks.push(chunk);
      }
    });
    child.once('error', () => finish(UNKNOWN));
    child.once('close', (code) => {
      if (enough) finish({ status: 0, stdout: '', count, unknown: false });
      else if (stopped || code === null) finish(UNKNOWN);
      else {
        finish({
          status: code,
          stdout: countNul > 0 ? '' : Buffer.concat(chunks).toString('utf8'),
          count,
          unknown: false,
        });
      }
    });
  });
}

/** `{ read(dir, args, options) }` for the one `git` on this machine. */
export function createGit({ env = process.env, platform = process.platform } = {}) {
  const exe = findGit(env, platform);
  if (!exe) throw new GitError('git_missing');
  const childEnv = gitEnv(env);
  return { read: (dir, args, options) => run(exe, childEnv, dir, args, options) };
}
