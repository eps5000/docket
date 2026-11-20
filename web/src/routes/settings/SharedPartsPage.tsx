import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  normaliseSharedPartKey,
  type RadarResponse,
  type SharedPartOwnerRow,
} from '@docket/shared';
import {
  Button,
  Callout,
  Card,
  CardHeader,
  Chip,
  Dialog,
  DialogCancel,
  EmptyState,
  Skeleton,
} from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { useBreadcrumb } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { formatAge, formatStamp, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { errorText } from '../agent-files/install-common';
import { fileCount } from '../shared/sharedChanges';
import '../screens.css';

/**
 * Settings → Projects → <project> → Shared parts (UI_SPEC §6.3.6; owner
 * decision 36): the registry (key, kind, paths, single-writer, in-flight
 * declarations, lease), with *Add a part* and each part's *Edit* (paths,
 * single-writer, note, archive), and the conflict radar card (repository
 * folder, main branch, *Run radar now*, last run, open findings).
 */
export function SharedPartsPage() {
  const { key = '' } = useParams();
  const boot = useBootstrap();
  const name = boot.data?.projects.find((p) => p.key === key)?.name ?? key;
  useBreadcrumb({
    crumbs: [
      { kind: 'link', text: 'Settings', to: paths.settings() },
      { kind: 'text', text: name },
      { kind: 'current', text: 'Shared parts' },
    ],
    serviceWide: true,
  });
  const [archived, setArchived] = useState(false);
  const parts = useQuery({
    queryKey: queryKeys.sharedParts(key, archived ? { include_archived: true } : {}),
    queryFn: () =>
      apiClient['sharedParts.list']({
        params: { key },
        query: archived ? { include_archived: true } : {},
      }),
  });
  const [editing, setEditing] = useState<SharedPartOwnerRow | 'new' | null>(null);
  const archivedId = useId();
  return (
    <div className="settings shared-parts" data-project={key}>
      <div className="withhelp wh-h1">
        <h1>Shared parts · {name}</h1>
        <HelpLink anchor="settings.shared-parts" />
      </div>
      <p className="src aflede">
        The tables, models, endpoints and shared files that parallel work in {key} can collide on.
        Items declare which ones they change; Docket stops overlapping work at the claim and asks
        you. <Link to={paths.settings()}>Back to Settings</Link>
      </p>
      <Card>
        <CardHeader
          title="Registry"
          extra={
            <div className="row" style={{ gap: 8 }}>
              <label className="row src" htmlFor={archivedId} style={{ gap: 4 }}>
                <input
                  id={archivedId}
                  type="checkbox"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                Show archived
              </label>
              <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
                Add a part
              </Button>
            </div>
          }
        />
        <QueryState
          query={parts}
          skeleton={
            <div className="pad">
              <Skeleton lines={3} label="Loading shared parts" />
            </div>
          }
        >
          {(d) =>
            d.parts.length === 0 ? (
              <EmptyState text="No shared parts yet. Agents register them when they declare, or add one here." />
            ) : (
              <div className="tablewrap">
                <table aria-label="Shared parts">
                  <thead>
                    <tr>
                      <th scope="col">Part</th>
                      <th scope="col">Paths</th>
                      <th scope="col">Single-writer</th>
                      <th scope="col">In flight</th>
                      <th scope="col">
                        <span className="sr">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.parts.map((p) => (
                      <PartRow key={p.id} part={p} onEdit={() => setEditing(p)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </QueryState>
      </Card>
      <RadarCard project={key} />
      {editing && (
        <PartDialog
          project={key}
          part={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function PartRow({ part: p, onEdit }: { part: SharedPartOwnerRow; onEdit: () => void }) {
  return (
    <tr data-part={p.key} className={p.archived ? 'muted' : undefined}>
      <td>
        <div className="mono">{p.key}</div>
        <div className="src">
          {p.kind} · added by {p.created_by}
          {p.archived ? ' · archived' : ''}
        </div>
        {p.note && <div className="src">{p.note}</div>}
      </td>
      <td className="mono src">{p.paths.length > 0 ? p.paths.join(', ') : '—'}</td>
      <td>
        {p.single_writer ? (
          <>
            <Chip kind="info">single-writer</Chip>
            {p.lease && (
              <div className="src" title={isoTitle(p.lease.held_until)}>
                leased to {p.lease.item_id}
              </div>
            )}
          </>
        ) : (
          <span className="src">no</span>
        )}
      </td>
      <td>
        {p.in_flight.length === 0 ? (
          <span className="src">none</span>
        ) : (
          p.in_flight.map((c) => (
            <div key={c.id}>
              <Link to={paths.item(c.id)} className="mono">
                {c.id}
              </Link>{' '}
              <span className="src">{c.change}</span>
            </div>
          ))
        )}
      </td>
      <td>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit<span className="sr"> {p.key}</span>
        </Button>
      </td>
    </tr>
  );
}

/** *Add a part* (key, paths, single-writer, note) or a part's *Edit* (and archive or restore). */
function PartDialog({
  project,
  part,
  onClose,
}: {
  project: string;
  part: SharedPartOwnerRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const ids = { key: useId(), paths: useId(), sw: useId(), note: useId() };
  const [key, setKey] = useState('');
  const [pathsText, setPathsText] = useState(part?.paths.join('\n') ?? '');
  const [single, setSingle] = useState(part?.single_writer ?? false);
  const [note, setNote] = useState(part?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pathList = () =>
    pathsText
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
  const refetch = [queryKeys.sharedParts(project)];
  const done = async () => {
    await qc.invalidateQueries({ queryKey: [queryKeys.all[0], 'sharedParts'] });
    onClose();
  };
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      if (!part) {
        const k = normaliseSharedPartKey(key);
        if (!k.ok) {
          setError(`The key ${k.error}.`);
          return;
        }
        const out = await runOwnerMutation(
          () =>
            apiClient['sharedParts.create']({
              params: { key: project },
              body: {
                key: k.key,
                paths: pathList(),
                single_writer: single,
                ...(note.trim() ? { note: note.trim() } : {}),
              },
            }),
          { success: `Registered ${k.key}.`, refetch },
        );
        if (out) await done();
      } else {
        const out = await runOwnerMutation(
          () =>
            apiClient['sharedParts.update']({
              params: { id: part.id },
              body: {
                expected_version: part.version,
                paths: pathList(),
                single_writer: single,
                note: note.trim() ? note.trim() : null,
              },
            }),
          { success: `Saved ${part.key}.`, refetch },
        );
        if (out) await done();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!part) return;
    setBusy(true);
    try {
      const out = await runOwnerMutation(
        () =>
          apiClient['sharedParts.update']({
            params: { id: part.id },
            body: { expected_version: part.version, archived: !part.archived },
          }),
        { success: `${part.archived ? 'Restored' : 'Archived'} ${part.key}.`, refetch },
      );
      if (out) await done();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={part ? `Edit ${part.key}` : 'Add a shared part'}
      onClose={onClose}
      footer={
        <>
          {part && (
            <Button
              variant="danger-text"
              disabled={busy}
              onClick={() => void archive()}
              style={{ marginRight: 'auto' }}
            >
              {part.archived ? 'Restore' : 'Archive'}
            </Button>
          )}
          <DialogCancel onClick={onClose} />
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {part ? 'Save' : 'Add part'}
          </Button>
        </>
      }
    >
      {!part && (
        <>
          <label className="f" htmlFor={ids.key}>
            Key
          </label>
          <input
            id={ids.key}
            className="input mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="model:Token"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <div className="src">kind:name, where kind is table, model, endpoint, file or other.</div>
        </>
      )}
      <label className="f" htmlFor={ids.paths} style={{ marginTop: 10 }}>
        Paths (one per line)
      </label>
      <textarea
        id={ids.paths}
        className="input mono"
        rows={3}
        placeholder="src/Gameflow.Api/Data/Migrations/**"
        value={pathsText}
        onChange={(e) => setPathsText(e.target.value)}
      />
      <div className="src">Repo-relative globs. Changed files that match map to this part.</div>
      <label className="row" htmlFor={ids.sw} style={{ gap: 6, marginTop: 10 }}>
        <input
          id={ids.sw}
          type="checkbox"
          checked={single}
          onChange={(e) => setSingle(e.target.checked)}
        />
        Single-writer: one item at a time changes it, under a lease
      </label>
      <label className="f" htmlFor={ids.note} style={{ marginTop: 10 }}>
        Note
      </label>
      <input
        id={ids.note}
        className="input"
        maxLength={1000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && (
        <Callout tone="bad" className="mt">
          {error}
        </Callout>
      )}
    </Dialog>
  );
}

const RADAR_CHIP: Record<
  RadarResponse['state'],
  { kind: 'neutral' | 'ok' | 'info'; text: string }
> = {
  off: { kind: 'neutral', text: 'Off' },
  idle: { kind: 'info', text: 'Not run yet' },
  ok: { kind: 'ok', text: 'On' },
};

/** The conflict radar card: settings, *Run radar now*, the last run and open findings. */
function RadarCard({ project }: { project: string }) {
  const query = useQuery({
    queryKey: queryKeys.radar(project),
    queryFn: () => apiClient['radar.get']({ params: { key: project } }),
  });
  return (
    <Card padded className="mt" data-card="radar">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Conflict radar</h3>
        <QueryState query={query} skeleton={<span />}>
          {(r) => <Chip kind={RADAR_CHIP[r.state].kind}>{RADAR_CHIP[r.state].text}</Chip>}
        </QueryState>
      </div>
      <p className="src" style={{ margin: '6px 0 10px' }}>
        Every 15 minutes Docket trial-merges in-flight branches with each other and with the main
        branch, without writing to the repository, and flags pairs heading for a conflict.
      </p>
      <QueryState query={query} skeleton={<Skeleton lines={2} label="Loading the radar" />}>
        {(r) => (
          // Remounted when the saved settings change, so the fields start from them.
          <RadarBody key={`${r.repo_path ?? ''}|${r.main_branch}`} project={project} radar={r} />
        )}
      </QueryState>
    </Card>
  );
}

function RadarBody({ project, radar: r }: { project: string; radar: RadarResponse }) {
  const qc = useQueryClient();
  const ids = { repo: useId(), main: useId() };
  const [repo, setRepo] = useState(r.repo_path ?? '');
  const [main, setMain] = useState(r.main_branch);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.radar(project) });
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await runOwnerMutation(
        () =>
          apiClient['radar.settings']({
            params: { key: project },
            body: {
              repo_path: repo.trim() ? repo.trim() : null,
              main_branch: main.trim() || 'main',
            },
          }),
        { success: repo.trim() ? 'Saved the radar settings.' : 'Turned the radar off.' },
      );
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const runNow = async () => {
    setError(null);
    setBusy(true);
    try {
      const out = await apiClient['radar.run']({ params: { key: project } });
      const n = out.radar.findings.length;
      showToast(
        out.radar.state === 'off'
          ? (out.radar.off_reason ?? 'The radar is off.')
          : n === 0
            ? 'Radar run: no conflicts ahead.'
            : `Radar run: ${n} ${n === 1 ? 'conflict' : 'conflicts'} ahead.`,
      );
      await refresh();
      await qc.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {r.state === 'off' && r.off_reason && (
        <Callout tone="warn" className="mb">
          {r.off_reason}
        </Callout>
      )}
      <div className="row wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
        <div className="grow">
          <label className="f" htmlFor={ids.repo}>
            Repository folder (inside the push folder)
          </label>
          <input
            id={ids.repo}
            className="input mono"
            placeholder="gameflow-app"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </div>
        <div>
          <label className="f" htmlFor={ids.main}>
            Main branch
          </label>
          <input
            id={ids.main}
            className="input mono"
            value={main}
            onChange={(e) => setMain(e.target.value)}
          />
        </div>
        <Button disabled={busy} onClick={() => void save()}>
          Save
        </Button>
        <Button variant="primary" disabled={busy || !r.repo_path} onClick={() => void runNow()}>
          Run radar now
        </Button>
      </div>
      <div className="src" style={{ marginTop: 8 }}>
        {r.last_run_at ? (
          <span title={isoTitle(r.last_run_at)}>
            Last run {formatAge(r.last_run_at)} ago ({formatStamp(r.last_run_at)})
          </span>
        ) : (
          'Not run yet.'
        )}
      </div>
      {r.findings.length > 0 && (
        <ul className="radar-findings" aria-label="Conflicts ahead">
          {r.findings.map((f) => (
            <li key={f.id} className="lrow" data-finding={f.id}>
              <Chip kind="bad">conflict ahead</Chip>
              <span>
                {f.item_a ? <Link to={paths.item(f.item_a.id)}>{f.item_a.id}</Link> : f.branch_a} (
                {f.branch_a}) and{' '}
                {f.item_b ? <Link to={paths.item(f.item_b.id)}>{f.item_b.id}</Link> : f.branch_b}
                {f.item_b ? ` (${f.branch_b})` : ''}: {fileCount(f.files.length)}
              </span>
              <span className="src mono one grow">{f.files.slice(0, 3).join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <Callout tone="bad" className="mt">
          {error}
        </Callout>
      )}
    </>
  );
}
