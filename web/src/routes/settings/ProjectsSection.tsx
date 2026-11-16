import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  SATISFIED_WHEN,
  SATISFIED_WHEN_LABELS,
  type SatisfiedWhen,
  type SettingsResponse,
} from '@tasklite/shared';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Label,
  Skeleton,
} from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { useShell } from '../../app/ShellState';
import { DeleteProjectDialog } from '../dialogs/DeleteProject';
import { JiraImportDialog } from '../dialogs/JiraImport';
import { DecisionsPanel } from '../shared/DecisionsPanel';

type Project = SettingsResponse['projects'][number];

/**
 * h2 "Projects" (UI_SPEC §6.7): one row per project with counts, labels,
 * the mini status bar, "Blockers clear when", decisions, *Switch to* and
 * *Delete…*; *Import from Jira…* at the bottom. US4 fills the rows and the
 * blocker rule; US5 the decisions dialog; US10 the rest (delete); US9 the import.
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
      <BlockerRule project={p} />
      <ProjectDecisionsLink project={p} />
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

const RULE_TITLE =
  'When a blocking item counts as finished for its dependents. Agents can override it per link. PR merged is reported by the agent.';

const items = (n: number) => `${n} ${n === 1 ? 'item is' : 'items are'}`;

/**
 * "Blockers clear when" (UI_SPEC §6.7): Done, PR merged or Verified by you.
 * The change re-evaluates blocked state at once; the toast says how many
 * items it blocked again, with Undo.
 */
function BlockerRule({ project: p }: { project: Project }) {
  const id = useId();
  const qc = useQueryClient();
  const [pending, setPending] = useState<SatisfiedWhen | null>(null);
  const value = pending ?? p.default_satisfied_when;
  const change = async (rule: SatisfiedWhen) => {
    setPending(rule);
    try {
      await runOwnerMutation(
        () =>
          apiClient['projects.patch']({
            params: { key: p.key },
            body: { default_satisfied_when: rule, expected_version: p.version },
          }),
        {
          success: (r) => {
            const head = `Blocker rule for ${p.name} set to ${SATISFIED_WHEN_LABELS[rule]}.`;
            if (r.reblocked.length > 0)
              return `${head} ${items(r.reblocked.length)} blocked again.`;
            if (r.unblocked.length > 0) return `${head} ${items(r.unblocked.length)} unblocked.`;
            return head;
          },
          refetch: [queryKeys.settings()],
        },
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t change the rule. Try again.');
    }
    await qc.invalidateQueries({ queryKey: queryKeys.all });
    setPending(null);
  };
  return (
    <div className="row" style={{ gap: 6 }} data-blocker-rule={p.key}>
      <label htmlFor={id} className="src">
        Blockers clear when
      </label>
      <select
        id={id}
        value={value}
        title={RULE_TITLE}
        disabled={pending !== null}
        onChange={(e) => void change(e.target.value as SatisfiedWhen)}
      >
        {SATISFIED_WHEN.map((r) => (
          <option key={r} value={r}>
            {SATISFIED_WHEN_LABELS[r]}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * "n decisions" (UI_SPEC §6.7): a link that opens a dialog with the
 * project-wide Decisions section (§6.3.5).
 */
function ProjectDecisionsLink({ project: p }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const n = p.counts.decisions;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        data-project-decisions={p.key}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {n} {n === 1 ? 'decision' : 'decisions'}
      </Button>
      {open && (
        <Dialog title={`${p.name} · Decisions`} onClose={() => setOpen(false)} className="decdlg">
          <ProjectDecisions project={p} />
        </Dialog>
      )}
    </>
  );
}

function ProjectDecisions({ project: p }: { project: Project }) {
  const q = { project: p.key, scope_kind: 'project' as const, include_inactive: true };
  const query = useQuery({
    queryKey: queryKeys.decisions(q),
    queryFn: () => apiClient['decisions.list']({ query: q }),
  });
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Skeleton lines={2} label="Loading decisions" />;
  return (
    <DecisionsPanel
      place={{ kind: 'project', project: p.key, name: p.name }}
      records={query.data.items}
    />
  );
}
