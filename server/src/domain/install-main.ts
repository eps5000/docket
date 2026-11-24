/**
 * What a project's main branch holds of its Docket install (owner decision 56;
 * BUILD_SPEC §5.39), read with the radar's read-only git: `git show` of the
 * manifest on origin's copy of the main branch, else the local one. No fetch,
 * so it's as current as the repo's last fetch. Without a repository folder
 * inside the push folder, or when a read has no answer, it's `unknown`, and
 * callers must say so rather than guess.
 */
import {
  INSTALL_MANIFEST_NAME,
  LEGACY_MANIFEST_NAME,
  installLayout,
  type InstallClient,
} from '@docket/shared';
import type { Config } from '../config.js';
import { git } from './git-read.js';
import type { ManifestMap } from './installs.js';
import { resolveRepoPath, validBranch } from './radar.js';

export type MainManifest =
  | { state: 'unknown'; branch: string | null }
  | { state: 'absent'; branch: string }
  | { state: 'present'; branch: string; install_id: string | null; manifest: ManifestMap };

function parseManifest(text: string, branch: string): MainManifest {
  try {
    const parsed = JSON.parse(text) as {
      install_id?: unknown;
      files?: { key?: unknown; version_id?: unknown; sha256?: unknown }[];
    };
    if (!Array.isArray(parsed.files)) return { state: 'unknown', branch };
    const manifest: ManifestMap = {};
    for (const f of parsed.files) {
      if (
        typeof f.key === 'string' &&
        typeof f.version_id === 'string' &&
        typeof f.sha256 === 'string'
      ) {
        manifest[f.key] = { version_id: f.version_id, sha256: f.sha256 };
      }
    }
    return {
      state: 'present',
      branch,
      install_id: typeof parsed.install_id === 'string' ? parsed.install_id : null,
      manifest,
    };
  } catch {
    return { state: 'unknown', branch };
  }
}

/** Each client's manifest on the project's main branch. */
export async function readMainManifests(
  config: Config,
  project: { repo_path: string | null; main_branch: string },
  clients: readonly InstallClient[],
): Promise<Map<InstallClient, MainManifest>> {
  const branch = project.main_branch;
  const out = new Map<InstallClient, MainManifest>();
  const all = (m: MainManifest) => {
    for (const c of clients) out.set(c, m);
    return out;
  };
  if (!project.repo_path || !validBranch(branch)) return all({ state: 'unknown', branch: null });
  let dir: string;
  try {
    dir = resolveRepoPath(config, project.repo_path);
  } catch {
    return all({ state: 'unknown', branch });
  }
  let ref: string | null = null;
  for (const candidate of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (r.unknown || r.missing) return all({ state: 'unknown', branch });
    if (r.status === 0) {
      ref = candidate;
      break;
    }
  }
  if (!ref) return all({ state: 'unknown', branch });
  for (const client of clients) {
    const { dir: folder } = installLayout(client, 'repo');
    let found: MainManifest = { state: 'absent', branch };
    for (const name of [INSTALL_MANIFEST_NAME, LEGACY_MANIFEST_NAME]) {
      const r = await git(dir, ['show', `${ref}:${folder}/${name}`]);
      if (r.unknown || r.missing) {
        found = { state: 'unknown', branch };
        break;
      }
      if (r.status === 0) {
        found = parseManifest(r.stdout, branch);
        break;
      }
    }
    out.set(client, found);
  }
  return out;
}
