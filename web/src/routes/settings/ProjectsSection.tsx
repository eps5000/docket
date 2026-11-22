import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  SATISFIED_WHEN,
  SATISFIED_WHEN_LABELS,
  type SatisfiedWhen,
  type SettingsResponse,
} from '@docket/shared';
import { Button, Card, EmptyState, Label, Skeleton, StatusBar } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { useShell } from '../../app/ShellState';
import { DeleteProjectDialog } from '../dialogs/DeleteProject';
import { HelpLink } from '../../help/HelpLink';

type Project = SettingsResponse['projects'][number];

/**
 * h2 "Projects" (UI_SPEC §6.7): one row per project with counts, labels,
 * the mini status bar, "Blockers clear when", decisions, *Switch to* and
 * *Delete…*; *Import from Jira…* at the bottom. US4 fills the rows and the
 * blocker rule; US5 the decisions link (a page since decision 38); US10 the mini status bar and
 * delete; US9 the import. *New project* and *Import from Jira…* open the
 * shell's project dialogs (B32: the same ones as the Welcome page).
 */
export function ProjectsSection({ query }: { query: UseQueryResult<SettingsResponse> }) {
  const [deleting, setDeleting] = useState<Project | null>(null);
  const qc = useQueryClient();
  const { scope, setScope, tabs, closeTab, setProjectDialog } = useShell();
  const keepDays = query.data?.health.backups[0]?.keep_days ?? 14;
  /** After a delete: leave its scope and its open tabs, toast, and refetch everything. */
  const deleted = (p: Project) => {
    if (scope === p.key) setScope('all');
    for (const t of tabs.tabs) if (t.id.startsWith(`${p.key}-`)) closeTab(t.id, null);
    showToast(`Deleted ${p.name}.`);
    void qc.invalidateQueries({ queryKey: queryKeys.all });
  };
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
          <div className="row" style={{ gap: 6 }}>
            <Button size="sm" onClick={() => setProjectDialog({ kind: 'jira' })}>
              Import from Jira…
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon="plus"
              onClick={() => setProjectDialog({ kind: 'new' })}
            >
              New project
            </Button>
          </div>
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
          keepDays={keepDays}
          onClose={() => setDeleting(null)}
          onDeleted={() => deleted(deleting)}
        />
      )}
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
          {p.created_by && <CreatedByChip agent={p.created_by} />}
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
      <MiniStatusBar project={p} />
      <BlockerRule project={p} />
      <Coordinators project={p} />
      <div className="row wrap" style={{ gap: 2 }}>
        <ProjectDecisionsLink project={p} />
        <Link
          className="btn ghost sm"
          to={paths.agentFiles({ project: p.key })}
          data-project-agent-files={p.key}
        >
          Agent files
        </Link>
        <Link
          className="btn ghost sm"
          to={paths.sharedParts(p.key)}
          data-project-shared-parts={p.key}
        >
          Shared parts
        </Link>
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

/**
 * "created by <agent> · review" (UI_SPEC §6.7d; FR-140): an agent set this
 * project up through onboard_project, and the owner hasn't reviewed it yet.
 * It links to Needs you, where the review card is.
 */
export function CreatedByChip({ agent }: { agent: string }) {
  const who = agent.split(' · ')[0] ?? agent;
  return (
    <Link
      to={paths.needsYou()}
      className="chip c-warn"
      data-created-by={agent}
      title="Review the onboarding on Needs you"
    >
      created by {who} · review
    </Link>
  );
}

/** The mini status bar (UI_SPEC §6.7), with its counts in text (never colour alone). */
function MiniStatusBar({ project: p }: { project: Project }) {
  const c = p.counts;
  return (
    <div>
      <StatusBar
        counts={{ done: c.done, review: c.review, progress: c.active, planning: c.planning }}
        label={`${c.done} done, ${c.review} in review, ${c.active} in progress, ${c.planning} planning`}
        mini
      />
      <div className="src" style={{ marginTop: 3 }}>
        {c.done} done · {c.active} active · {c.review} review · {c.planning} planning
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
      <HelpLink anchor="settings.blocker-rule" />
    </div>
  );
}

/**
 * Decision 42: who may correct a run's status with `update_run_status` on this
 * project, besides the coordinator recorded on the run. Names, comma-separated.
 */
function Coordinators({ project: p }: { project: Project }) {
  const id = useId();
  const qc = useQueryClient();
  const saved = (p.coordinators ?? []).join(', ');
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? saved;
  const save = async () => {
    if (draft === null || draft.trim() === saved) {
      setDraft(null);
      return;
    }
    const coordinators = draft
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    setBusy(true);
    try {
      await runOwnerMutation(
        () =>
          apiClient['projects.patch']({
            params: { key: p.key },
            body: { coordinators, expected_version: p.version },
          }),
        {
          success: () =>
            coordinators.length
              ? `Coordinators for ${p.name}: ${coordinators.join(', ')}.`
              : `No coordinators registered for ${p.name}.`,
          refetch: [queryKeys.settings()],
        },
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t save the coordinators. Try again.');
    }
    await qc.invalidateQueries({ queryKey: queryKeys.all });
    setDraft(null);
    setBusy(false);
  };
  return (
    <div className="row" style={{ gap: 6 }} data-coordinators={p.key}>
      <label htmlFor={id} className="src">
        Coordinators
      </label>
      <input
        id={id}
        value={value}
        disabled={busy}
        placeholder="None"
        title="Names, separated by commas. They can update a run's status here, and nothing else."
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </div>
  );
}

/**
 * "n decisions" (UI_SPEC §6.7): a link to the project's Decisions page
 * (decision 38; §6.3.7), where project-wide records are managed.
 */
function ProjectDecisionsLink({ project: p }: { project: Project }) {
  const n = p.counts.decisions;
  return (
    <Link
      className="btn ghost sm"
      to={paths.projectDecisions(p.key)}
      data-project-decisions={p.key}
      aria-label={`${n} ${n === 1 ? 'decision' : 'decisions'}: ${p.name} project decisions`}
    >
      {n} {n === 1 ? 'decision' : 'decisions'}
    </Link>
  );
}
