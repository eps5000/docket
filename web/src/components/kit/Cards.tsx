/**
 * TicketCard and EpicCard (UI_SPEC §4, §6.2.1).
 */
import { useId } from 'react';
import { Link } from 'react-router';
import {
  STATUS_LABELS,
  waitCountsText,
  type EpicCard as EpicCardData,
  type LeadParked,
  type WorkItem,
} from '@docket/shared';
import { formatAge, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { Button } from './Button';
import { BlockedChip, Chip, WaitChip } from './Chip';
import { Priority, RolloutMark, RunLine, TypeIcon, parkedReason } from './Badges';
import { Label } from './Label';
import { StatusBar } from './StatusBar';
import { EpicDepsNote } from './EpicDeps';
import { EpicReadinessNote } from './EpicReadiness';
import { EpicReleaseNote } from './EpicRelease';
import { FinishedPartlyNote } from './FinishedPartly';

/** `codex · orca-w1`. */
export function leadName(lead: { client: string; label: string | null }): string {
  return lead.label ? `${lead.client} · ${lead.label}` : lead.client;
}

/**
 * The reason on a lead's run line (UI_SPEC §5): a parked lead says what it
 * waits on, or "ready to resume" once that has cleared. Other states need none.
 */
export function leadReason(parked: LeadParked | null | undefined): string | undefined {
  if (!parked) return undefined;
  if (parked.resume_ready) return 'ready to resume';
  // Decision 42: newer activity says the park may be out of date.
  if (parked.activity) return 'activity since parked';
  return parkedReason(parked.waiting_on);
}

/** "For you" on a list row: a packet is ready or a question is open (UI_SPEC §5). */
export function ForYouChip() {
  return (
    <Chip kind="warn" icon="attention" title="A packet is ready or an agent asked you something">
      For you
    </Chip>
  );
}

/** The human review chip on a card (UI_SPEC §5): packet ready, later, or deferred. */
export function ReviewChip({
  item,
}: {
  item: Pick<WorkItem, 'packet_ready' | 'human_review' | 'status'>;
}) {
  if (item.packet_ready)
    return (
      <Chip kind="warn" icon="packet">
        Packet ready
      </Chip>
    );
  const open = item.status !== 'done' && item.status !== 'canceled';
  if (open && item.human_review.declared > 0)
    return (
      <Chip
        kind="neutral"
        icon="person"
        title="You'll get a handoff packet when this reaches Review"
      >
        Human review later
      </Chip>
    );
  if (!open && item.human_review.deferred > 0)
    return (
      <Chip kind="info" icon="pause">
        Review deferred
      </Chip>
    );
  return null;
}

/**
 * A board card. Variants follow the item: Blocked (red left edge; decision
 * 57: only when the wait needs attention), for you (amber left edge), Queued
 * (calm dashed edge), done (+ *Archive*, outside the card link). Unclaimed
 * cards show no run line. Review cards with a ready packet open the packet.
 */
export function TicketCard({
  item,
  now,
  onArchive,
  onUnarchive,
}: {
  item: WorkItem;
  now?: Date;
  onArchive?: () => void;
  onUnarchive?: () => void;
}) {
  const toPacket = item.status === 'review' && item.packet_ready;
  const kind = item.wait?.kind ?? (item.blocked ? 'blocked' : null);
  const edge =
    kind === 'blocked' ? 'isblocked' : item.for_you ? 'owed' : kind === 'queued' ? 'isqueued' : '';
  const card = (
    <Link
      to={toPacket ? paths.review(item.id) : paths.item(item.id)}
      className={['tcard', edge, item.archived && 'archived'].filter(Boolean).join(' ')}
      title={toPacket ? 'Open the handoff packet' : item.title}
      data-item={item.id}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="row">
          <span className="mono muted">{item.id}</span>
          <TypeIcon
            type={item.type}
            inferred={item.type_inferred === true}
            original={item.type_original}
          />
          {item.rollout && <RolloutMark />}
        </span>
        <Priority p={item.priority} />
      </div>
      <div className="t">{item.title}</div>
      {(item.epic || item.labels.length > 0) && (
        <div className="meta">
          {item.epic && item.epic_title && (
            <span className="ptag" title={item.epic_title}>
              <span style={{ color: 'var(--t-epic)' }} aria-hidden="true">
                ◆
              </span>{' '}
              {item.epic_title}
            </span>
          )}
          {item.labels.map((l) => (
            <Label key={l} project={item.project} name={l} asLink={false} />
          ))}
        </div>
      )}
      {(item.blocked ||
        item.packet_ready ||
        item.human_review.declared > 0 ||
        item.shared_flags) && (
        <div className="meta">
          {item.wait ? <WaitChip wait={item.wait} /> : <BlockedChip blockers={item.blocked_by} />}
          <ReviewChip item={item} />
          <SharedFlags flags={item.shared_flags} />
        </div>
      )}
      {/* Decision 48: a blocked card's chip already names its blockers. */}
      {!item.blocked && item.ready_state?.waiting_on && (
        <div className="meta src" data-card-waiting="">
          Waits on {item.ready_state.waiting_on}
        </div>
      )}
      {/* Decision 61: a partial exit leads, ahead of the run line. */}
      {item.finished_partly && <FinishedPartlyNote partly={item.finished_partly} />}
      {item.lead && (
        <RunLine
          state={item.lead.run_state}
          reason={leadReason(item.lead_parked)}
          agent={leadName(item.lead)}
          age={formatAge(item.last_activity_at, now)}
          ageTitle={`Last activity ${isoTitle(item.last_activity_at)}`}
        />
      )}
      {item.producer && (
        <div className="meta src" data-card-producer={item.producer.name}>
          {item.producer.between_workers
            ? `Between workers · ${item.producer.name}`
            : `Producer ${item.producer.name}`}
        </div>
      )}
    </Link>
  );
  if (item.status !== 'done') return card;
  return (
    <div className="tcw">
      {card}
      {item.archived
        ? onUnarchive && (
            <Button size="sm" className="archbtn" onClick={onUnarchive}>
              Unarchive
            </Button>
          )
        : onArchive && (
            <Button
              size="sm"
              className="archbtn"
              onClick={onArchive}
              title="Hide it from your views. It stays in the tracker and in search."
            >
              Archive
            </Button>
          )}
    </div>
  );
}

/**
 * Decision 36 (UI_SPEC §6.3.6): "overlap" while an overlap question waits for
 * the owner, "conflict ahead" while the radar has an open finding.
 */
export function SharedFlags({ flags }: { flags: WorkItem['shared_flags'] }) {
  if (!flags) return null;
  return (
    <>
      {flags.overlap && (
        <Chip kind="warn" title="Another in-flight item changes the same shared part">
          overlap
        </Chip>
      )}
      {flags.conflict && (
        <Chip kind="bad" icon="git" title="The conflict radar sees a merge conflict ahead">
          conflict ahead
        </Chip>
      )}
    </>
  );
}

/** An epic with no tickets (B35): "No tickets yet · In progress", on its card and its page. */
export function epicEmptyText(status: EpicCardData['status']): string {
  return `No tickets yet · ${STATUS_LABELS[status]}`;
}

/**
 * 4px `--t-epic` left edge; title + ID; mini progress bar; "n/N done · Status · N for you".
 * With no tickets: no bar, and "No tickets yet · Status".
 */
export function EpicCard({
  epic,
  forYou = 0,
  current = false,
}: {
  epic: EpicCardData;
  forYou?: number;
  current?: boolean;
}) {
  const { total, done, by_status, queued = 0, blocked = 0 } = epic.children;
  const depsId = useId();
  return (
    <Link
      className={total === 0 ? 'epiccard empty' : 'epiccard'}
      to={paths.item(epic.id)}
      aria-current={current || undefined}
      aria-describedby={epic.waits_on?.length ? depsId : undefined}
    >
      <span className="row" style={{ gap: 6, minWidth: 0 }}>
        <TypeIcon type="Epic" />
        <span className="et" title={epic.title}>
          {epic.title}
        </span>
        <span className="mono muted" style={{ marginLeft: 'auto' }}>
          {epic.id}
        </span>
      </span>
      {/* An epic with no tickets has no bar (B35): "0/0 done" over an empty bar read as broken. */}
      {total > 0 && <StatusBar counts={by_status} label={`${done} of ${total} done`} mini />}
      <span className="src">
        {total === 0
          ? epicEmptyText(epic.status)
          : `${done}/${total} done · ${STATUS_LABELS[epic.status]}`}
        {/* Decision 57: what waits its turn, and what needs attention, in words. */}
        {queued + blocked > 0 && (
          <span data-epic-waits=""> · {waitCountsText({ queued, blocked })}</span>
        )}
        {forYou > 0 && (
          <>
            {' · '}
            <b style={{ color: 'var(--warn)' }}>{forYou} for you</b>
          </>
        )}
      </span>
      {epic.waits_on && <EpicDepsNote waits={epic.waits_on} namesId={depsId} />}
      {/* Decision 58: Not ready to start, or Started with N unshaped tickets. */}
      {epic.readiness && <EpicReadinessNote readiness={epic.readiness} />}
      {/* Decision 64: the open bugs holding its release. */}
      {epic.release && <EpicReleaseNote release={epic.release} />}
    </Link>
  );
}
