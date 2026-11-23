import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  WORKTREE_VERDICTS,
  type RepoWorktreeRow,
  type WorktreeCleanupResponse,
  type WorktreeVerdict,
} from '@docket/shared';
import {
  Button,
  Callout,
  Chip,
  EmptyState,
  FilterChip,
  IconButton,
  Skeleton,
  type ChipKind,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { queryKeys } from '../../lib/api';
import { formatAge, middleTruncate } from '../../lib/format';
import { paths } from '../../lib/paths';
import { showToast } from '../../lib/undo';
import { copyText } from '../items/activity/copy';
import { AT_RISK_NEXT } from './atRisk';

export const VERDICT_LABEL: Record<WorktreeVerdict, { label: string; kind: ChipKind }> = {
  holds_work: { label: 'Holds work', kind: 'warn' },
  in_use: { label: 'In use', kind: 'info' },
  unknown: { label: 'Unknown', kind: 'neutral' },
  kept_for_later: { label: 'Kept for later', kind: 'neutral' },
  safe_to_remove: { label: 'Safe to remove', kind: 'ok' },
};

/** Rows per group before *Show all*, so hundreds of worktrees stay quick. */
export const GROUP_LIMIT = 50;
/** The server stops counting here; the cell reads "1000+". */
const COUNT_CAP = 1000;

const POLL_MS = 1500;

export interface CleanupFilter {
  verdict: WorktreeVerdict | null;
  untracked: boolean;
  text: string;
}

export function filterWorktrees(
  rows: readonly RepoWorktreeRow[],
  { verdict, untracked, text }: CleanupFilter,
): RepoWorktreeRow[] {
  const q = text.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!verdict || r.verdict === verdict) &&
      (!untracked || !r.tracked) &&
      (!q || [r.branch, r.item_id, r.item_title, r.path].some((f) => f?.toLowerCase().includes(q))),
  );
}

const known = (n: number | null) =>
  n === null ? 'Unknown' : n >= COUNT_CAP ? `${COUNT_CAP}+` : String(n);
const yesNo = (b: boolean | null) => (b === null ? 'Unknown' : b ? 'Yes' : 'No');

/** A command to check and run. Only a *Safe to remove* row has one. */
function CommandCell({ row }: { row: RepoWorktreeRow }) {
  if (row.verdict === 'holds_work' && row.owner) return <>{AT_RISK_NEXT[row.owner]}</>;
  if (row.verdict !== 'safe_to_remove') return <span className="muted">—</span>;
  if (!row.command) {
    return <>Its path has unusual characters, so Docket won’t write a command for it.</>;
  }
  return (
    <details className="wc-command">
      <summary>
        Command<span className="sr"> to remove {row.branch ?? row.path}</span>
      </summary>
      <span className="row" style={{ gap: 4 }}>
        <code>{row.command}</code>
        <IconButton
          icon="copy"
          bare
          aria-label={`Copy the command to remove ${row.branch ?? row.path}`}
          onClick={() => copyText(row.command!, 'the command')}
        />
      </span>
    </details>
  );
}

function WorktreeRow({ row }: { row: RepoWorktreeRow }) {
  const v = VERDICT_LABEL[row.verdict];
  return (
    <tr data-worktree={row.path} data-verdict={row.verdict}>
      <td className="wc-verdict">
        <Chip kind={v.kind}>{v.label}</Chip>
        <span className="src">{row.why}</span>
      </td>
      <td className="wc-branch" title={row.path}>
        <span className="mono">{row.branch ?? 'No branch (detached)'}</span>
        <span className="src mono">{middleTruncate(row.path)}</span>
      </td>
      <td>
        {row.item_id ? (
          <Link className="mono" to={paths.item(row.item_id)}>
            {row.item_id}
          </Link>
        ) : (
          <span className="muted">{row.tracked ? '—' : 'Not tracked by Docket'}</span>
        )}
      </td>
      <td className="muted">{row.last_activity_at ? formatAge(row.last_activity_at) : '—'}</td>
      <td>{known(row.uncommitted_files)}</td>
      <td>{known(row.unpushed_commits)}</td>
      <td>{yesNo(row.merged)}</td>
      <td className="wc-next">
        <CommandCell row={row} />
      </td>
    </tr>
  );
}

