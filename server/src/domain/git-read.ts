/**
 * Read-only git for the server (B52): an async child process per call, so a
 * slow repository never blocks the event loop.
 *
 * - **Bounded.** At most `gitLimits.concurrency` git processes run at once
 *   across the whole server; the rest wait their turn.
 * - **Timed.** Each call has `gitLimits.timeoutMs` once it starts. A call that
 *   times out, is cancelled, overflows its buffer or dies from a signal is
 *   `unknown`: it says nothing about the repository, so callers must never
 *   clear a finding or change state because of it.
 * - **Cancellable.** An aborted signal stops a running git (SIGTERM, then
 *   SIGKILL) and drops a queued one without starting it.
 */
import { spawn } from 'node:child_process';

export const gitLimits = {
  /** Per call, from when its process starts. */
  timeoutMs: 60_000,
  /** Git processes at once, for the whole server. */
  concurrency: 4,
  /** How long a stopped git gets before SIGKILL. */
  killGraceMs: 1_000,
  maxBuffer: 16 * 1024 * 1024,
};

export interface GitResult {
  status: number | null;
  stdout: string;
  /** The git binary (or the folder) isn't there. */
  missing: boolean;
  /** Timed out, cancelled, too much output or killed: the answer isn't known. */
  unknown: boolean;
}

/** Thrown by `known` for a read that has no answer; see the header. */
export class GitUnknown extends Error {
  constructor() {
    super('A git read timed out or was cancelled.');
    this.name = 'GitUnknown';
  }
}

/** The result, or `GitUnknown` when the read has no answer. */
export function known(r: GitResult): GitResult {
  if (r.unknown) throw new GitUnknown();
  return r;
}

const UNKNOWN: GitResult = { status: null, stdout: '', missing: false, unknown: true };

let running = 0;
const waiting: (() => void)[] = [];

/** Wait for a process slot; false when `signal` aborted first (no slot is held). */
function acquire(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (running < gitLimits.concurrency) {
    running += 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const turn = () => {
      signal?.removeEventListener('abort', leave);
      running += 1;
      resolve(true);
    };
    const leave = () => {
      waiting.splice(waiting.indexOf(turn), 1);
      resolve(false);
    };
    waiting.push(turn);
    signal?.addEventListener('abort', leave, { once: true });
  });
}

function release(): void {
  running -= 1;
  if (running < gitLimits.concurrency) waiting.shift()?.();
}

function runGit(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<GitResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'git',
        ['-c', 'safe.directory=*', '-c', 'gc.auto=0', '-c', 'core.fsmonitor=false', ...args],
        {
          cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
            LC_ALL: 'C',
            ...env,
          },
        },
      );
    } catch {
      resolve(UNKNOWN);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let giveUpTimer: NodeJS.Timeout | undefined;

    const settle = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      signal?.removeEventListener('abort', stop);
      resolve(result);
    };
    // SIGTERM lets git clean up its temporary files; SIGKILL if it doesn't exit.
    // A process that survives even that must not hold a slot forever.
    const stop = () => {
      if (stopped || settled) return;
      stopped = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        giveUpTimer = setTimeout(() => {
          child.stdout?.destroy();
          settle(UNKNOWN);
        }, gitLimits.killGraceMs);
        giveUpTimer.unref();
      }, gitLimits.killGraceMs);
      killTimer.unref();
    };
    const timeout = setTimeout(stop, gitLimits.timeoutMs);
    timeout.unref();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();

    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > gitLimits.maxBuffer) {
        chunks.length = 0;
        stop();
      } else if (!stopped) {
        chunks.push(chunk);
      }
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(err.code === 'ENOENT' ? { ...UNKNOWN, missing: true, unknown: false } : UNKNOWN);
    });
    child.on('close', (code) => {
      if (stopped || code === null) {
        settle(UNKNOWN);
        return;
      }
      settle({
        status: code,
        stdout: Buffer.concat(chunks).toString('utf8'),
        missing: false,
        unknown: false,
      });
    });
  });
}

/** Run git read-only in `cwd`, with extra environment. Never rejects. */
export async function git(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<GitResult> {
  if (!(await acquire(signal))) return UNKNOWN;
  try {
    return await runGit(cwd, args, env, signal);
  } finally {
    release();
  }
}
