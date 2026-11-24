import {
  connectionCanonical,
  type InstallClient,
  type InstallState,
  type InstallWorktree,
} from '@docket/shared';
/**
 * How Agent files presents the stored layers (UI_SPEC §6.7b; BUILD_SPEC
 * §5.17, B25). The storage model is unchanged: bundled, the service-wide
 * edit and the project override. The UI shows two ideas instead:
 * - **the default**: the service-wide edit if there is one, else Docket's
 *   (bundled) version. "Reset to Docket's version" reverts the edit;
 * - **<Project>'s copy**: the project override, which exists only once the
 *   owner customizes a file for that project. "Use default" reverts it.
 * The words bundled, layer, override and service-wide never reach the screen.
 */
import type {
  AgentFileDetail,
  AgentFileLayer,
  AgentFileRow,
  AgentFileVersion,
  PushTargetResponse,
} from '@docket/shared';

export interface Version extends AgentFileVersion {
  layer: AgentFileLayer;
  /** The layer's current version (a reverted layer has none). */
  current: boolean;
}

/** `Gameflow’s` (a possessive that reads well after a project name). */
export const possessive = (name: string) => `${name}’s`;

/** A version's name on screen: "Docket’s version v2", "Edited default v1", "Gameflow’s copy v3". */
export function versionLabel(
  v: Pick<Version, 'layer' | 'version_no'>,
  projectName: string | null,
): string {
  if (v.layer === 'bundled') return `Docket’s version v${v.version_no}`;
  if (v.layer === 'service') return `Edited default v${v.version_no}`;
  return `${possessive(projectName ?? 'Project')} copy v${v.version_no}`;
}

/** Every version of every layer of a file, newest first within each layer. */
export function versionsOf(d: AgentFileDetail): Version[] {
  const all: Version[] = [];
  for (const l of ['project', 'service', 'bundled'] as const) {
    const ld = d.layers[l];
    for (const v of ld?.versions ?? []) {
      all.push({ ...v, layer: l, current: v.version_no === ld!.current_version_no });
    }
  }
  return all;
}

export const currentOf = (versions: readonly Version[], l: AgentFileLayer) =>
  versions.find((v) => v.layer === l && v.current);

/** The default's current version: the edited default, else Docket's version. */
export const defaultOf = (versions: readonly Version[]) =>
  currentOf(versions, 'service') ?? currentOf(versions, 'bundled');

/** The default's history: its edits and Docket's versions, newest first. */
export const defaultHistory = (versions: readonly Version[]) =>
  versions
    .filter((v) => v.layer !== 'project')
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.version_no - a.version_no);

/**
 * The default as it was at `at`: the latest edit made by then, else the
 * latest Docket version by then. (A reset isn't a version, so a default
 * that was edited and reset before `at` reads as the edit.)
 */
