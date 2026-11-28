/**
 * The only way the collector reaches GitHub: the `gh` CLI already signed in on
 * this machine, read-only.
 *
 * - No shell. `gh` is resolved to a full path from absolute PATH entries, so a
 *   file in the working directory can never stand in for it.
 * - Two commands exist: `gh auth status` and `gh api graphql` with a `query`.
 *   Anything else, including a GraphQL mutation, is refused here.
 * - The child gets a short allowlisted environment. Tokens in the environment
 *   are dropped, so only the machine's `gh` login is ever used.
 * - Output from `auth status` is discarded unread, and stderr is only matched
 *   for a failure kind. Neither is ever logged or stored.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

const PASSED_ENV = [
  'PATH',
  'Path',
  'HOME',
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
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'GH_CONFIG_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

export class GhError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** What `gh` runs with. Never `GH_TOKEN`, `GITHUB_TOKEN` or `NODE_OPTIONS`. */
export function childEnv(env = process.env) {
  const out = {};
  for (const key of PASSED_ENV) if (env[key] !== undefined) out[key] = env[key];
  out.GH_PROMPT_DISABLED = '1';
  out.GH_NO_UPDATE_NOTIFIER = '1';
  out.NO_COLOR = '1';
  return out;
}

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The full path of `gh` from absolute PATH entries, or null. */
export function findGh(env = process.env, platform = process.platform) {
  const path = env.PATH ?? env.Path ?? '';
  const name = platform === 'win32' ? 'gh.exe' : 'gh';
  for (const dir of path.split(delimiter)) {
    const clean = dir.trim().replace(/^"|"$/g, '');
    if (!clean || !isAbsolute(clean)) continue;
    const candidate = join(clean, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Which failure this was, from the exit and stderr. The text itself goes no further. */
export function classifyFailure(stderr) {
  const text = String(stderr).toLowerCase();
  if (/rate limit|abuse detection|http 429|secondary rate/.test(text)) return 'rate_limited';
  if (/gh auth login|not logged in|authentication required|http 401|bad credentials/.test(text)) {
    return 'gh_signed_out';
  }
  if (
    /could not resolve|connection refused|connection reset|timeout|timed out|no such host|network|tls|eof|http 50[0-9]/.test(
      text,
    )
  ) {
    return 'network';
  }
  return 'gh_error';
}

/** Refuses anything that isn't a read. */
export function assertReadOnly(args) {
  const [first, second] = args;
  if (first === 'auth' && second === 'status') return;
  if (
    first === 'api' &&
    args.length === 2 &&
    /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\?(?:event=pull_request&branch=[A-Za-z0-9._%/-]+|event=push&head_sha=[0-9a-f]{40})&per_page=100$/i.test(
      second,
    )
  )
    return;
  if (first === 'api' && second === 'graphql') {
    const query = args.find((arg) => arg.startsWith('query='));
    if (query && /^query=\s*query\b/.test(query) && !/\bmutation\b/i.test(query)) return;
  }
  throw new GhError('not_read_only');
}

function run(exe, args, { env, signal, timeoutMs = TIMEOUT_MS, keepOutput = true }) {
  assertReadOnly(args);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GhError('aborted'));
      return;
    }
    const child = spawn(exe, args, {
      env: childEnv(env),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', keepOutput ? 'pipe' : 'ignore', 'pipe'],
    });
    const out = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      child.kill();
      finish(reject, new GhError('aborted'));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new GhError('network'));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        child.kill();
        finish(reject, new GhError('gh_error'));
        return;
      }
      out.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });
    child.once('error', (err) =>
      finish(reject, new GhError(err.code === 'ENOENT' ? 'gh_missing' : 'gh_error')),
    );
    child.once('close', (code) => {
      if (code === 0) finish(resolve, Buffer.concat(out).toString('utf8'));
      else finish(reject, new GhError(classifyFailure(stderr)));
    });
  });
}

/** `{ authStatus, graphql, workflowRuns }`, for one `gh` on this machine. */
export function createGh({ env = process.env, platform = process.platform } = {}) {
  const exe = () => {
    const found = findGh(env, platform);
    if (!found) throw new GhError('gh_missing');
    return found;
  };
  return {
    /** Resolves when signed in. Its output is discarded unread. */
    async authStatus(signal) {
      try {
        await run(exe(), ['auth', 'status', '--hostname', 'github.com'], {
          env,
          signal,
          keepOutput: false,
        });
      } catch (err) {
        // `auth status` exits 1 for "not signed in" and prints nothing we keep.
        if (err.code === 'gh_error') throw new GhError('gh_signed_out');
        throw err;
      }
    },

    async graphql(query, variables, signal) {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      for (const [key, value] of Object.entries(variables)) {
        // `-f` is a raw string: `-F` would read a value starting with @ as a file.
        if (value !== null && value !== undefined) args.push('-f', `${key}=${value}`);
      }
      const text = await run(exe(), args, { env, signal });
      try {
        return JSON.parse(text);
      } catch {
        throw new GhError('gh_error');
      }
    },

    /** One bounded page of GitHub Actions runs. Only the two fixed read queries pass the guard. */
    async workflowRuns(repo, filter, signal) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new GhError('not_read_only');
      let query;
      if (filter.event === 'pull_request' && /^[A-Za-z0-9._/-]+$/.test(filter.branch ?? '')) {
        query = `event=pull_request&branch=${encodeURIComponent(filter.branch)}&per_page=100`;
      } else if (filter.event === 'push' && /^[0-9a-f]{40}$/i.test(filter.head_sha ?? '')) {
        query = `event=push&head_sha=${filter.head_sha}&per_page=100`;
      } else {
        throw new GhError('not_read_only');
      }
      const output = await run(exe(), ['api', `repos/${repo}/actions/runs?${query}`], {
        env,
        signal,
      });
      try {
        return JSON.parse(output);
      } catch {
        throw new GhError('gh_error');
      }
    },
  };
}
