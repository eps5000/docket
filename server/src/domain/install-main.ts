/**
 * What a project's main branch holds of its Docket install (owner decision 56;
 * BUILD_SPEC §5.39). The helper on the host reads it (B76; Docket runs no git):
 * `git show` of the manifest on origin's copy of the main branch, else the
 * local one, parsed there so only Docket's own identifiers and hashes are
 * sent. No fetch, so it's as current as the repo's last fetch. Without fresh
 * facts from the helper it's `unknown`, and callers must say so rather than
 * guess.
 */
import { INSTALL_CLIENTS, installLayout, type InstallClient } from '@docket/shared';
import type { Db } from '../db/client.js';
import { freshHostGit } from './host-git.js';
import type { ManifestMap } from './installs.js';
import { validBranch } from './radar.js';

export type MainManifest =
  | { state: 'unknown'; branch: string | null }
  | { state: 'absent'; branch: string }
  | { state: 'present'; branch: string; install_id: string | null; manifest: ManifestMap };

/** B76: the manifests the helper reads on the main branch, per client. */
export function manifestRequest(): { client: InstallClient; paths: string[] }[] {
  return INSTALL_CLIENTS.map((client) => {
    const layout = installLayout(client, 'repo');
    return { client, paths: [layout.manifest, layout.legacyManifest] };
  });
}

/** Each client's manifest on the project's main branch, from the helper's fresh facts. */
export function readMainManifests(
  db: Db,
  project: { key: string; repo_path: string | null; main_branch: string },
  clients: readonly InstallClient[],
  now: string,
): Map<InstallClient, MainManifest> {
  const branch = project.main_branch;
  const out = new Map<InstallClient, MainManifest>();
  if (!project.repo_path || !validBranch(branch)) {
    for (const c of clients) out.set(c, { state: 'unknown', branch: null });
    return out;
  }
  const facts = freshHostGit(db, project, now);
  for (const client of clients) {
    const m = facts?.manifests[client];
    if (!m || m.state === 'unknown') {
      out.set(client, { state: 'unknown', branch });
    } else if (m.state === 'absent') {
      out.set(client, { state: 'absent', branch });
    } else {
      const manifest: ManifestMap = {};
      for (const f of m.files) manifest[f.key] = { version_id: f.version_id, sha256: f.sha256 };
      out.set(client, { state: 'present', branch, install_id: m.install_id, manifest });
    }
  }
  return out;
}
