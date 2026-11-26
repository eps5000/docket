/** Current local Orca work, projected without messages, titles or terminal output. */
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'orca-presence';
export const intervalMs = 30_000;
export const enabled = (settings) => settings?.enabled === true;

const ITEM = /(?<![A-Z0-9])([A-Z][A-Z0-9]*-[0-9]+)(?![A-Z0-9])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_PATH = /^[A-Za-z]:[\\/](?![\\/])/;

export function orcaExecutable(env = process.env) {
  const candidate =
    env.DOCKET_SYNC_ORCA ??
    (env.LOCALAPPDATA
      ? join(env.LOCALAPPDATA, 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
      : null);
  if (!candidate) return null;
  try {
    if (statSync(candidate).isFile()) {
      accessSync(candidate, constants.F_OK);
      return candidate;
    }
  } catch {
    // Missing CLI means presence is unknown; the previous observation ages out.
  }
  return null;
}

export function projectWorkingAgents(reply, observedAt) {
  if (
    reply?.ok !== true ||
    reply.result?.truncated !== false ||
    !Array.isArray(reply.result.agents) ||
    reply.result.hostScope?.omittedHostIds?.length
  ) {
    throw Object.assign(new Error('Orca list incomplete'), { code: 'orca_incomplete' });
  }
  if (reply.result.agents.length > 500) {
    throw Object.assign(new Error('Orca list too large'), { code: 'orca_incomplete' });
  }
  const records = [];
  for (const agent of reply.result.agents) {
    if (
      agent?.kind !== 'chat' ||
      agent.state !== 'working' ||
      agent.hostId !== 'local' ||
      !['codex', 'claude'].includes(agent.agent) ||
      !UUID.test(agent.orcaSessionId ?? '')
    )
      continue;
    const parts = typeof agent.worktreeId === 'string' ? agent.worktreeId.split('::') : [];
    const path = parts.length === 2 ? parts[1] : null;
    if (!path || !LOCAL_PATH.test(path) || path.length > 1024 || /[\x00-\x1f\x7f]/.test(path))
      continue;
    const keys = [...new Set((agent.title?.match(ITEM) ?? []).map((s) => s.toUpperCase()))];
    if (keys.length !== 1 || keys[0].length > 40) continue;
    records.push({
      key: `orca:${agent.orcaSessionId.toLowerCase()}`,
      session: agent.orcaSessionId.toLowerCase(),
      client: agent.agent,
      item: keys[0],
      path,
      observed_at: observedAt,
    });
  }
  return records;
}

export const collect = async ({ signal }) => {
  const exe = orcaExecutable();
  if (!exe) throw Object.assign(new Error('Orca unavailable'), { code: 'orca_unavailable' });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^ORCA_/i.test(key)),
  );
  const output = await new Promise((resolve, reject) => {
    execFile(
      exe,
      ['agent', 'list', '--state', 'working', '--json'],
      {
        shell: false,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        env,
        signal,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  }).catch(() => {
    throw Object.assign(new Error('Orca unavailable'), { code: 'orca_unavailable' });
  });
  let reply;
  try {
    reply = JSON.parse(output);
  } catch {
    throw Object.assign(new Error('Orca output unreadable'), { code: 'orca_incomplete' });
  }
  return { records: projectWorkingAgents(reply, new Date().toISOString()), state: {} };
};
