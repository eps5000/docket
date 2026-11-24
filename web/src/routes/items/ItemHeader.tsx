import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  PRIORITIES,
  STATUS_LABELS,
  waitingOnBugsText,
  type ItemDetailResponse,
  type Priority,
} from '@docket/shared';
import {
  BlockedChip,
  WaitChip,
  Button,
  Chip,
  EpicDepsLine,
  EpicReadinessLine,
  EpicReleaseLine,
  FinishedPartlyBlock,
  Label,
  Provenance,
  Skeleton,
  StatusChip,
  TypeBadge,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { CancelMenu } from './CancelItem';
import { FinishLineControl } from './FinishLineControl';
import { InlineTextEdit } from './InlineEdit';

/** Closed provenance on done items (UI_SPEC §6.3 header, second line). */
function ClosedProvenance({ item }: { item: ItemDetailResponse['item'] }) {
  if (item.status !== 'done' || !item.closed_by) return null;
  if (item.closed_by === 'owner') {
    const deferred = item.human_review.deferred;
    return deferred > 0 ? (
      <Provenance kind="owner_defer" label={`Closed · ${deferred} review deferred, not verified`} />
    ) : (
      <Provenance kind="owner_approve" label="Closed after your human review" />
    );
  }
  if (item.closed_by === 'agent')
    return <Provenance kind="agent" label="Closed by agent: checks passed, no human review" />;
  return null;
}

/**
 * The item header (UI_SPEC §6.3): ID, type, epic, labels, "Imported from
 * Jira"; the h1 (editable inline); status, blocked, closed provenance,
 * priority and the contextual actions with the "⋯" overflow. US2 fills the
 * read view; US7 (T126) wires the actions: the title edits inline, Priority,
 * *Move to Planning*, *Move to Ready*, *Archive* / *Unarchive*, and
 * *Cancel item…*. Each toasts with Undo.
 */
export function ItemHeader({ id, data }: { id: string; data?: ItemDetailResponse }) {
  const prioId = useId();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const item = data?.item;
  if (!item) {
    return (
      <div className="tk-head">
        <div className="grow">
          <div className="row wrap">
            <span className="mono muted">{id}</span>
          </div>
          <h1 className="sr">{id}</h1>
          <Skeleton lines={1} label="Loading the title" />
        </div>
      </div>
    );
  }
  const epic = item.type === 'Epic';
  const open = !['done', 'canceled'].includes(item.status);
  /** One owner action with the standard toasts (Undo, or the conflict toast); then refetch. */
  const act = async <T extends { mutation_id: string; warnings?: string[] }>(
    fn: () => Promise<T>,
    success: string,
  ) => {
    setBusy(true);
    try {
      const res = await runOwnerMutation(fn, { success, refetch: [queryKeys.item(item.id)] });
      if (res) await queryClient.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };
  // Decision 58: open known gaps move to Ready only with your approval, recorded as a decision.
  const gapsToApprove =
    !!item.known_gaps && item.known_gaps.open > 0 && item.known_gaps.approved === null;
  const move = (status: 'planning' | 'ready') =>
    act(
      () =>
        apiClient['items.patch']({
          params: { id: item.id },
          body: {
            expected_version: item.version,
            status,
            ...(status === 'ready' && gapsToApprove ? { approve_gaps: true as const } : {}),
          },
        }),
      status === 'ready' && gapsToApprove
        ? `Approved ${item.id}'s known gaps and moved it to Ready.`
        : `Moved ${item.id} to ${status === 'ready' ? 'Ready' : 'Planning'}.`,
    );
  const setPriority = (priority: Priority) =>
    act(
      () =>
        apiClient['items.patch']({
          params: { id: item.id },
          body: { expected_version: item.version, priority },
        }),
      `Priority set to P${priority}.`,
    );
  const archive = () =>
    act(
      () => apiClient['items.archive']({ params: { id: item.id } }),
      `${item.id} archived. It’s still in the tracker; find it with search or the Archived filter.`,
    );
  const unarchive = () =>
    act(
      () => apiClient['items.unarchive']({ params: { id: item.id } }),
      `${item.id} is back in your views.`,
    );
  return (
    <div className="tk-head" data-section="header">
      <div className="grow">
        <div className="row wrap">
          <span className="mono muted">{item.id}</span>
          <TypeBadge type={item.type} />
          {item.epic && item.epic_title && (
            <>
              <span className="muted">in</span>
              <Link className="epiclink" to={paths.item(item.epic)}>
                <span className="ed" aria-hidden="true">
                  ◆
                </span>{' '}
                {item.epic_title}
              </Link>
              <span className="mono muted">{item.epic}</span>
            </>
          )}
          {item.labels.map((l) => (
            <Label key={l} project={item.project} name={l} />
          ))}
          {item.jira_key && <Chip kind="neutral">Imported from Jira</Chip>}
          {item.split_from && (
            <span className="src split-prov" data-split-from={item.split_from}>
              Split from <Link to={paths.item(item.split_from)}>{item.split_from}</Link>
            </span>
          )}
          {item.split_into && item.split_into.length > 0 && (
            <span className="src split-prov" data-split-into={item.split_into.join(' ')}>
              Split into{' '}
              {item.split_into.map((id, i) => (
                <span key={id}>
                  {i > 0 && ', '}
                  <Link to={paths.item(id)}>{id}</Link>
                </span>
              ))}
            </span>
          )}
        </div>
        <div style={{ marginTop: 4 }}>
          <InlineTextEdit item={item} field="title" name="title" value={item.title} pencil>
            <h1 className={item.status === 'canceled' ? 'struck' : undefined}>{item.title}</h1>
          </InlineTextEdit>
        </div>
        <div className="row wrap" style={{ marginTop: 6 }}>
          <StatusChip status={item.status} />
          <BlockedChips item={item} wait={data?.item_wait} />
          <ClosedProvenance item={item} />
          {epic && data && (
            <span className="src">
              {item.project} · {data.children.length} items ·{' '}
              {data.children.filter((c) => c.status === 'done').length} done
            </span>
          )}
          <span className="row" style={{ gap: 4 }}>
            <label className="src" htmlFor={prioId}>
              Priority
            </label>
            <select
              id={prioId}
              value={item.priority}
              disabled={busy || !open}
              onChange={(e) => void setPriority(Number(e.target.value) as Priority)}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  P{p}
                </option>
              ))}
            </select>
          </span>
          {item.status === 'inbox' && (
            <Button size="sm" disabled={busy} onClick={() => void move('planning')}>
              Move to Planning
            </Button>
          )}
          {item.status === 'planning' && (
            <>
              <Button
                size="sm"
                variant="primary"
                icon="promote"
                disabled={busy}
                onClick={() => void move('ready')}
              >
                {gapsToApprove ? 'Approve gaps and move to Ready' : 'Move to Ready'}
              </Button>
              <span className="src">
                {epic
                  ? 'This epic is still a brief.'
                  : 'Planning is yours. Move it when you’re satisfied, or ask an agent to.'}
              </span>
            </>
          )}
          {item.status === 'done' &&
            (item.archived ? (
              <>
                <Chip kind="neutral">Archived</Chip>
                <Button size="sm" disabled={busy} onClick={() => void unarchive()}>
                  Unarchive
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void archive()}
                title="Hide it from your views. It stays in the tracker and in search."
              >
                Archive
              </Button>
            ))}
          {open && data && <CancelMenu data={data} />}
        </div>
        {epic && data?.epic_waits && <EpicDepsLine waits={data.epic_waits} />}
        {epic && data?.epic_readiness && <EpicReadinessLine readiness={data.epic_readiness} />}
        {/* Decision 64: the finish line and the open bugs holding it, or "No finish line". */}
        {epic && data?.finish_line && <EpicReleaseLine line={data.finish_line} />}
        {epic && data?.finish_line && <FinishLineControl data={data} />}
        {data?.release_hold && <ReleaseHoldLine hold={data.release_hold} />}
        {item.type === 'Bug' && open && item.epic && (
          <div className="src release-hold" data-bug-holds={item.epic}>
            <span aria-hidden="true">⚑</span> While it’s open, this bug holds{' '}
            <Link className="mono" to={paths.item(item.epic)}>
              {item.epic}
            </Link>
            ’s release: fix it, move it to another epic as a follow-up, or cancel it with a reason.
          </div>
        )}
        {/* Decision 61: how the lead finished, when it left items. */}
        <FinishedPartlyBlock runs={item.runs} />
      </div>
    </div>
  );
}

