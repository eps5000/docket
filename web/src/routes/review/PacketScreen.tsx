import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { ReviewResponse } from '@docket/shared';
import {
  Button,
  Callout,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Provenance,
  SegmentedControl,
  Skeleton,
  type ProvenanceKind,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useBootstrap } from '../../app/useBootstrap';
import { useBreadcrumb } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { formatStamp, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { DocumentViewer } from '../dialogs/DocumentViewer';
import { LinkText } from '../shared/LinkText';
import {
  EMPTY_DRAFT,
  agentOf,
  decidedMessage,
  missingNote,
  outcomeCallout,
  submitLabel,
  tally,
  verdictsOf,
  type Draft,
  type Drafts,
  type VerdictKind,
} from './decision';
import '../screens.css';
import { HelpLink } from '../../help/HelpLink';

type Packet = ReviewResponse['packet'];
type PacketItem = Packet['items'][number];

/**
 * The human review packet (`/review/:id?round=`, UI_SPEC §6.4): three
 * columns `230px | 1fr | 300px` (queue · packet · decision), and at ≤ 1180px
 * the decision panel moves under the queue. Not in the sidebar; Needs you
 * stays the active nav item.
 */
export function PacketScreen() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const roundParam = Number(params.get('round'));
  const round = Number.isInteger(roundParam) && roundParam > 0 ? roundParam : undefined;
  const query = useQuery({
    queryKey: queryKeys.review(id, round),
    queryFn: () => apiClient['review.get']({ params: { id }, query: { round } }),
  });
  useBreadcrumb({
    crumbs: [
      { kind: 'link', text: 'Overview', to: paths.overview() },
      { kind: 'current', text: `Human review · ${id}` },
    ],
  });
  const data = query.data;
  // Verdicts in progress belong to one packet; another packet starts empty.
  const [drafts, setDrafts] = useState<{ packet: string; drafts: Drafts }>({
    packet: '',
    drafts: {},
  });
  const packetId = data?.packet.packet_id ?? '';
  const current = drafts.packet === packetId ? drafts.drafts : {};
  const setDraft = (hr: string, patch: Partial<Draft>) =>
    setDrafts({
      packet: packetId,
      drafts: { ...current, [hr]: { ...(current[hr] ?? EMPTY_DRAFT), ...patch } },
    });
  const live = !!data && data.packet.state === 'open';
  // The item whose "Needs changes" note is missing (the decision is refused without one).
  const [noteError, setNoteError] = useState<string | null>(null);
  useEffect(() => {
    if (noteError) document.getElementById(`note-${noteError}`)?.focus();
  }, [noteError]);
  return (
    <div className="review">
      <div className="withhelp wh-h1">
        <h1>Human review</h1>
        <HelpLink anchor="review.packet" />
      </div>
      <div className="rv" data-layout="packet">
        <PacketQueue data={data} id={id} loading={query.isPending} />
        <Card className="packet" data-column="packet">
          {query.isError ? (
            <div className="pad">
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            </div>
          ) : !data ? (
            <div className="pad">
              <Skeleton lines={6} label="Loading the packet" />
            </div>
          ) : (
            <PacketBody
              data={data}
              live={live}
              drafts={current}
              noteError={noteError}
              setDraft={(hr, patch) => {
                if (hr === noteError && patch.note?.trim()) setNoteError(null);
                setDraft(hr, patch);
              }}
            />
          )}
        </Card>
        <DecisionPanel data={data} live={live} drafts={current} onMissingNote={setNoteError} />
      </div>
    </div>
  );
}

