import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import type { SettingsResponse } from '@tasklite/shared';
import { Button, Card, EmptyState, Label, Skeleton } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { DeleteProjectDialog } from '../dialogs/DeleteProject';
import { JiraImportDialog } from '../dialogs/JiraImport';

type Project = SettingsResponse['projects'][number];

/**
 * h2 "Projects" (UI_SPEC §6.7): one row per project with counts, labels,
 * the mini status bar, "Blockers clear when", decisions, *Switch to* and
 * *Delete…*; *Import from Jira…* at the bottom. US10 fills the rows; US9 the import.
 */
export function ProjectsSection({ query }: { query: UseQueryResult<SettingsResponse> }) {
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [importing, setImporting] = useState(false);
  return (
    <section aria-labelledby="settings-projects" className="settings-sec">
      <h2 id="settings-projects">Projects</h2>
      <Card>
        <QueryState
          query={query}
          skeleton={
            <div className="pad">
              <Skeleton lines={3} label="Loading projects" />
            </div>
          }
        >
          {(d) =>
            d.projects.length === 0 ? (
              <EmptyState text="No projects yet." />
            ) : (
              d.projects.map((p) => (
                <ProjectRow key={p.key} project={p} onDelete={() => setDeleting(p)} />
              ))
            )
          }
        </QueryState>
        <div className="cardfoot">
          <span />
          <Button size="sm" onClick={() => setImporting(true)}>
            Import from Jira…
          </Button>
        </div>
      </Card>
      {deleting && (
        <DeleteProjectDialog
          project={{
            key: deleting.key,
            name: deleting.name,
            items: deleting.counts.items,
            documents: deleting.counts.documents,
          }}
          onClose={() => setDeleting(null)}
        />
      )}
      {importing && <JiraImportDialog onClose={() => setImporting(false)} />}
    </section>
  );
}

function ProjectRow({ project: p, onDelete }: { project: Project; onDelete: () => void }) {
  const { scope, setScope } = useShell();
  return (
    <div className="proj-card" data-project={p.key}>
      <div style={{ minWidth: 0 }}>
        <div className="row">
          <span className="sw" style={{ background: p.color }} aria-hidden="true" />
          <b>{p.name}</b>
          {scope === p.key && <span className="chip c-gray">Current</span>}
        </div>
        <div className="src">
          {p.key} · {p.counts.epics} epics · {p.counts.items} items · {p.counts.documents} documents
          · {p.counts.for_you} for you
        </div>
        <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
          {p.labels.map((l) => (
            <Label key={l} project={p.key} name={l} />
          ))}
        </div>
      </div>
      <div className="src">
        {p.counts.done} done · {p.counts.active} active · {p.counts.review} review ·{' '}
        {p.counts.planning} planning
      </div>
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" onClick={() => setScope(p.key)}>
          Switch to
        </Button>
        <Button size="sm" variant="danger-text" onClick={onDelete}>
          Delete…
        </Button>
      </div>
    </div>
  );
}
