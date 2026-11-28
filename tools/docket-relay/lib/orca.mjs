/**
 * The Orca CLI, always run directly with an argument array and no shell.
 *
 * On Windows it must be `orca.exe`: the `orca.cmd` shim refuses
 * `orchestration send`, because cmd.exe can reparse a message body.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { isCoordinatorAddress } from './target.mjs';

const SENDER = 'docket-relay';
const TIMEOUT_MS = 20_000;
/** Worth another try: Orca is busy or restarting, or the outcome isn't known. */
const TRANSIENT = new Set([
  'runtime_unavailable',
  'operation_unknown',
  'request_aborted',
  'timeout',
  'spawn_failed',
  'unreadable',
]);

const isFile = (path, platform = process.platform) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The executable, or null. On Linux, `/usr/bin/orca` is the GNOME screen reader. */
export function findOrca(env = process.env, platform = process.platform) {
  if (env.DOCKET_RELAY_ORCA) {
    return isFile(env.DOCKET_RELAY_ORCA, platform) ? env.DOCKET_RELAY_ORCA : null;
  }
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const names = platform === 'win32' ? ['orca.exe'] : ['orca-ide', 'orca'];
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (platform === 'linux' && /^\/(usr\/)?bin\/orca$/.test(candidate)) continue;
      if (isFile(candidate, platform)) return candidate;
    }
  }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const installed = join(env.LOCALAPPDATA, 'Programs', 'orca', 'resources', 'bin', 'orca.exe');
    if (isFile(installed, platform)) return installed;
  }
  return null;
}

/** Without Orca's session variables, so the relay never speaks as the terminal that started it. */
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^ORCA_/i.test(key)));
}

/** A stable UUID, so a repeated send of the same batch is never delivered twice. */
export function requestIdFor(...parts) {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function parseOutput(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function createOrca({ exe, env = process.env, timeoutMs = TIMEOUT_MS }) {
  const safeEnv = childEnv(env);

  const run = (args) =>
    new Promise((resolve) => {
      if (!exe) {
        resolve({ ok: false, code: 'spawn_failed', transient: true });
        return;
      }
      execFile(
        exe,
        args,
        {
          shell: false,
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          env: safeEnv,
        },
        (error, stdout, stderr) => {
          const output = parseOutput(stdout) ?? parseOutput(stderr);
          if (!error && output?.ok === true) {
            resolve({ ok: true, result: output.result ?? {} });
            return;
          }
          let code = output?.error?.code;
          if (typeof code !== 'string') {
            if (error?.killed) code = 'timeout';
            else if (typeof error?.code === 'string') code = 'spawn_failed';
            else code = 'unreadable';
          }
          resolve({ ok: false, code, transient: TRANSIENT.has(code) });
        },
      );
    });

  return {
    /** `{ found, runId }`. Throws when Orca can't answer. */
    async showDispatch(id) {
      // `--full`: the default JSON is a concise view with no `dispatch` record.
      const reply = await run([
        'orchestration',
        'worker-show',
        '--dispatch',
        id,
        '--json',
        '--full',
      ]);
      if (!reply.ok) {
        if (reply.transient) throw Object.assign(new Error(reply.code), { code: reply.code });
        return { found: false, runId: null };
      }
      const { dispatch } = reply.result;
      // A reply we can't read says nothing about the dispatch, so it isn't "unknown".
      if (!dispatch) throw Object.assign(new Error('unreadable'), { code: 'unreadable' });
      return {
        found: true,
        runId: dispatch.runId ?? null,
        status: dispatch.status ?? null,
        capabilityRevokedAt: dispatch.capabilityRevokedAt ?? null,
        workspaceId: reply.result.worker?.worktreeId ?? null,
        workerState: reply.result.worker?.state ?? null,
        dispatchedAt: dispatch.dispatchedAt ?? null,
        creatorDispatchId: dispatch.creatorDispatchId ?? null,
        agent: reply.result.worker?.startOptions?.launch?.effective?.agent ?? null,
        resourceState: reply.result.projection?.resource?.state ?? null,
        terminalAbsent: reply.result.terminal === null,
        terminalResourceAbsent: reply.result.terminalResource === null,
      };
    },

    /** Exhaustive same-Run census; an incomplete page is never used for an admission decision. */
    async listWorkers(runId) {
      const workers = [];
      let cursor = null;
      for (let page = 0; page < 20; page += 1) {
        const args = ['orchestration', 'worker-list', '--run', runId, '--limit', '100', '--json'];
        if (cursor) args.push('--cursor', cursor);
        const reply = await run(args);
        if (!reply.ok || !Array.isArray(reply.result?.workers))
          throw new Error('worker_list_unknown');
        workers.push(...reply.result.workers);
        if (workers.length > 500) throw new Error('worker_list_overflow');
        cursor = reply.result.nextCursor ?? null;
        if (!cursor) return workers;
      }
      throw new Error('worker_list_incomplete');
    },

    /**
     * `{ ok }`, or `{ ok: false, code, transient }`. The one place that builds
     * `--to`: anything but a coordinator address is refused before Orca runs.
     */
    async send({ to, subject, body, requestId, type = 'status' }) {
      if (!isCoordinatorAddress(to)) {
        return { ok: false, code: 'address_refused', transient: false };
      }
      const reply = await run([
        'orchestration',
        'send',
        '--to',
        to,
        '--from',
        SENDER,
        '--type',
        type,
        '--subject',
        subject,
        '--body',
        body,
        '--retry-request',
        requestId,
        '--json',
      ]);
      return reply.ok ? { ok: true } : reply;
    },
  };
}
