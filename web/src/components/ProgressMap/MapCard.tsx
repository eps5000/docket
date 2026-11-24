/**
 * A progress map card (UI_SPEC §6.3.4), also the node of the 1-hop
 * Dependencies view (§6.3.3): type icon · ID (+ "other epic ↗" or the
 * project) · title (2 lines) · "Status · run state", or "· after RCP-12" on
 * Planning items. Done cards are green with ✓, In progress cards have a hatched green edge
 * (decision 59); a Blocked Ready card has a red
 * border and "blocked", a Queued one a calm dashed border and "queued"
 * (decision 57); "added mid-flight" marks a ticket that joined its epic
 * after the epic started (decision 62); the person icon at the top right is filled when a
 * packet is ready for you and outlined when your review comes later. Each
 * card is a button that opens the item; its accessible name is its visible
 * text (type, ID, title, status), plus the review mark as sr-only text.
 * Decision 64: a bug in the chain says "bug" by its ID. Decision 67: the
 * epic's Release says "Release", how many tickets it finishes after, and
 * "Waiting on N bugs" while bugs in the epic are open; a rollout says
 * "rollout"; an inferred type has a dashed icon; a Planning ticket says what it
 * waits for in its blocker's words ("· starts after RCP-12’s design").
 */
import type { FocusEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { STATUS_LABELS, needsShapingText, ticketCount, waitingOnBugsText } from '@docket/shared';
import { Icon, RunState, TypeIcon } from '../kit';
import { paths } from '../../lib/paths';
import { waitKindOf, type MapItem } from './layout';

export interface MapCardProps {
  item: MapItem;
  /** A card from outside the scope: dashed, with "other epic ↗" or its project. */
  outside?: { label: string } | null;
  /** The item whose page this is (1-hop view). */
  current?: boolean;
  /** "done · waiting for merge" on a done blocker that still blocks (1-hop view). */
  waiting?: { label: string; title: string } | null;
  /** Hover tracing (the map). */
  traced?: 'on' | 'dim' | null;
  onTrace?: (id: string | null) => void;
  /** Its top on the routed map (routing.ts). */
  top?: number;
  /** Decision 48: its place on the critical path, or `off` when it isn't on it. */
  critical?: { step: number; total: number; next: boolean } | 'off' | null;
  /** Decision 64: a bug drawn in its wave because it's part of the chain. */
  bugMark?: boolean;
  /** Decision 67: this is the epic's Release; the tickets it waits for and open bugs hold it. */
  release?: { openBugs: number; left: number } | null;
}

/** Packet ready (filled) or human review later (outlined); none otherwise (UI_SPEC §5). */
export function reviewMark(item: MapItem): 'now' | 'later' | null {
  const open = item.status !== 'done' && item.status !== 'canceled';
  if (!open) return null;
  if (item.packet_ready ?? item.human_review.ready > 0) return 'now';
  if (item.human_review.declared > 0) return 'later';
  return null;
}

export function MapCard({
  item,
  outside,
  current,
  waiting,
  traced,
  onTrace,
  top,
  critical,
  bugMark,
  release,
}: MapCardProps) {
  const navigate = useNavigate();
  const kind = item.status === 'ready' ? waitKindOf(item) : null;
  const blockedReady = kind === 'blocked';
  const queuedReady = kind === 'queued';
  // Decision 67: in the blocker's words when the server classified the wait.
  const after =
    item.status === 'planning' && item.blocked && item.blocked_by.length > 0
      ? item.wait
        ? item.wait.text.charAt(0).toLowerCase() + item.wait.text.slice(1)
        : `after ${item.blocked_by.join(', ')}`
      : null;
  const mark = item.status === 'done' ? null : reviewMark(item);
  const trace = (on: boolean) => (e: MouseEvent | FocusEvent) => {
    e.stopPropagation();
    onTrace?.(on ? item.id : null);
  };
  return (
    <button
      type="button"
      className={[
        'pm-node',
        `ps-${item.status}`,
        blockedReady && 'blk',
        queuedReady && 'que',
        outside && 'ext',
        current && 'cur',
        traced === 'on' && 'hl',
        traced === 'dim' && 'dim',
        critical === 'off' && 'critoff',
        critical && critical !== 'off' && 'crit',
        critical && critical !== 'off' && critical.next && 'critnext',
        release && 'finish',
        release && release.openBugs > 0 && 'held',
      ]
        .filter(Boolean)
        .join(' ')}
      data-pid={item.id}
      style={top === undefined ? undefined : { top }}
      aria-current={current ? 'page' : undefined}
      title={item.title}
      onClick={() => navigate(paths.item(item.id))}
      onMouseEnter={trace(true)}
      onMouseLeave={trace(false)}
      onFocus={trace(true)}
      onBlur={trace(false)}
    >
      <span className="pm-top">
        <TypeIcon
          type={item.type}
          inferred={item.type_inferred === true}
          original={item.type_original}
        />{' '}
        <span className="mono muted">{item.id}</span>
        {item.rollout && (
          <>
            {' '}
            <span className="pm-rollout" data-rollout="">
              <span aria-hidden="true">⇪</span> rollout
            </span>
          </>
        )}
        {bugMark && (
          <>
            {' '}
            <span className="pm-bugmark" data-bug-mark="">
              bug
            </span>
          </>
        )}
        {outside && (
          <>
            {' '}
            <span className="src">{outside.label}</span>
          </>
        )}
      </span>{' '}
      <span className="pm-title">{item.title}</span>{' '}
      <span className="pm-status">
        <span>{STATUS_LABELS[item.status]}</span>
        {waiting ? (
          <>
            {' '}
            <span className="pm-wait" title={waiting.title}>
              · {waiting.label}
            </span>
          </>
        ) : null}
        {item.lead && item.lead.run_state !== 'finished' && (
          <>
            {' '}
            <RunState state={item.lead.run_state} />
          </>
        )}
        {mark === 'now' && (
          <>
            {' '}
            <span className="pm-ready">· packet ready</span>
          </>
        )}
        {blockedReady && !outside && (
          <>
            {' '}
            <span className="pm-blocked" title={item.wait?.text}>
              · blocked
            </span>
          </>
        )}
        {queuedReady && !outside && (
          <>
            {' '}
            <span className="pm-queued" title={item.wait?.text}>
              · queued
            </span>
          </>
        )}
        {after && !outside && (
          <>
            {' '}
            <span className="muted">· {after}</span>
          </>
        )}
        {item.added_midflight && !outside && (
          <>
            {' '}
            <span className="pm-added" title="Added after the epic started">
              · added mid-flight
            </span>
          </>
        )}
        {item.needs_shaping && !outside && (
          <>
            {' '}
            <span className="pm-shape" title={needsShapingText(item.needs_shaping)}>
              · needs shaping
            </span>
          </>
        )}
      </span>{' '}
      {release && (
        <span className="pm-finish" data-release-badge={release.openBugs}>
          Release
          {release.left > release.openBugs && (
            <>{` · finishes after ${ticketCount(release.left - release.openBugs)}`}</>
          )}
          {release.openBugs > 0 && (
            <>
              {' · '}
              <b className="pm-waitbugs">{waitingOnBugsText(release.openBugs)}</b>
            </>
          )}
        </span>
      )}{' '}
      {critical && critical !== 'off' && (
        <span className="pm-crit">
          {critical.next ? 'Move next · ' : ''}Step {critical.step} of {critical.total}
        </span>
      )}{' '}
      {item.status === 'done' ? (
        <span className="pm-done" aria-hidden="true">
          ✓
        </span>
      ) : mark ? (
        <span
          className={`pm-hr ${mark}`}
          title={mark === 'now' ? 'Handoff packet ready for you' : 'Needs your human review later'}
        >
          <Icon name="person" small />
          <span className="sr">
            {mark === 'now' ? 'Human review: packet ready for you' : 'Human review later'}
          </span>
        </span>
      ) : null}
    </button>
  );
}