export function defaultAt(versions: readonly Version[], at: string): Version | undefined {
  const by = (l: AgentFileLayer) =>
    versions
      .filter((v) => v.layer === l && v.created_at <= at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return by('service') ?? by('bundled');
}

/**
 * Why a project's copy is flagged "The default changed since <P>’s copy was
 * made", with the two versions to compare (what changed in the default), or
 * null. Either Docket shipped a new version since the copy (the server's
 * bundled-updated flag on the project layer), or the default was edited
 * after the copy's current version.
 */
export function copyOutdated(
  d: AgentFileDetail,
  versions: readonly Version[],
): { from: Version | undefined; to: Version | undefined } | null {
  const copy = currentOf(versions, 'project');
  if (!copy) return null;
  const flag = d.bundled_updated;
  if (flag && flag.edited_layer === 'project') {
    return {
      from: flag.from_version_id ? versions.find((v) => v.id === flag.from_version_id) : undefined,
      to: versions.find((v) => v.id === flag.to_version_id),
    };
  }
  const edit = currentOf(versions, 'service');
  if (edit && edit.created_at > copy.created_at) {
    return { from: defaultAt(versions, copy.created_at), to: edit };
  }
  return null;
}

/** The same test on a list row (no history needed). */
export function rowCopyOutdated(row: AgentFileRow): boolean {
  if (row.effective_layer !== 'project' || !row.layers.project) return false;
  if (row.bundled_updated) return true;
  return !!row.layers.service && row.layers.service.created_at > row.layers.project.created_at;
}

/** All projects: Docket shipped a new version since the default was edited. */
export const rowDefaultOutdated = (row: AgentFileRow) =>
  row.effective_layer === 'service' && row.bundled_updated;

export const kindLabel = (kind: AgentFileRow['kind']) =>
  kind === 'skill'
    ? 'skill'
    : kind === 'guide'
      ? 'served by onboard_project, not installed'
      : 'AGENTS.md / CLAUDE.md';

const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Whether a folder is inside the push folder, as the server maps it
 * (`push-root.ts`): under the host path (any case and slashes for a Windows
 * path), under the container path, or relative to the root. The server
 * checks again; this only picks the install method.
 */
export function insidePushFolder(path: string, target: PushTargetResponse | undefined): boolean {
  if (!target?.configured) return false;
  const p = norm(path);
  if (p === '') return false;
  const under = (root: string | null, ci: boolean) => {
    if (!root) return false;
    const r = norm(root);
    const [a, b] = ci ? [p.toLowerCase(), r.toLowerCase()] : [p, r];
    return a === b || a.startsWith(`${b}/`);
  };
  if (under(target.host_path, /^[a-z]:/i.test(target.host_path ?? ''))) return true;
  if (under(target.container_path, false)) return true;
  const absolute = p.startsWith('/') || p.startsWith('~') || /^[a-z]:/i.test(p);
  return !absolute && !p.split('/').includes('..');
}

/** Push is usable: configured, mounted and writable. */
export const pushReady = (t: PushTargetResponse | undefined) => !!t?.configured && !!t.writable;

/**
 * The connection file's docket entry as Docket sent it (decision 32), as the
 * check compares it: canonical text, for this Docket's MCP address.
 */
export function connectionSentText(client: InstallClient, versionId: string | undefined): string {
  const host = typeof window === 'undefined' ? '127.0.0.1:7420' : window.location.host;
  return connectionCanonical(client, `http://${host}/mcp`, versionId === 'connection:protected');
}

// ---- Install state (decision 34; UI_SPEC §6.7b) ----

/** Each state's chip text and kind. */
export const INSTALL_STATE_VIEW: Record<
  InstallState,
  { label: string; kind: 'ok' | 'info' | 'warn' | 'neutral' }
> = {
  up_to_date: { label: 'Installed · up to date', kind: 'ok' },
  update_available: { label: 'Installed · update available', kind: 'info' },
  changed: { label: 'Changed outside Docket', kind: 'warn' },
  not_installed: { label: 'Not installed', kind: 'neutral' },
};

/**
 * Decision 50: where a repo install lives, when it's a separate worktree.
 * Docket can't see the main branch, so it never calls such an install simply current.
 */
export const worktreeText = (w: InstallWorktree): string =>
  w.merged
    ? `In worktree ${w.name}, whose ticket has a merged PR`
    : `Installed in worktree ${w.name}, not merged yet`;

/** The state chip, which names the worktree instead of saying "up to date". */
export function installStateChip(
  state: InstallState,
  worktree: InstallWorktree | null | undefined,
): { label: string; kind: 'ok' | 'info' | 'warn' | 'neutral' } {
  if (state === 'up_to_date' && worktree) return { label: worktreeText(worktree), kind: 'info' };
  return INSTALL_STATE_VIEW[state];
}

/**
 * Decision 56: what the repo's main branch holds, in words. When Docket can't
 * read the repo it says so, rather than implying the last install was merged.
 */
export function repoMainText(main: {
  state: 'current' | 'behind' | 'absent' | 'unknown';
  branch: string | null;
}): string {
  const branch = main.branch ?? 'the main branch';
  if (main.state === 'current') return `On ${branch}: current.`;
  if (main.state === 'behind') return `${branch} has older files.`;
  if (main.state === 'absent') return `Not on ${branch} yet.`;
  return 'Docket can’t read this repo’s main branch, so it can’t tell what has been merged.';
}

/** What installing does to a client in each state: never a plain Install once it's installed. */
export type InstallVerb = 'Install' | 'Update' | 'Reinstall';
export const installVerb = (state: InstallState | undefined): InstallVerb =>
  state === 'update_available'
    ? 'Update'
    : state === 'up_to_date' || state === 'changed'
      ? 'Reinstall'
      : 'Install';

/**
 * The Install dialog's button for the ticked clients' states: one verb when
 * they agree, else the verbs joined ("Install and update"), so a client that's
 * already installed is never offered a plain Install.
 */
export function installButtonLabel(states: readonly (InstallState | undefined)[]): string {
  const order: InstallVerb[] = ['Install', 'Update', 'Reinstall'];
  const verbs = order.filter((v) => states.some((s) => installVerb(s) === v));
  if (verbs.length === 0) return 'Install';
  return [verbs[0]!, ...verbs.slice(1).map((v) => v.toLowerCase())].join(' and ');
}
