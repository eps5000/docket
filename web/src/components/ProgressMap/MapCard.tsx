/**
 * A progress map card (UI_SPEC §6.3.4), also the node of the 1-hop
 * Dependencies view (§6.3.3): type icon · ID (+ "other epic ↗" or the
 * project) · title (2 lines) · "Status · run state", or "· after RCP-12" on
 * Planning items. Done cards are green with ✓; a blocked Ready card has a red
 * border and "blocked"; the person icon at the top right is filled when a
 * packet is ready for you and outlined when your review comes later. Each
 * card is a button that opens the item; its accessible name is its visible
 * text (type, ID, title, status), plus the review mark as sr-only text.
 */
import type { FocusEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { STATUS_LABELS } from '@docket/shared';
import { Icon, RunState, TypeIcon } from '../kit';
import { paths } from '../../lib/paths';
import type { MapItem } from './layout';

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
}: MapCardProps) {
  const navigate = useNavigate();
  const blockedReady = item.status === 'ready' && item.blocked;
  const after =
    item.status === 'planning' && item.blocked && item.blocked_by.length > 0
      ? item.blocked_by.join(', ')
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
        outside && 'ext',
        current && 'cur',
        traced === 'on' && 'hl',
        traced === 'dim' && 'dim',
        critical === 'off' && 'critoff',
        critical && critical !== 'off' && 'crit',
        critical && critical !== 'off' && critical.next && 'critnext',
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
        <TypeIcon type={item.type} /> <span className="mono muted">{item.id}</span>
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
            <span className="pm-blocked">· blocked</span>
          </>
        )}
        {after && !outside && (
          <>
            {' '}
            <span className="muted">· after {after}</span>
          </>
        )}
      </span>{' '}
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
