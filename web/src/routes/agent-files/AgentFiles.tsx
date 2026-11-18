import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AGENT_FILE_KEY_RE, PROJECT_KEY_RE, type AgentFileRow } from '@tasklite/shared';
import { Button, Card, Chip, EmptyState, Icon, Skeleton } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { useShell } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { formatAgo, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { AgentFileView, type FileViewMode } from './AgentFileView';
import { InstallDialog, InstallLog, SetUpPushLink } from './AgentInstall';
import { usePushTarget } from './install-common';
import { kindLabel, possessive, rowCopyOutdated, rowDefaultOutdated } from './model';
import { ProposalChip, ProposalsSection, proposalCounts, usePendingProposals } from './Proposals';
import { useResetDefault, useSwitchToDefault } from './mutations';
import { WorkflowNotes } from './WorkflowNotes';
import '../screens.css';
import './agent-files.css';

/** How a file opens, passed in the navigation state by the list's buttons. */
interface OpenState {
  mode?: FileViewMode;
  /** A fresh value per click, so clicking again on an open file reopens it in that mode. */
  n?: number;
}

/**
 * Agent files (`/agent-files`, UI_SPEC §6.7b; FR-121 to FR-127; US13): the
 * skills and the AGENTS.md block agents work from. It follows the project
 * switcher:
 * - **one project:** its Workflow notes, then each file as that project uses
 *   it, the default or the project's own copy (*Customize for …*, *Edit*,
 *   *Use default*), *Install into …’s repo*, and that project's install log;
 * - **All projects:** each file's default (*Reset* to Task Lite's version),
 *   where it's customized, *Install user-wide*, and the full install log.
 *
 * `?project=<KEY|all>` switches the scope (links from elsewhere), then drops
 * out of the URL; `?file=<key>` opens a file under the list.
 */
export function AgentFiles() {
  const { scope, setScope } = useShell();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const boot = useBootstrap();
  const [installing, setInstalling] = useState(false);

  const rawProject = params.get('project');
  const fromUrl =
    rawProject === 'all' || (rawProject && PROJECT_KEY_RE.test(rawProject)) ? rawProject : null;
  useEffect(() => {
    if (!fromUrl) return;
    if (fromUrl !== scope) setScope(fromUrl);
    const next = new URLSearchParams(params);
    next.delete('project');
    setParams(next, { replace: true, state: location.state as unknown });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromUrl]);
  const current = fromUrl ?? scope;
  const projects = boot.data?.projects ?? [];
  const project = current === 'all' ? null : current;
  const projectName = project
    ? (projects.find((p) => p.key === project)?.short_name ?? project)
    : null;

  const rawFile = params.get('file');
  const file = rawFile && AGENT_FILE_KEY_RE.test(rawFile) ? rawFile : null;
  const open = (location.state ?? {}) as OpenState;
  const openFile = (key: string, mode: FileViewMode = 'view') => {
    const next = new URLSearchParams(params);
    next.delete('project');
    next.set('file', key);
    void navigate({ search: `?${next.toString()}` }, { state: { mode, n: Date.now() } });
  };
  const closeFile = () => {
    const next = new URLSearchParams(params);
    next.delete('file');
    next.delete('project');
    setParams(next);
  };

  const q = project ? { project } : {};
  const list = useQuery({
    queryKey: queryKeys.agentFiles(q),
    queryFn: () => apiClient['agentFiles.list']({ query: q }),
  });
  const push = usePushTarget();
  const pending = usePendingProposals(project);
  const counts = proposalCounts(pending.data?.proposals, project);

  return (
    <div className="agent-files stack">
      <div className="afpagehead row wrap">
        <div className="withhelp">
          <h1>
            Agent files <span className="afscope">· {projectName ?? 'Defaults'}</span>
          </h1>
          <HelpLink anchor="agent-files.page" />
        </div>
        <span className="grow" />
        <Button variant="primary" icon="upload" onClick={() => setInstalling(true)}>
          {project ? `Install into ${possessive(projectName!)} repo` : 'Install user-wide'}
        </Button>
      </div>
      <p className="src aflede">
        {project
          ? `The skills and the AGENTS.md block ${possessive(projectName!)} agents work from. Each file is the default unless you customize it for ${projectName}.`
          : 'The skills and the AGENTS.md block every project uses, unless you customize a file for one project. Pick a project in the switcher to see what it uses.'}
        {push.data && !push.data.configured && (
          <>
            {' '}
            Install gives you a command to paste; to let Task Lite write the files itself,{' '}
            <SetUpPushLink />.
          </>
        )}
      </p>

      <ProposalsSection project={project} projectName={projectName} projects={projects} />

      {project && <WorkflowNotes project={project} projectName={projectName!} />}

      <Card className="aflist">
        <QueryState
          query={list}
          skeleton={
            <div className="pad">
              <Skeleton lines={4} label="Loading agent files" />
            </div>
          }
        >
          {(d) =>
            d.files.length === 0 ? (
              <EmptyState text="No agent files loaded yet. They load when Task Lite starts." />
            ) : project ? (
              <ProjectTable
                files={d.files}
                project={project}
                projectName={projectName!}
                selected={file}
                onOpen={openFile}
                proposals={counts}
              />
            ) : (
              <DefaultsTable
                files={d.files}
                projects={projects}
                selected={file}
                onOpen={openFile}
                proposals={counts}
              />
            )
          }
        </QueryState>
      </Card>

      {file && (
        <AgentFileView
          key={`${file}|${project ?? ''}|${open.n ?? ''}`}
          fileKey={file}
          project={project}
          projectName={projectName}
          mode={open.mode ?? 'view'}
          onClose={closeFile}
        />
      )}

      <InstallLog project={project} projectName={projectName} />

      {installing && (
        <InstallDialog
          project={project}
          projectName={projectName}
          onClose={() => setInstalling(false)}
        />
      )}
    </div>
  );
}

function FileName({ f, proposals }: { f: AgentFileRow; proposals?: number }) {
  return (
    <>
      <Link className="mono" to={{ search: `?file=${encodeURIComponent(f.key)}` }}>
        {f.name}
      </Link>
      <span className="src"> · {kindLabel(f.kind)}</span>
      {proposals ? (
        <span className="afchips">
          {' '}
          <ProposalChip count={proposals} />
        </span>
      ) : null}
    </>
  );
}

/** One project: FILE · USING · actions, and a "default changed" line under a flagged copy. */
function ProjectTable({
  files,
  project,
  projectName,
  selected,
  onOpen,
  proposals,
}: {
  files: readonly AgentFileRow[];
  project: string;
  projectName: string;
  selected: string | null;
  onOpen: (key: string, mode?: FileViewMode) => void;
  /** Pending proposals per file (the "1 proposal" chip). */
  proposals: ReadonlyMap<string, number>;
}) {
  const switchToDefault = useSwitchToDefault();
  return (
    <div className="tablewrap">
      <table aria-label={`Agent files ${projectName} uses`} className="aftable">
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Using</th>
            <th scope="col">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => {
            const copy = f.effective_layer === 'project' ? f.layers.project : null;
            const outdated = rowCopyOutdated(f);
            return [
              <tr
                key={f.key}
                data-agent-file={f.key}
                data-using={copy ? 'copy' : 'default'}
                aria-current={f.key === selected || undefined}
                className={outdated ? 'hasflag' : undefined}
              >
                <td>
                  <FileName f={f} proposals={proposals.get(f.key)} />
                </td>
                <td>
                  {copy ? (
                    <span title={isoTitle(copy.created_at)}>
                      <b>{possessive(projectName)} copy</b>
                      <span className="src"> · edited {formatAgo(copy.created_at)}</span>
                    </span>
                  ) : (
                    <span>
                      Default
                      {f.layers.service && <span className="src"> (edited)</span>}
                    </span>
                  )}
                </td>
                <td className="afacts">
                  {copy ? (
                    <>
                      <Button size="sm" onClick={() => onOpen(f.key, 'edit')}>
                        Edit<span className="sr"> {f.name}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void switchToDefault(f, project, projectName)}
                      >
                        Use default<span className="sr"> {f.name}</span>
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => onOpen(f.key, 'edit')}>
                      Customize for {projectName}
                      <span className="sr"> {f.name}</span>
                    </Button>
                  )}
                </td>
              </tr>,
              outdated && (
                <tr key={`${f.key}-flag`} className="afflagrow" data-default-changed={f.key}>
                  <td colSpan={3}>
                    <span className="afflagtext">
                      <Icon name="attention" small />
                      The default {f.name} changed since {possessive(projectName)} copy was made.
                    </span>{' '}
                    <Button size="sm" variant="ghost" onClick={() => onOpen(f.key, 'changed')}>
                      Compare<span className="sr"> {f.name}</span>
                    </Button>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/** All projects: FILE · DEFAULT · CUSTOMIZED IN. */
function DefaultsTable({
  files,
  projects,
  selected,
  onOpen,
  proposals,
}: {
  files: readonly AgentFileRow[];
  projects: readonly { key: string; short_name: string }[];
  selected: string | null;
  onOpen: (key: string, mode?: FileViewMode) => void;
  /** Pending proposals to the default, per file. */
  proposals: ReadonlyMap<string, number>;
}) {
  const reset = useResetDefault();
  // Which projects have their own copy of each file: one list per project (no new route).
  const perProject = useQueries({
    queries: projects.map((p) => ({
      queryKey: queryKeys.agentFiles({ project: p.key }),
      queryFn: () => apiClient['agentFiles.list']({ query: { project: p.key } }),
    })),
  });
  const customizedIn = (key: string) =>
    projects.filter((_, i) =>
      perProject[i]?.data?.files.some((f) => f.key === key && f.effective_layer === 'project'),
    );
  return (
    <div className="tablewrap">
      <table aria-label="Default agent files" className="aftable">
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Default</th>
            <th scope="col">Customized in</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => {
            const edit = f.layers.service;
            const outdated = rowDefaultOutdated(f);
            const ins = customizedIn(f.key);
            return [
              <tr
                key={f.key}
                data-agent-file={f.key}
                data-default={edit ? 'edited' : 'task-lite'}
                aria-current={f.key === selected || undefined}
                className={outdated ? 'hasflag' : undefined}
              >
                <td>
                  <FileName f={f} proposals={proposals.get(f.key)} />
                </td>
                <td>
                  {edit ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Chip kind="info">Edited</Chip>
                      <span className="src" title={isoTitle(edit.created_at)}>
                        {formatAgo(edit.created_at)}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => void reset(f)}>
                        Reset<span className="sr"> {f.name} to Task Lite’s version</span>
                      </Button>
                    </span>
                  ) : (
                    <span>Task Lite’s version</span>
                  )}
                </td>
                <td data-customized-in="">
                  {ins.length === 0 ? (
                    <span className="src" aria-label="Not customized">
                      —
                    </span>
                  ) : (
                    ins.map((p, i) => (
                      <span key={p.key}>
                        {i > 0 && ', '}
                        <Link to={paths.agentFiles({ project: p.key, file: f.key })}>
                          {p.short_name}
                        </Link>
                      </span>
                    ))
                  )}
                </td>
              </tr>,
              outdated && (
                <tr key={`${f.key}-flag`} className="afflagrow" data-default-changed={f.key}>
                  <td colSpan={3}>
                    <span className="afflagtext">
                      <Icon name="attention" small />
                      Task Lite’s version of {f.name} changed since you edited the default.
                    </span>{' '}
                    <Button size="sm" variant="ghost" onClick={() => onOpen(f.key, 'changed')}>
                      Compare<span className="sr"> {f.name}</span>
                    </Button>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