function WorktreeGroup({ verdict, rows }: { verdict: WorktreeVerdict; rows: RepoWorktreeRow[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, GROUP_LIMIT);
  return (
    <tbody data-verdict-group={verdict}>
      <tr className="wc-group">
        <th colSpan={8} scope="rowgroup">
          {VERDICT_LABEL[verdict].label} · {rows.length}
          {verdict === 'safe_to_remove' && (
            <span className="src wc-note">
              Docket never removes a worktree. Check each command before you run it. Git refuses a
              folder with changes and keeps the branch, but ignored files, like .env or build
              output, are deleted with the folder.
            </span>
          )}
        </th>
      </tr>
      {shown.map((r) => (
        <WorktreeRow key={r.path} row={r} />
      ))}
      {rows.length > shown.length && (
        <tr>
          <td colSpan={8}>
            <Button size="sm" onClick={() => setAll(true)}>
              Show all {rows.length}
              <span className="sr"> {VERDICT_LABEL[verdict].label} worktrees</span>
            </Button>
          </td>
        </tr>
      )}
    </tbody>
  );
}

function CleanupTable({ data }: { data: WorktreeCleanupResponse }) {
  const filterId = useId();
  const [verdict, setVerdict] = useState<WorktreeVerdict | null>(null);
  const [untracked, setUntracked] = useState(false);
  const [text, setText] = useState('');
  const rows = useMemo(
    () => filterWorktrees(data.rows, { verdict, untracked, text }),
    [data.rows, verdict, untracked, text],
  );
  const count = (v: WorktreeVerdict) => data.rows.filter((r) => r.verdict === v).length;
  const notTracked = data.rows.filter((r) => !r.tracked).length;
  return (
    <>
      <div className="wc-filters" role="group" aria-label="Filter worktrees">
        {WORKTREE_VERDICTS.map((v) => (
          <FilterChip
            key={v}
            label={VERDICT_LABEL[v].label}
            count={count(v)}
            pressed={verdict === v}
            onClick={() => setVerdict(verdict === v ? null : v)}
          />
        ))}
        <FilterChip
          label="Not tracked by Docket"
          count={notTracked}
          pressed={untracked}
          onClick={() => setUntracked(!untracked)}
        />
        <label htmlFor={filterId} className="sr">
          Filter by branch, ticket or folder
        </label>
        <input
          id={filterId}
          type="search"
          placeholder="Branch, ticket or folder"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState text="No worktrees match." />
      ) : (
        <div
          className="tablewrap"
          role="region"
          aria-label="Worktrees. Scroll sideways to see every column."
          tabIndex={0}
        >
          <table aria-label="Every worktree in the repository" className="wc-table">
            <thead>
              <tr>
                <th scope="col">Verdict</th>
                <th scope="col">Branch</th>
                <th scope="col">Ticket</th>
                <th scope="col">Last activity</th>
                <th scope="col">Uncommitted files</th>
                <th scope="col">Commits not on a remote</th>
                <th scope="col">Merged to {data.main_branch}</th>
                <th scope="col">What to do</th>
              </tr>
            </thead>
            {WORKTREE_VERDICTS.map((v) => {
              const group = rows.filter((r) => r.verdict === v);
              return group.length > 0 ? <WorktreeGroup key={v} verdict={v} rows={group} /> : null;
            })}
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Every worktree of a project's repository (owner decision 48; UI_SPEC §6.6),
 * read from git with nothing written, each with a plain verdict. Docket never
 * removes one: a *Safe to remove* row offers a command to check and run.
 */
export function WorktreeCleanup() {
  const { scope } = useShell();
  const projects = useBootstrap().data?.projects;
  const selectId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const project = scope !== 'all' ? scope : (picked ?? projects?.[0]?.key ?? null);
  const qc = useQueryClient();
  const key = queryKeys.workspaceCleanup(project ?? '');
  const query = useQuery({
    queryKey: key,
    queryFn: () => apiClient['workspaces.cleanup']({ query: { project: project! } }),
    enabled: !!project,
    refetchInterval: (q) => (q.state.data?.scanning ? POLL_MS : false),
  });
  const refresh = async () => {
    try {
      const fresh = await apiClient['workspaces.cleanup']({
        query: { project: project!, refresh: '1' },
      });
      qc.setQueryData(key, fresh);
    } catch {
      showToast('Couldn’t start the check. Try again.');
    }
  };
  const d = query.data;
  return (
    <div className="wc" data-worktree-cleanup="">
      <div className="wc-head">
        {scope === 'all' && (projects?.length ?? 0) > 0 && (
          <>
            <label htmlFor={selectId}>Project</label>
            <select id={selectId} value={project ?? ''} onChange={(e) => setPicked(e.target.value)}>
              {projects!.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} · {p.name}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="src" role="status">
          {d?.scanning
            ? `Checking worktrees: ${d.scanning.done} of ${d.scanning.total || '…'}`
            : d?.checked_at
              ? `Checked ${formatAge(d.checked_at)}. Docket doesn’t fetch, so remotes are as of your last fetch.`
              : ''}
        </span>
        {d?.repo === 'ok' && (
          <Button size="sm" onClick={() => void refresh()}>
            Check again
          </Button>
        )}
      </div>
      {!project ? (
        <EmptyState text="Add a project to check its worktrees." />
      ) : (
        <QueryState query={query} skeleton={<Skeleton lines={4} label="Loading worktrees" />}>
          {(data) =>
            data.repo === 'not_set' ? (
              <EmptyState text="This project has no repository folder set. Add one in Settings to check its worktrees." />
            ) : data.repo === 'unreadable' ? (
              <Callout tone="warn">
                Docket can’t read this project’s repository from inside the push folder, so its
                worktrees can’t be checked.
              </Callout>
            ) : data.rows.length === 0 ? (
              <Skeleton lines={4} label="Checking worktrees" />
            ) : (
              <CleanupTable data={data} />
            )
          }
        </QueryState>
      )}
    </div>
  );
}
