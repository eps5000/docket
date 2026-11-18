import { useId, useState } from 'react';
import type { DecisionRecord } from '@docket/shared';
import { formatDay, isoTitle } from '../../lib/format';
import { Button } from './Button';
import { Chip } from './Chip';
import { DecisionAuthorityBadge } from './Badges';

/**
 * One decision record (UI_SPEC §6.3.5). A shell: title, text (2 lines, then
 * *More*), *Why* collapsed, scope chip, authority badge (never solid, so it
 * can't look like review approval), author and date, and the actions.
 * The decisions slice (US5) wires the actions to the API.
 */
export function DecisionRow({
  record,
  canAct,
  scopeLabel,
  onConfirm,
  onWithdraw,
  onSupersede,
}: {
  record: DecisionRecord;
  /** False for read-only places (an inherited record shown on a ticket may still act; the caller decides). */
  canAct: boolean;
  /** "Project", "◆ Epic name", "#label", "This item" (ticket Details, where records are inherited). */
  scopeLabel?: string;
  onConfirm?: () => void;
  onWithdraw?: (reason: string) => void;
  onSupersede?: () => void;
}) {
  const [more, setMore] = useState(false);
  const [why, setWhy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const inactive = record.status !== 'active';
  return (
    <div className={`decrow${inactive ? ' inactive' : ''}`} data-decision={record.id}>
      <div className="row wrap">
        <span className="dt">{record.title}</span>
        {scopeLabel && <Chip kind="neutral">{scopeLabel}</Chip>}
        <DecisionAuthorityBadge
          authority={record.authority}
          agent={record.authority === 'agent' ? record.author : undefined}
        />
        {inactive && (
          <Chip kind="neutral">{record.status === 'superseded' ? 'Superseded' : 'Withdrawn'}</Chip>
        )}
        <span className="src" style={{ marginLeft: 'auto' }} title={isoTitle(record.created_at)}>
          {record.author} · {formatDay(record.created_at)}
        </span>
      </div>
      <div className={`dtext${more ? ' open' : ''}`}>{record.decision_md}</div>
      <div className="row wrap" style={{ gap: 4 }}>
        <Button variant="ghost" size="sm" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? 'Less' : 'More'}
        </Button>
        {record.rationale_md && (
          <Button variant="ghost" size="sm" aria-expanded={why} onClick={() => setWhy(!why)}>
            Why
          </Button>
        )}
        {canAct && !inactive && !withdrawing && (
          <span className="row" style={{ marginLeft: 'auto', gap: 4 }}>
            {record.authority === 'agent' && onConfirm && (
              <Button size="sm" onClick={onConfirm}>
                Confirm
              </Button>
            )}
            {onSupersede && (
              <Button size="sm" onClick={onSupersede}>
                Supersede
              </Button>
            )}
            {onWithdraw && (
              <Button size="sm" variant="danger-text" onClick={() => setWithdrawing(true)}>
                Withdraw…
              </Button>
            )}
          </span>
        )}
      </div>
      {why && record.rationale_md && <div className="src">{record.rationale_md}</div>}
      {withdrawing && (
        <div className="row wrap">
          <label className="sr" htmlFor={reasonId}>
            Reason for withdrawing (optional)
          </label>
          <input
            id={reasonId}
            className="input grow"
            placeholder="Optional reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
          <Button size="sm" onClick={() => setWithdrawing(false)}>
            Keep it
          </Button>
          <Button
            size="sm"
            variant="danger-text"
            onClick={() => {
              setWithdrawing(false);
              onWithdraw?.(reason.trim());
            }}
          >
            Withdraw
          </Button>
        </div>
      )}
    </div>
  );
}
