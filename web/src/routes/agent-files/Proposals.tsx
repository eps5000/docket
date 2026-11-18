import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { AGENT_SETUP_LIMITS, type Proposal } from '@tasklite/shared';
import { Button, Callout, Card, Chip, Icon, InlineEditor } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { formatAgo, isoTitle, plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { DiffView } from './DiffView';
import { possessive, versionsOf } from './model';

/** What a proposal's decision refreshes: the list, the files, the notes, Needs you. */
const REFRESH = [
  queryKeys.family('proposals'),
  queryKeys.family('agentFiles'),
  queryKeys.family('workflow'),
  queryKeys.family('needsYou'),
];

/** Pending proposals for one project (`project`), or for the defaults and every project (null). */
export function usePendingProposals(project: string | null) {
  const query = project ? { project, state: 'pending' as const } : { state: 'pending' as const };
  return useQuery({
    queryKey: queryKeys.proposals(query),
    queryFn: () => apiClient['proposals.list']({ query }),
  });
}

/** Pending proposals per file key, for the "1 proposal" chips on file rows. */
export function proposalCounts(
  proposals: readonly Proposal[] | undefined,
  project: string | null,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of proposals ?? []) {
    if (p.project !== project) continue;
    out.set(p.file_key, (out.get(p.file_key) ?? 0) + 1);
  }
  return out;
}

/** The "1 proposal" chip on a file row (UI_SPEC §6.7b-1). */
export function ProposalChip({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <a href="#proposals" className="afchiplink" data-proposal-chip="">
      <Chip kind="info" icon="bot">
        {plural(count, 'proposal')}
      </Chip>
    </a>
  );
}

/**
 * "Proposed changes · n" (UI_SPEC §6.7b-1; FR-129), above the files: each
 * pending proposal with the file, the agent and run, the reason, and a diff
 * against the version in use, or the three-way view when the file changed
 * since the agent read it; *Approve*, *Edit, then approve* and *Decline…*.
 *
 * With a project selected it lists that project's proposals. With All
 * projects it lists proposals to the default, and a line per project that
 * has its own, linking to it.
 */