/** Decision 64: on an epic's finish line, the open bugs in the epic that hold it. */
function ReleaseHoldLine({ hold }: { hold: NonNullable<ItemDetailResponse['release_hold']> }) {
  return (
    <div className="src release-hold" data-release-hold={hold.open_bugs.length}>
      <span aria-hidden="true">⚑</span> <b>{waitingOnBugsText(hold.open_bugs.length)}</b>: this is{' '}
      <Link className="mono" to={paths.item(hold.epic)}>
        {hold.epic}
      </Link>
      ’s finish line, so it can’t move to Review or Done while{' '}
      {hold.open_bugs.map((b, i) => (
        <span key={b.id}>
          {i > 0 && ', '}
          <Link className="mono" to={paths.item(b.id)} title={b.title}>
            {b.id}
          </Link>{' '}
          ({STATUS_LABELS[b.status]})
        </span>
      ))}{' '}
      {hold.open_bugs.length === 1 ? 'is' : 'are'} open. For each: fix it, move it to another epic
      as a follow-up, or cancel it with a reason.
    </div>
  );
}

/**
 * Decision 57: Queued, Blocked (with why, in plain words) or Held, then the
 * open blockers in neutral text, each done one with "(needs merge)" or "(needs
 * your verification)". Before the server classifies it: "⊘ Blocked by
 * RCP-12, …", and a chip of its own for each done blocker (UI_SPEC §5).
 */
function BlockedChips({
  item,
  wait,
}: {
  item: ItemDetailResponse['item'];
  wait?: ItemDetailResponse['item_wait'];
}) {
  if (!item.blocked) return null;
  if (wait) {
    const open = item.links.blocked_by
      .filter((l) => l.cleared === false)
      .map((l) =>
        l.waiting_for === 'merge'
          ? `${l.id} (needs merge)`
          : l.waiting_for === 'verification'
            ? `${l.id} (needs your verification)`
            : l.id,
      );
    return (
      <>
        <WaitChip wait={wait} full />
        {open.length > 0 && (
          <span className="src" data-open-blockers="">
            Open blockers: {open.join(', ')}
          </span>
        )}
      </>
    );
  }
  const waiting = item.links.blocked_by.filter(
    (l) => l.cleared === false && (l.waiting_for === 'merge' || l.waiting_for === 'verification'),
  );
  const held = new Set(waiting.map((l) => l.id));
  const rest = item.blocked_by.filter((id) => !held.has(id));
  return (
    <>
      {rest.length > 0 && <BlockedChip blockers={rest} />}
      {waiting.map((l) => (
        <BlockedChip
          key={l.link_id}
          blockers={[l.id]}
          waitingFor={l.waiting_for as 'merge' | 'verification'}
        />
      ))}
    </>
  );
}
