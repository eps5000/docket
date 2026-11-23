import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  INSTALL_CLIENT_LABELS,
  type InstallOverviewResponse,
  type InstallRow,
  type UninstallResponse,
} from '@docket/shared';
import {
  Button,
  Card,
  CardHeader,
  Callout,
  Chip,
  Dialog,
  DialogCancel,
  Skeleton,
} from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { formatClock, plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { CopyBlock, errorText } from './install-common';
import { installStateChip, possessive, worktreeText } from './model';

/*
 * Installs stay in scope (owner decision 50; UI_SPEC §6.7b): All projects shows
 * each project's real install state and asks which project to install into,
 * and any install can be removed by a generated, reviewable command.
 */

type OverviewRow = InstallOverviewResponse['rows'][number];

/** The folder an install is in, as shown. */
const whereText = (row: OverviewRow) =>
  row.worktree
    ? (row.install.path ?? row.worktree.name)
    : (row.install.path ?? 'Folder not recorded');

export function InstallOverviewCard({
  projects,
  onInstall,
}: {
  projects: readonly { key: string; short_name: string }[];
  onInstall: (project: string) => void;
}) {
  const selectId = useId();
  const overview = useQuery({
    queryKey: queryKeys.installOverview(),
    queryFn: () => apiClient['installs.overview']({}),
  });
  const [picked, setPicked] = useState<string | null>(null);
  const rows = overview.data?.rows ?? [];
  const installedIn = new Set(rows.map((r) => r.project));
  const firstEmpty = projects.find((p) => !installedIn.has(p.key));
  const chosen = picked ?? firstEmpty?.key ?? projects[0]?.key ?? '';
  return (
    <Card data-install-overview="">
      <CardHeader
        title={
          <span className="withhelp">
            Installed in your projects
            <HelpLink anchor="agent-files.install-state" />
          </span>
        }
      />
      <QueryState
        query={overview}
        skeleton={
          <div className="pad">
            <Skeleton lines={2} label="Loading what’s installed" />
          </div>
        }
      >
        {() => (
          <>
            {projects.length > 0 && (
              <div className="afchoose" data-install-choose="">
                <p className="src">
                  {rows.length === 0
                    ? 'Nothing is installed yet. Choose a project to install into its repo.'
                    : 'Installs are per project. Choose one to install or update.'}
                </p>
                <div className="row wrap">
                  <label htmlFor={selectId} className="inlabel">
                    Project
                  </label>
                  <select
                    id={selectId}
                    className="input afchooseselect"
                    value={chosen}
                    onChange={(e) => setPicked(e.target.value)}
                  >
                    {projects.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.short_name}
                      </option>
                    ))}
                  </select>
                  <Button variant="primary" icon="upload" onClick={() => onInstall(chosen)}>
                    Install into its repo
                  </Button>
                </div>
              </div>
            )}
            {projects.length > 0 && (
              <div className="tablewrap">
                <table aria-label="Install state by project" className="aftable afoverview">
                  <thead>
                    <tr>
                      <th scope="col">Project</th>
                      <th scope="col">Client</th>
                      <th scope="col">Where</th>
                      <th scope="col">State</th>
                      <th scope="col">
                        <span className="sr">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.flatMap((p) => {
                      const mine = rows.filter((r) => r.project === p.key);
                      if (mine.length === 0) {
                        return [
                          <tr key={p.key} data-overview-project={p.key} data-state="not_installed">
                            <th scope="row">{p.short_name}</th>
                            <td colSpan={3}>
                              <Chip kind="neutral">Not installed</Chip>
                            </td>
                            <td className="afacts">
                              <Button
                                size="sm"
                                onClick={() => onInstall(p.key)}
                                aria-label={`Install into ${possessive(p.short_name)} repo`}
                              >
                                Install
                              </Button>
                            </td>
                          </tr>,
                        ];
                      }
                      return mine.map((r) => {
                        const chip = installStateChip(r.state, r.worktree);
                        const label = INSTALL_CLIENT_LABELS[r.client];
                        return (
                          <tr
                            key={r.install.id}
                            data-overview-project={p.key}
                            data-overview-client={r.client}
                            data-state={r.state}
                            data-worktree={r.worktree?.name}
                          >
                            <th scope="row">{p.short_name}</th>
                            <td>{label}</td>
                            <td className="mono afwhere">{whereText(r)}</td>
                            <td>
                              <Chip kind={chip.kind}>{chip.label}</Chip>
                              {r.state !== 'up_to_date' && r.worktree && (
                                <div className="src">{worktreeText(r.worktree)}</div>
                              )}
                            </td>
                            <td className="afacts">
                              <Link
                                to={paths.agentFiles({ project: p.key })}
                                aria-label={`Open ${p.short_name}`}
                              >
                                Open
                              </Link>
                              <UninstallButton
                                row={r.install}
                                name={`${label} from ${possessive(p.short_name)} repo`}
                              />
                            </td>
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </QueryState>
    </Card>
  );
}

/** *Uninstall*, with its dialog. `name` finishes "Uninstall …" for the button and the title. */
export function UninstallButton({
  row,
  name,
  again = false,
}: {
  row: InstallRow;
  name: string;
  /** After a removal that kept files: run it again once they're sorted out. */
  again?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label={`${again ? 'Uninstall again' : 'Uninstall'} ${name}`}
      >
        {again ? 'Uninstall again' : 'Uninstall'}
      </Button>
      {open && <UninstallDialog row={row} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function UninstallDialog({
  row,
  name,
  onClose,
}: {
  row: InstallRow;
  name: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UninstallResponse | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  // The button that made the command is gone: keep focus inside the dialog.
  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await apiClient['installs.uninstall']({ params: { id: row.id }, body: {} }));
      void qc.invalidateQueries({ queryKey: queryKeys.installs() });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const footer = result ? (
    <Button variant="primary" onClick={onClose}>
      Done
    </Button>
  ) : (
    <>
      <DialogCancel onClick={onClose} />
      <Button variant="primary" onClick={() => void create()} disabled={busy}>
        {busy ? 'Working…' : 'Create the command'}
      </Button>
    </>
  );

  return (
    <Dialog title={`Uninstall ${name}`} onClose={onClose} footer={footer} className="indlg">
      {result ? (
        <div
          ref={resultRef}
          tabIndex={-1}
          className="inform"
          data-uninstall-result=""
          aria-label="Uninstall command"
        >
          <div className="src">
            Works once, until {formatClock(result.expires_at)} (10 minutes). Run one where this
            install is{row.target_kind === 'repo' && !row.path ? ' (the repo folder)' : ''}. Agent
            files updates when it finishes, and it’s safe to run a new one again.
          </div>
          <CopyBlock
            text={result.command.powershell}
            label="PowerShell (Windows)"
            what="PowerShell uninstall command"
          />
          <CopyBlock
            text={result.command.bash}
            label="bash (macOS, Linux, Git Bash)"
            what="bash uninstall command"
          />
          <details className="inwhat" data-uninstall-files="">
            <summary>What it may remove ({plural(result.files.length, 'file')})</summary>
            <ul className="mono">
              {result.files.map((f) => (
                <li key={f.path}>
                  {f.path}
                  {f.what === 'block' && <span className="src"> (only its Docket section)</span>}
                  {f.what === 'connection' && (
                    <span className="src"> (only its docket server entry)</span>
                  )}
                </li>
              ))}
            </ul>
          </details>
          <details className="inwhat" data-uninstall-script="">
            <summary>Read the script it runs</summary>
            <CopyBlock
              text={result.script.powershell}
              label="PowerShell script"
              what="PowerShell script"
            />
            <CopyBlock text={result.script.bash} label="bash script" what="bash script" />
          </details>
        </div>
      ) : (
        <div className="inform" data-uninstall-dialog="">
          <p className="src" style={{ margin: 0 }}>
            Docket makes a command for you to review and run. It removes only what this install
            wrote:
          </p>
          <ul className="src afuninstallrules">
            <li>A file you changed is kept and listed.</li>
            <li>
              In CLAUDE.md or AGENTS.md, only the Docket section goes. The file is deleted only if
              nothing else is in it.
            </li>
            <li>In a connection file, only the docket server goes, and only if it’s unchanged.</li>
            <li>It never follows links, and removes a skill folder only when it’s empty.</li>
          </ul>
          {error && (
            <Callout tone="bad" role="alert">
              {error}
            </Callout>
          )}
        </div>
      )}
    </Dialog>
  );
}