export function ProposalsSection({
  project,
  projectName,
  projects,
}: {
  project: string | null;
  projectName: string | null;
  projects: readonly { key: string; short_name: string }[];
}) {
  const list = usePendingProposals(project);
  const location = useLocation();
  const ref = useRef<HTMLElement>(null);
  const all = list.data?.proposals ?? [];
  const mine = all.filter((p) => p.project === project);
  const elsewhere = project ? [] : groupByProject(all.filter((p) => p.project !== null));

  // `#proposals` (Needs you, the row chips): bring the section into view once it's there.
  const shown = mine.length + elsewhere.length > 0;
  useEffect(() => {
    if (shown && location.hash === '#proposals') ref.current?.scrollIntoView({ block: 'start' });
  }, [shown, location.hash]);

  if (!shown) return null;
  const name = (key: string) => projects.find((p) => p.key === key)?.short_name ?? key;
  return (
    <section
      ref={ref}
      id="proposals"
      className="afproposals stack"
      aria-labelledby="afp-title"
      data-proposals=""
    >
      <h2 id="afp-title">
        Proposed changes <span className="muted">· {mine.length}</span>
      </h2>
      <p className="src aflede">
        Agents proposed these changes. Nothing changes until you approve one;
        {project
          ? ` approving saves it as ${possessive(projectName!)} copy (or its Workflow notes).`
          : ' approving one here saves it as the default, for every project without its own copy.'}
      </p>
      {mine.map((p) => (
        <ProposalCard key={p.id} p={p} projectName={projectName} />
      ))}
      {elsewhere.length > 0 && (
        <ul className="afpelse" aria-label="Proposals for a project’s copy">
          {elsewhere.map(([key, n]) => (
            <li key={key}>
              <Link to={`${paths.agentFiles({ project: key })}#proposals`}>
                {name(key)} · {plural(n, 'proposed change')}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function groupByProject(ps: readonly Proposal[]): [string, number][] {
  const m = new Map<string, number>();
  for (const p of ps) m.set(p.project!, (m.get(p.project!) ?? 0) + 1);
  return [...m].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The texts a proposal is reviewed against: what the agent read (`base`) and
 * what is in use now (`current`), from the file's versions (any layer) or
 * the project's Workflow notes versions. Undefined while loading.
 */
function useReviewTexts(p: Proposal): { base?: string; current?: string; missing: boolean } {
  const workflow = p.file_key === 'workflow';
  const fileQuery = p.project ? { project: p.project } : {};
  const file = useQuery({
    queryKey: queryKeys.agentFile(p.file_key, fileQuery),
    queryFn: () => apiClient['agentFiles.get']({ params: { key: p.file_key }, query: fileQuery }),
    enabled: !workflow,
  });
  const notes = useQuery({
    queryKey: queryKeys.workflow(p.project ?? ''),
    queryFn: () => apiClient['workflow.get']({ params: { key: p.project! } }),
    enabled: workflow && !!p.project,
  });
  const find = (id: string | null): string | undefined => {
    if (id === null) return '';
    if (workflow) return notes.data?.versions.find((v) => v.id === id)?.content_md;
    return file.data ? versionsOf(file.data).find((v) => v.id === id)?.content : undefined;
  };
  const loaded = workflow ? !!notes.data : !!file.data;
  const base = find(p.based_on_version_id);
  const current = find(p.current_version_id);
  return { base, current, missing: loaded && (base === undefined || current === undefined) };
}

/** One proposal: who, why, the diff, and the three decisions. */
function ProposalCard({ p, projectName }: { p: Proposal; projectName: string | null }) {
  const qc = useQueryClient();
  const { base, current, missing } = useReviewTexts(p);
  const [mode, setMode] = useState<'view' | 'confirm' | 'edit' | 'decline'>('view');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const target =
    p.file_key === 'workflow'
      ? 'the Workflow notes'
      : p.project
        ? `${possessive(projectName ?? p.project)} copy`
        : 'the default';

  async function decide(kind: 'approve' | 'decline', content?: string): Promise<boolean> {
    setBusy(true);
    try {
      const body = {
        ...(content !== undefined ? { content } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      const r = await runOwnerMutation(
        () =>
          kind === 'approve'
            ? apiClient['proposals.approve']({ params: { id: p.id }, body })
            : apiClient['proposals.decline']({ params: { id: p.id }, body }),
        {
          success:
            kind === 'approve'
              ? `Approved: ${p.name} saved as ${target}.`
              : `Declined the proposed change to ${p.name}.`,
          refetch: REFRESH,
        },
      );
      return r !== null;
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t save the decision. Try again.');
      return false;
    } finally {
      setBusy(false);
      await Promise.all(REFRESH.map((queryKey) => qc.invalidateQueries({ queryKey })));
    }
  }

  const who = (
    <>
      <b>{p.proposed_by}</b>
      {p.item_id && (
        <>
          {' '}
          on <Link to={paths.item(p.item_id, 'activity')}>{p.item_id}</Link>
        </>
      )}
      {p.run_id && <span className="mono"> · {p.run_id}</span>}
    </>
  );

  return (
    <Card className="afproposal pad" data-proposal={p.id}>
      <article aria-labelledby={`${p.id}-h`}>
        <div className="row wrap afphead">
          <h3 id={`${p.id}-h`} className="mono">
            {p.name}
          </h3>
          <Chip>
            {p.project ? `for ${possessive(projectName ?? p.project)} copy` : 'for the default'}
          </Chip>
          {p.changed_since && (
            <Chip kind="warn" icon="attention">
              Changed since the agent read it
            </Chip>
          )}
          <span className="grow" />
          <span className="src" title={isoTitle(p.created_at)}>
            {formatAgo(p.created_at)}
          </span>
        </div>
        <div className="src afpwho">Proposed by {who}</div>
        <blockquote className="afpreason">{p.reason}</blockquote>

        {base === undefined || current === undefined ? (
          missing ? (
            <Callout tone="warn">
              The version the agent read is no longer available, so only the proposed text is shown.
            </Callout>
          ) : (
            <div className="src">Loading the comparison…</div>
          )
        ) : p.changed_since ? (
          <div className="afpthree" data-three-way="">
            <Callout tone="warn">
              <b>{p.name} changed since the agent read it.</b> Approving replaces those changes with
              the agent’s text. Compare both, then <i>Edit, then approve</i> to keep what you need.
            </Callout>
            <h4>What changed since the agent read it</h4>
            <DiffView
              from={base}
              to={current}
              label={`${p.name}: what changed since the agent read it`}
            />
            <h4>What the agent proposes</h4>
            <DiffView from={base} to={p.content} label={`${p.name}: what the agent proposes`} />
          </div>
        ) : (
          <DiffView from={current} to={p.content} label={`${p.name}: the proposed change`} />
        )}

        {mode === 'edit' ? (
          <div className="afpedit">
            <div className="src">
              Edit the agent’s text, then save to approve it as {target}. The agent’s version stays
              in the proposal’s history.
            </div>
            <NoteField id={noteId} value={note} onChange={setNote} />
            <InlineEditor
              field="the proposed text"
              multiline
              initial={p.content}
              maxLength={
                p.file_key === 'workflow'
                  ? AGENT_SETUP_LIMITS.workflow_md
                  : AGENT_SETUP_LIMITS.agent_file_content
              }
              onSave={(text) => decide('approve', text)}
              onCancel={() => setMode('view')}
            />
          </div>
        ) : mode === 'decline' ? (
          <div className="afpdecline" role="group" aria-label={`Decline the change to ${p.name}`}>
            <NoteField id={noteId} value={note} onChange={setNote} hint="Why (optional)" />
            <div className="row wrap" style={{ gap: 6 }}>
              <Button variant="danger" disabled={busy} onClick={() => void decide('decline')}>
                Decline proposal
              </Button>
              <Button variant="ghost" onClick={() => setMode('view')}>
                Cancel
              </Button>
            </div>
          </div>
        ) : mode === 'confirm' ? (
          <div className="afpconfirm" role="group" aria-label="Confirm approval">
            <div>
              Approve anyway? The changes made to {p.name} since the agent read it are replaced.
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              <Button variant="primary" disabled={busy} onClick={() => void decide('approve')}>
                Approve anyway
              </Button>
              <Button onClick={() => setMode('edit')}>Edit, then approve</Button>
              <Button variant="ghost" onClick={() => setMode('view')}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="row wrap afpacts" style={{ gap: 6 }}>
            <Button
              variant="primary"
              icon="check"
              disabled={busy}
              onClick={() => (p.changed_since ? setMode('confirm') : void decide('approve'))}
            >
              Approve<span className="sr"> the change to {p.name}</span>
            </Button>
            <Button icon="pencil" onClick={() => setMode('edit')}>
              Edit, then approve<span className="sr"> ({p.name})</span>
            </Button>
            <Button variant="ghost" onClick={() => setMode('decline')}>
              Decline…<span className="sr"> ({p.name})</span>
            </Button>
          </div>
        )}
      </article>
    </Card>
  );
}

function NoteField({
  id,
  value,
  onChange,
  hint = 'Note (optional)',
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div className="afnote">
      <label htmlFor={id}>{hint}</label>
      <input
        id={id}
        className="input"
        value={value}
        maxLength={AGENT_SETUP_LIMITS.note}
        placeholder="Shown with the decision"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Needs you: "n agent file changes proposed" → Agent files (UI_SPEC §6.7b-1). */
export function ProposalsLine({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <Link
      className="pulselink"
      to={`${paths.agentFiles()}#proposals`}
      data-state="agent-file-proposals"
    >
      <Icon name="bot" small />
      {count === 1 ? '1 agent file change proposed' : `${count} agent file changes proposed`}
    </Link>
  );
}