/** Left: "Ready for you · N" packet buttons, and a "Viewing" group for a decided packet. */
function PacketQueue({
  data,
  id,
  loading,
}: {
  data?: ReviewResponse;
  id: string;
  loading: boolean;
}) {
  const queue = data?.queue ?? [];
  const viewing = data && !queue.some((q) => q.item_id === id);
  return (
    <Card className="rvq" data-column="queue">
      <CardHeader title={`Ready for you · ${queue.length}`} />
      {loading ? (
        <div className="pad">
          <Skeleton lines={2} label="Loading the queue" />
        </div>
      ) : (
        <>
          {queue.length === 0 && <EmptyState text="Nothing else is waiting on you." />}
          {queue.map((q) => (
            <Link
              key={q.item_id}
              className="rvqitem"
              to={paths.review(q.item_id)}
              aria-current={q.item_id === id ? 'page' : undefined}
            >
              <span className="row">
                <span className="mono">{q.item_id}</span>
                <Chip kind="warn">Round {q.round}</Chip>
              </span>
              <span style={{ fontWeight: 600 }}>{q.title}</span>
              <span className="src">
                about {q.estimate}
                {q.stale && (
                  <>
                    {' · '}
                    <b className="bad-text">out of date</b>
                  </>
                )}
              </span>
            </Link>
          ))}
          {viewing && data && (
            <>
              <div className="sectionhead">
                <h3>Viewing</h3>
              </div>
              <Link className="rvqitem" to={paths.review(data.item.id)} aria-current="page">
                <span className="row">
                  <span className="mono">{data.item.id}</span>
                  <ViewingChip data={data} />
                </span>
                <span style={{ fontWeight: 600 }}>{data.item.title}</span>
              </Link>
            </>
          )}
        </>
      )}
    </Card>
  );
}

function ViewingChip({ data }: { data: ReviewResponse }) {
  const latest = data.rounds.at(-1);
  if (data.item.status === 'done') return <Chip kind="ok">Closed</Chip>;
  if (latest?.outcome === 'sent_back') return <Chip kind="neutral">Sent back</Chip>;
  if (latest?.state === 'withdrawn') return <Chip kind="neutral">Fresh packet asked</Chip>;
  return <Chip kind="neutral">{data.item.status === 'review' ? 'In review' : 'In progress'}</Chip>;
}

const ROUND_CHIP = {
  sent_back: { kind: 'warn', text: 'sent back' },
  approved: { kind: 'ok', text: 'approved' },
  closed_with_deferred: { kind: 'info', text: 'closed, deferred' },
} as const;

