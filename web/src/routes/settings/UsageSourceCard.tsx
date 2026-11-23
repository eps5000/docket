import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import type { CoordinatorFolder, SettingsResponse, UsageSettingsResponse } from '@docket/shared';
import { Button, Card, Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { formatAgo, isoTitle, plural } from '../../lib/format';
import { showToast } from '../../lib/undo';
import { errorText } from '../agent-files/install-common';
import { USAGE_SOURCE_NOTE, USAGE_SOURCE_OFF_NOTE, USAGE_SOURCE_TITLE } from '../usage/usageText';
import '../usage/usage.css';

/** Off, on with no helper, or the last read: always in words. */
export function usageStatusText(d: Pick<UsageSettingsResponse, 'helper' | 'last_read_at'>): string {
  if (d.helper === 'off') return 'Off';
  if (d.helper === 'not_running') {
    return d.last_read_at
      ? `On, but the helper isn’t running. Last read ${formatAgo(d.last_read_at)}.`
      : 'On, but the helper isn’t running.';
  }
  return `On. Last read ${d.last_read_at ? formatAgo(d.last_read_at) : 'just now'}.`;
}

/**
 * Settings → Connections → Measure token use (decision 48; UI_SPEC §6.7): the
 * switch, off by default, with the owner's note visible before it's turned on
 * and the status beside it. Coordinator folders appear once it's on.
 */
export function UsageSourceCard({ projects }: { projects: SettingsResponse['projects'] }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.usageSettings(),
    queryFn: () => apiClient['usageSettings.get']({}),
  });
  const switchId = useId();
  const [pending, setPending] = useState<boolean | null>(null);

  const save = async (enabled: boolean, folders: CoordinatorFolder[] | undefined, ok: string) => {
    try {
      // Not undoable: the switch is its own undo, so the toast offers none.
      await apiClient['usageSettings.set']({
        body: { enabled, ...(folders ? { coordinator_folders: folders } : {}) },
      });
      showToast(ok);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.usageSettings() }),
        qc.invalidateQueries({ queryKey: queryKeys.family('needsYou') }),
        qc.invalidateQueries({ queryKey: queryKeys.family('item') }),
      ]);
      return true;
    } catch (err) {
      showToast(errorText(err));
      return false;
    }
  };

  const toggle = async (enabled: boolean) => {
    // The switch shows the choice at once and stays enabled, so focus stays on it (B34).
    setPending(enabled);
    await save(enabled, undefined, enabled ? 'Token use is on.' : 'Token use is off.');
    setPending(null);
  };

  return (
    <Card padded data-card="usage-source">
      <QueryState
        query={query}
        skeleton={<Skeleton lines={4} label="Loading the token use setting" />}
      >
        {(d) => {
          const on = pending ?? d.enabled;
          return (
            <>
              <div className="usage-source-head">
                <div className="withhelp wh-h3">
                  <h3 id={`${switchId}-title`}>{USAGE_SOURCE_TITLE}</h3>
                  <HelpLink anchor="settings.token-use" />
                </div>
                <span className="usage-source-switch">
                  <span className="src" id={`${switchId}-status`} data-usage-status={d.helper}>
                    <span title={d.last_read_at ? isoTitle(d.last_read_at) : undefined}>
                      {usageStatusText(d)}
                    </span>
                  </span>
                  <input
                    id={switchId}
                    type="checkbox"
                    role="switch"
                    checked={on}
                    aria-checked={on}
                    aria-labelledby={`${switchId}-title`}
                    aria-describedby={`${switchId}-status ${switchId}-note`}
                    onChange={(e) => void toggle(e.target.checked)}
                  />
                </span>
              </div>
              <div id={`${switchId}-note`}>
                <p className="usage-source-note" data-usage-note>
                  {USAGE_SOURCE_NOTE}
                </p>
                <p className="src usage-source-note">
                  {USAGE_SOURCE_OFF_NOTE}
                  {d.turns_stored > 0
                    ? ` Docket holds ${plural(d.turns_stored, 'recorded response')}.`
                    : ''}
                </p>
              </div>
              {d.enabled && (
                <CoordinatorFolders
                  folders={d.coordinator_folders}
                  projects={projects}
                  onSave={(next, ok) => save(true, next, ok)}
                />
              )}
            </>
          );
        }}
      </QueryState>
    </Card>
  );
}

/** Where coordinator and heartbeat sessions run: their tokens count as project overhead. */
function CoordinatorFolders({
  folders,
  projects,
  onSave,
}: {
  folders: readonly CoordinatorFolder[];
  projects: SettingsResponse['projects'];
  onSave: (next: CoordinatorFolder[], ok: string) => Promise<boolean>;
}) {
  const [project, setProject] = useState('');
  const [path, setPath] = useState('');
  const chosen = project || projects[0]?.key || '';
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = path.trim();
    if (!trimmed || !chosen) return;
    if (await onSave([...folders, { project: chosen, path: trimmed }], 'Folder added.')) {
      setPath('');
    }
  };
  return (
    <div data-usage-folders>
      <h4 className="usage-sub">Coordinator folders</h4>
      <p className="src" style={{ margin: 0 }}>
        Sessions in these folders, like a coordinator or a heartbeat, count as project overhead
        rather than a ticket.
      </p>
      {folders.length > 0 && (
        <ul className="usage-folders">
          {folders.map((f) => (
            <li key={`${f.project}:${f.path}`}>
              <b>{f.project}</b>
              <span className="mono grow" title={f.path}>
                {f.path}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void onSave(
                    folders.filter((x) => x !== f),
                    'Folder removed.',
                  )
                }
              >
                Remove<span className="sr"> {f.path}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {projects.length > 0 && (
        <form className="usage-folder-add" onSubmit={(e) => void add(e)}>
          <label>
            Project
            <select value={chosen} onChange={(e) => setProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="usage-folder-path">
            Folder
            <input
              className="input"
              value={path}
              maxLength={500}
              placeholder="C:\work\my-project"
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <Button size="sm" type="submit" disabled={path.trim().length < 2}>
            Add folder
          </Button>
        </form>
      )}
    </div>
  );
}
