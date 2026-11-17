import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  AGENT_FILE_KEY_RE,
  PROJECT_KEY_RE,
  type AgentFileRow,
  type SettingsResponse,
} from '@tasklite/shared';
import { Button, Card, CardHeader, EmptyState, Skeleton } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { formatDay, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { BundledUpdatedChip, LayerChip } from './AgentChips';
import { AgentFileView } from './AgentFileView';
import { ProjectAgentSection } from './ProjectAgentSection';
import './agent-setup.css';

type Project = Pick<SettingsResponse['projects'][number], 'key' | 'name'>;

/**
 * Settings → Agent setup (`/settings/agent-setup`; UI_SPEC §6.7b; FR-121,
 * FR-122; US13): the agent files agents get, service-wide or for one
 * project, each with its effective layer and the bundled-updated flag; the
 * file view (`?file=<key>`); and the project's *Agent files & workflow*
 * section (`?project=<KEY>`). Install, the install log and the push folder
 * come next (B24): their place is held by a disabled *Install*.
 */
export function AgentSetup({ projects }: { projects: readonly Project[] }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const selectId = useId();
  const rawProject = params.get('project');
  const project = rawProject && PROJECT_KEY_RE.test(rawProject) ? rawProject : null;
  const rawFile = params.get('file');
  const file = rawFile && AGENT_FILE_KEY_RE.test(rawFile) ? rawFile : null;
  const layer = params.get('layer');
  const projectName = projects.find((p) => p.key === project)?.name ?? project;

  const q = project ? { project } : {};
  const list = useQuery({
    queryKey: queryKeys.agentFiles(q),
    queryFn: () => apiClient['agentFiles.list']({ query: q }),
  });

  return (
    <div className="agent-setup">
      <section aria-labelledby="as-files" className="settings-sec">
        <h2 id="as-files">Agent files</h2>
        <p className="src as-lede">
          The skills and the AGENTS.md block agents work from. Each file comes from Task Lite
          (bundled), your service-wide edit, or a project override, in that order of precedence.
        </p>
        <Card>
          <CardHeader
            title={project ? `Effective for ${projectName}` : 'Service-wide'}
            extra={
              <div className="row" style={{ gap: 6 }}>
                <label htmlFor={selectId} className="src">
                  Show files for
                </label>
                <select
                  id={selectId}
                  value={project ?? ''}
                  onChange={(e) =>
                    void navigate(
                      paths.agentSetup({
                        project: e.target.value || undefined,
                        file: file ?? undefined,
                      }),
                    )
                  }
                >
                  <option value="">Service-wide</option>
                  {projects.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name} ({p.key})
                    </option>
                  ))}
                </select>
              </div>
            }
          />
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
              ) : (
                <FileTable files={d.files} project={project} selected={file} />
              )
            }
          </QueryState>
          <div className="cardfoot" data-install-placeholder="">
            <span className="src">
              Installing these files into a repo or user-wide, the install log and the push folder
              come next.
            </span>
            <Button size="sm" disabled title="Install comes in the next update">
              Install (coming next)
            </Button>
          </div>
        </Card>
      </section>

      {file && (
        <AgentFileView
          key={`${file}|${project ?? ''}`}
          fileKey={file}
          project={project}
          projectName={projectName}
          initialLayer={
            layer === 'bundled' || layer === 'service' || layer === 'project' ? layer : null
          }
        />
      )}

      {project && <ProjectAgentSection project={project} projectName={projectName ?? project} />}
    </div>
  );
}

function FileTable({
  files,
  project,
  selected,
}: {
  files: readonly AgentFileRow[];
  project: string | null;
  selected: string | null;
}) {
  return (
    <div className="tablewrap">
      <table aria-label="Agent files" className="aftable">
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Comes from</th>
            <th scope="col">Version</th>
            <th scope="col">
              <span className="sr">Flags</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.key} data-agent-file={f.key} aria-current={f.key === selected || undefined}>
              <td>
                <Link
                  className="mono"
                  to={paths.agentSetup({ project: project ?? undefined, file: f.key })}
                >
                  {f.name}
                </Link>
                <span className="src">
                  {' '}
                  · {f.kind === 'skill' ? 'skill' : 'AGENTS.md / CLAUDE.md'}
                </span>
              </td>
              <td>
                <LayerChip layer={f.effective_layer} />
              </td>
              <td title={isoTitle(f.effective.created_at)}>
                v{f.effective.version_no} · {formatDay(f.effective.created_at)}
              </td>
              <td>{f.bundled_updated && <BundledUpdatedChip />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