/** Middle: header, round buttons, then What you're verifying · How to verify · Already checked · Known gaps · Attachments. */
function PacketBody({
  data,
  live,
  drafts,
  noteError,
  setDraft,
}: {
  data: ReviewResponse;
  live: boolean;
  drafts: Drafts;
  noteError: string | null;
  setDraft: (hr: string, patch: Partial<Draft>) => void;
}) {
  const p = data.packet;
  const latest = data.rounds.at(-1)?.round ?? p.round;
  const [viewer, setViewer] = useState<Packet['attachments'][number] | null>(null);
  const boot = useBootstrap();
  const scope: KeepScope = {
    item: data.item.id,
    epic: data.item.epic,
    project:
      boot.data?.projects.find((x) => x.key === data.item.project)?.short_name ?? data.item.project,
  };
  return (
    <>
      <div className="vers">
        <b style={{ marginRight: 4 }}>
          <Link to={paths.item(data.item.id)} className="mono">
            {data.item.id}
          </Link>{' '}
          {data.item.title}
        </b>
        <span className="rounds" role="group" aria-label="Rounds">
          {data.rounds.map((r) => {
            const chip = r.outcome ? ROUND_CHIP[r.outcome] : null;
            const isCurrent = r.round === p.round;
            return (
              <Link
                key={r.round}
                className="vbtn"
                to={paths.review(data.item.id, r.round === latest ? undefined : r.round)}
                aria-current={isCurrent ? 'true' : undefined}
                data-round={r.round}
              >
                Round {r.round}
                {chip && <Chip kind={chip.kind}>{chip.text}</Chip>}
                {r.state === 'withdrawn' && <Chip kind="neutral">withdrawn</Chip>}
                {r.state === 'open' && (
                  <span className="dot needs" role="img" aria-label="ready for you" />
                )}
              </Link>
            );
          })}
        </span>
        <span className="src" style={{ marginLeft: 'auto' }}>
          {p.created_by} · <span title={isoTitle(p.created_at)}>{formatStamp(p.created_at)}</span> ·{' '}
          <span className="mono">{p.display_id}</span>
          {p.built_from_commit && (
            <>
              {' '}
              · built from <span className="mono">{p.built_from_commit.slice(0, 7)}</span>
            </>
          )}{' '}
          · about {p.estimate}
        </span>
      </div>
      {p.round !== latest && (
        <Callout tone="warn" className="pkt-callout">
          Earlier round. Its decisions are shown below and don’t carry over.
        </Callout>
      )}
      {live && p.stale && <StaleCallout data={data} />}
      <div className="doc" data-round-kind={live ? 'live' : 'past'}>
        <section>
          <h2>What you’re verifying</h2>
          {p.items.map((it, n) =>
            live ? (
              <LiveItem
                key={it.hr_item_id}
                n={n}
                item={it}
                draft={drafts[it.hr_item_id] ?? EMPTY_DRAFT}
                noteMissing={noteError === it.hr_item_id}
                setDraft={(patch) => setDraft(it.hr_item_id, patch)}
                scope={scope}
              />
            ) : (
              <PastItem key={it.hr_item_id} n={n} item={it} itemId={data.item.id} />
            ),
          )}
        </section>
        {p.how.length > 0 && (
          <section>
            <h2>How to verify</h2>
            <ol className="howlist">
              {p.how.map((h, i) => (
                <li key={i}>
                  <LinkText text={h} />
                </li>
              ))}
            </ol>
          </section>
        )}
        {p.checked.length > 0 && (
          <section>
            <h2>Already checked by the agent</h2>
            {p.checked.map((c, i) => (
              <div className="checkrow" key={i}>
                <Provenance kind={c.provenance as ProvenanceKind} />
                <span className="ctext">
                  <LinkText text={c.text} />
                </span>
                {c.evidence && (
                  <span className="src">
                    <LinkText text={c.evidence} />
                  </span>
                )}
              </div>
            ))}
          </section>
        )}
        {p.gaps.length > 0 && (
          <section>
            <h2>Known gaps</h2>
            <ul className="gaplist">
              {p.gaps.map((g, i) => (
                <li key={i}>
                  <LinkText text={g} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {p.attachments.length > 0 && (
          <section>
            <h2>Attachments</h2>
            <div className="attachments">
              {p.attachments.map((a) => (
                <button
                  type="button"
                  className="attach"
                  key={a.document_version_id}
                  onClick={() => setViewer(a)}
                >
                  <Icon name="clip" small />
                  <b>{a.name}</b>
                  {a.caption && <span className="src">{a.caption}</span>}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
      {viewer && (
        <DocumentViewer
          doc={{
            versionId: viewer.document_version_id,
            name: viewer.name,
            by: p.created_by,
            at: p.created_at,
            caption: viewer.caption,
          }}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}

/** Out of date (UI_SPEC §6.4): a red callout with *Ask for a fresh packet*. */
function StaleCallout({ data }: { data: ReviewResponse }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const agent = agentOf(data.packet.created_by);
  const ask = async () => {
    setBusy(true);
    try {
      await runOwnerMutation(
        () =>
          apiClient['review.refresh']({
            params: { id: data.item.id },
            body: { packet_id: data.packet.packet_id },
          }),
        {
          success: `Asked ${agent} for a fresh packet. ${data.item.id} is back in progress until it arrives.`,
          actor: agent,
        },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t ask for a fresh packet. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Callout tone="bad" className="pkt-callout">
      <div className="row wrap">
        <span className="grow">
          {data.packet.criteria_changed ? (
            <>
              <b>Out of date.</b> This ticket was split after the packet was built, so its
              acceptance criteria changed. What you verify may not match what’s still on this
              ticket.
            </>
          ) : (
            <>
              <b>Out of date.</b> This packet was built from{' '}
              <span className="mono">{data.packet.built_from_commit.slice(0, 7)}</span>, but {agent}{' '}
              reported a newer commit for this {data.item.type === 'Epic' ? 'epic' : 'ticket'}. What
              you verify may not match the code.
            </>
          )}
        </span>
        <Button size="sm" onClick={() => void ask()} disabled={busy}>
          Ask for a fresh packet
        </Button>
      </div>
    </Callout>
  );
}

const VERDICTS: { kind: VerdictKind; label: string; icon: 'check' | 'x' | 'pause'; cls: string }[] =
  [
    { kind: 'approve', label: 'Looks good', icon: 'check', cls: 'ap' },
    { kind: 'changes', label: 'Needs changes', icon: 'x', cls: 'ch' },
    { kind: 'defer', label: 'Defer', icon: 'pause', cls: 'df' },
  ];

/** A radio group of three verdicts: arrow keys move and select (ARIA radio pattern). */
function VerdictGroup({
  n,
  value,
  onChange,
}: {
  n: number;
  value?: VerdictKind;
  onChange: (kind: VerdictKind) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = VERDICTS.findIndex((v) => v.kind === value);
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (i + step + VERDICTS.length) % VERDICTS.length;
    onChange(VERDICTS[next]!.kind);
    refs.current[next]?.focus();
  };
  return (
    <div className="verdict" role="radiogroup" aria-label={`Decision for item ${n + 1}`}>
      {VERDICTS.map((v, i) => (
        <button
          key={v.kind}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === v.kind}
          tabIndex={index < 0 ? (i === 0 ? 0 : -1) : i === index ? 0 : -1}
          className={`btn sm ${v.cls}`}
          onClick={() => onChange(v.kind)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <Icon name={v.icon} /> {v.label}
        </button>
      ))}
    </div>
  );
}

/** What *Keep it for* can offer: the ticket, its epic (when it has one) and the project, by name. */
export interface KeepScope {
  item: string;
  epic: string | null;
  project: string;
}

/** What each *Keep it for* choice does, under the control (owner decision 35). */
function keepHint(keep: Draft['keep'], scope: KeepScope): string {
  if (keep === 'epic' && scope.epic) {
    return `Also saved as an owner decision on ${scope.epic}: agents get it on the epic’s other tickets.`;
  }
  if (keep === 'project') {
    return `Also saved as an owner decision for ${scope.project}: every agent working on it gets it.`;
  }
  return `Posted as a note for the agent on ${scope.item}.`;
}

export function LiveItem({
  n,
  item,
  draft,
  noteMissing,
  setDraft,
  scope,
}: {
  n: number;
  item: PacketItem;
  draft: Draft;
  noteMissing: boolean;
  setDraft: (patch: Partial<Draft>) => void;
  scope: KeepScope;
}) {
  const noteId = `note-${item.hr_item_id}`;
  const errId = `${noteId}-err`;
  const noEpicId = `${noteId}-noepic`;
  // Without an epic, *The epic's future tickets* is disabled; a kept choice falls back.
  const keep = draft.keep === 'epic' && !scope.epic ? 'item' : draft.keep;
  return (
    <div className="hritem" data-hr={item.hr_item_id}>
      <div style={{ fontWeight: 600 }}>
        {n + 1}. <LinkText text={item.text} />
      </div>
      <VerdictGroup n={n} value={draft.kind} onChange={(kind) => setDraft({ kind })} />
      {draft.kind === 'approve' && (
        <div className="verdict-more" data-approve-note="">
          <label className="f" htmlFor={noteId}>
            Notes for later (optional)
          </label>
          <textarea
            id={noteId}
            className="input"
            value={draft.note}
            placeholder="e.g. Fine here, but next time put the fixture in tests/fixtures/"
            onChange={(e) => setDraft({ note: e.target.value })}
          />
          {draft.note.trim() && (
            <>
              <div className="row wrap" style={{ marginTop: 6 }}>
                <span className="src">Keep it for</span>
                <SegmentedControl
                  label={`Keep the note on item ${n + 1} for`}
                  value={keep}
                  onChange={(k) => setDraft({ keep: k })}
                  options={[
                    { key: 'item', label: 'This ticket' },
                    {
                      key: 'epic',
                      label: 'The epic’s future tickets',
                      disabled: !scope.epic,
                      describedBy: scope.epic ? undefined : noEpicId,
                    },
                    { key: 'project', label: `All ${scope.project} work` },
                  ]}
                />
              </div>
              {!scope.epic && (
                <div id={noEpicId} className="src" style={{ marginTop: 4 }}>
                  {scope.item} has no epic, so the note can’t go to an epic’s tickets.
                </div>
              )}
              <div className="src" style={{ marginTop: 4 }} data-keep-hint={keep}>
                {keepHint(keep, scope)}
              </div>
            </>
          )}
        </div>
      )}
      {draft.kind === 'changes' && (
        <div className="verdict-more">
          <label className="f" htmlFor={noteId}>
            What needs to change <b className="bad-text">(required)</b>
          </label>
          <textarea
            id={noteId}
            className="input"
            value={draft.note}
            placeholder="What you saw, and what you expected"
            aria-describedby={noteMissing ? errId : undefined}
            aria-invalid={noteMissing || undefined}
            onChange={(e) => setDraft({ note: e.target.value })}
          />
          {noteMissing && (
            <div id={errId} className="field-err" role="alert">
              Say what needs to change so the agent can fix it.
            </div>
          )}
          <div className="row wrap" style={{ marginTop: 6 }}>
            <span className="src">Send it back as</span>
            <SegmentedControl
              label={`Turn finding ${n + 1} into`}
              value={draft.into}
              onChange={(into) => setDraft({ into })}
              options={[
                { key: 'checklist', label: 'Checklist item on this ticket' },
                { key: 'bug', label: 'New bug ticket' },
              ]}
            />
          </div>
        </div>
      )}
      {draft.kind === 'defer' && (
        <div className="verdict-more">
          <label className="f" htmlFor={noteId}>
            Why defer, and what’s still needed (optional)
          </label>
          <textarea
            id={noteId}
            className="input"
            value={draft.note}
            placeholder="e.g. Needs a real Android device; test with the next mobile pass"
            onChange={(e) => setDraft({ note: e.target.value })}
          />
          <div className="row wrap" style={{ marginTop: 6 }}>
            <span className="src">Follow-up</span>
            <SegmentedControl
              label={`Follow-up for deferred item ${n + 1}`}
              value={draft.follow}
              onChange={(follow) => setDraft({ follow })}
              options={[
                { key: 'ticket', label: 'Create a test ticket in Inbox' },
                { key: 'none', label: 'No ticket: agent follows the project workflow' },
              ]}
            />
          </div>
          <div className="src" style={{ marginTop: 4 }}>
            Deferring clears the gate so work can continue. The item is recorded as{' '}
            <b>not verified</b>, never as approved.
          </div>
        </div>
      )}
    </div>
  );
}

const PAST: Record<VerdictKind, { kind: ProvenanceKind; label: string }> = {
  approve: { kind: 'owner_approve', label: 'Looked good' },
  changes: { kind: 'owner_changes', label: 'Needed changes' },
  defer: { kind: 'owner_defer', label: 'Deferred · not verified' },
};

/** A decided (or withdrawn) round: each item's decision in its own style (FR-054). */
export function PastItem({ n, item, itemId }: { n: number; item: PacketItem; itemId: string }) {
  const d = item.decision;
  const ref =
    d?.result_ref ?? (d?.kind === 'defer' ? '→ agent follows the project workflow' : null);
  const refId = ref ? /([A-Z]{2,5}-\d+)$/.exec(ref)?.[1] : undefined;
  return (
    <div className="hritem" data-hr={item.hr_item_id} data-decision={d?.kind ?? 'none'}>
      <div style={{ fontWeight: 600 }}>
        {n + 1}. <LinkText text={item.text} />
      </div>
      {d ? (
        <div className="row wrap" style={{ marginTop: 6 }}>
          <Provenance kind={PAST[d.kind].kind} label={PAST[d.kind].label} />
          {d.note && (
            <span data-note="">
              {d.kind === 'approve' && <span className="src">Note for later: </span>}“{d.note}”
            </span>
          )}
          {ref && (
            <span className="src">
              {d.decision_id ? (
                // A kept note's decision (owner decision 35): the ticket's Decisions list it,
                // or (decision 38) the project Decisions page, for a note kept for the project.
                <Link
                  to={
                    d.keep === 'project'
                      ? paths.projectDecisions(itemId.split('-')[0]!, { decision: d.decision_id })
                      : paths.item(itemId, 'details')
                  }
                  data-decision-link={d.decision_id}
                >
                  {ref}
                </Link>
              ) : refId ? (
                <>
                  {ref.slice(0, ref.length - refId.length)}
                  <Link to={paths.item(refId)} className="mono">
                    {refId}
                  </Link>
                </>
              ) : (
                ref
              )}
            </span>
          )}
        </div>
      ) : (
        <div className="src" style={{ marginTop: 6 }}>
          Not decided in this round.
        </div>
      )}
    </div>
  );
}

/** Right: "Your decision · round n", the outcome-named primary button and the callout. */
function DecisionPanel({
  data,
  live,
  drafts,
  onMissingNote,
}: {
  data?: ReviewResponse;
  live: boolean;
  drafts: Drafts;
  onMissingNote: (hr: string | null) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // A server error belongs to the packet it was about.
  const [failure, setFailure] = useState<{ packet: string; text: string } | null>(null);
  const error = failure && failure.packet === data?.packet.packet_id ? failure.text : null;
  const setError = (text: string | null) =>
    setFailure(text && data ? { packet: data.packet.packet_id, text } : null);
  const items = data?.packet.items ?? [];
  const t = tally(items, drafts);
  if (data && !live) {
    const decidedAt = data.packet.items.map((i) => i.decision?.decided_at).find(Boolean);
    return (
      <div className="stack" data-column="decision">
        <Card padded>
          <h3>Round {data.packet.round}</h3>
          <div className="src">
            {data.packet.state === 'withdrawn'
              ? 'Withdrawn: you asked for a fresh packet.'
              : decidedAt
                ? `Decided ${formatStamp(decidedAt)}`
                : 'Not decided'}
          </div>
        </Card>
      </div>
    );
  }
  const agent = data ? agentOf(data.packet.created_by) : 'the agent';
  const callout = data ? outcomeCallout(t, data) : null;
  const submit = async () => {
    if (!data || !t.complete) return;
    const missing = missingNote(items, drafts);
    onMissingNote(missing);
    if (missing) {
      document.getElementById(`note-${missing}`)?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await runOwnerMutation(
        () =>
          apiClient['review.decide']({
            params: { id: data.item.id },
            body: { round: data.packet.round, verdicts: verdictsOf(items, drafts) },
          }),
        { success: (r) => decidedMessage(r, data.item.id, t, agent), actor: agent },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.all });
      if (res) {
        // The queue advances to the next packet.
        const next = data.queue.find((q) => q.item_id !== data.item.id);
        if (next) void navigate(paths.review(next.item_id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t record your decision. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" data-column="decision">
      <Card padded>
        <h3>Your decision{data ? ` · round ${data.packet.round}` : ''}</h3>
        <div className="src" aria-live="polite">
          {t.decided} of {t.total} items decided
        </div>
        <Button
          variant="primary"
          className="wide"
          style={{ marginTop: 10 }}
          disabled={!t.complete || busy}
          onClick={() => void submit()}
          data-action="submit-decision"
        >
          {submitLabel(t, agent)}
        </Button>
        {callout && (
          <Callout tone="info" className="decide-callout">
            {callout}
          </Callout>
        )}
        {error && (
          <Callout tone="bad" role="alert" className="decide-callout">
            {error}
          </Callout>
        )}
      </Card>
    </div>
  );
}
