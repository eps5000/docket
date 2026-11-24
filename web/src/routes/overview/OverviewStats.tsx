import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  needsYouCount,
  type NeedsYouResponse,
  type OverviewResponse,
  type OverviewWindow,
} from '@docket/shared';
import { HelpLink } from '../../help/HelpLink';
import { plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { ownerActionParts, WINDOW_WORDS } from './overviewWindow';

/** "+6 vs the previous 7 days": the sign and the words carry it, never colour. */
export function deltaText(count: number, prior: number, window: OverviewWindow): string {
  const d = count - prior;
  const against = `the previous ${WINDOW_WORDS[window]}`;
  if (d === 0) return `Same as ${against}`;
  return `${d > 0 ? '+' : '−'}${Math.abs(d)} vs ${against}`;
}

function Stat({
  name,
  label,
  describedBy,
  extra,
  children,
}: {
  name: string;
  label: string;
  describedBy?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="card ov-stat"
      data-stat={name}
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
    >
      <div className="ov-k">
        {label}
        {extra}
      </div>
      {children}
    </div>
  );
}

const WAITING = '…';
const AGENTS_NOTE_ID = 'ov-agents-note';
/** B56: the card counts tickets. Never estimate sessions here; a later batch adds real ones. */
export const AGENTS_NOTE =
  'Counts tickets in Docket, not agent sessions. Orca can show more sessions, because coordinators and helpers don’t each hold a ticket.';

/** The four numbers. Each one is a link to the list behind it. */
export function OverviewStats({
  metrics,
  needs,
  window,
}: {
  metrics: OverviewResponse | undefined;
  needs: NeedsYouResponse | undefined;
  window: OverviewWindow;
}) {
  const parts = needs ? ownerActionParts(needs) : null;
  const count = needs ? needsYouCount(needs) : 0;
  // The sidebar's Agents badge is `working`, from this same response (decision 43).
  const agents = needs?.agents_now ?? { working: 0, waiting: 0 };
  const actionLines = parts
    ? (
        [
          [parts.reviews, 'review', 'reviews'],
          [parts.questions, 'question', 'questions'],
          [parts.decisions, 'decision', 'decisions'],
          [parts.problems, 'problem', 'problems'],
        ] as const
      ).filter(([n]) => n > 0)
    : [];
  return (
    <>
      <div className="ov-stats">
        <Stat name="completed" label="Completed">
          {metrics ? (
            <Link className="ov-num" to={paths.overviewList('completed', window)}>
              <b>{metrics.completed.count}</b>{' '}
              {metrics.completed.count === 1 ? 'ticket' : 'tickets'}
            </Link>
          ) : (
            <span className="ov-num">{WAITING}</span>
          )}
          {metrics && (
            <span className="ov-sub" data-delta>
              {deltaText(metrics.completed.count, metrics.completed.prior, window)}
            </span>
          )}
        </Stat>
        <Stat
          name="agents"
          label="Tickets with agents"
          describedBy={AGENTS_NOTE_ID}
          extra={<HelpLink anchor="needs-you.agents-strip" />}
        >
          {needs ? (
            <>
              <Link className="ov-num" to={paths.overviewList('agents_working')}>
                <b>{agents.working}</b> being worked
              </Link>
              <Link className="ov-sub" to={paths.overviewList('agents_waiting')}>
                {agents.waiting} parked/waiting
              </Link>
            </>
          ) : (
            <span className="ov-num">{WAITING}</span>
          )}
        </Stat>
        <Stat name="in-flight" label="In flight">
          {metrics ? (
            <>
              <Link className="ov-num" to={paths.overviewList('in_flight')}>
                <b>{metrics.in_flight.count}</b>{' '}
                {metrics.in_flight.count === 1 ? 'ticket' : 'tickets'}
              </Link>
              {/* Decision 57: what waits its turn, and what needs attention. */}
              <span className="ov-sub" data-wait-counts="">
                <Link to={paths.work({ quick: 'queued' })}>Queued {metrics.queued}</Link>
                {' · '}
                <Link to={paths.work({ quick: 'blocked' })}>Blocked {metrics.blocked}</Link>
              </span>
              {/* Decision 48: of everything in Ready, how much can really start. */}
              <Link className="ov-sub" to={paths.work({ quick: 'startable' })} data-ready-link>
                {metrics.ready.startable} of {metrics.ready.startable + metrics.ready.waiting} Ready
                can start
              </Link>
            </>
          ) : (
            <span className="ov-num">{WAITING}</span>
          )}
        </Stat>
        <Stat name="needs-you" label="Needs you">
          {!needs ? (
            <span className="ov-num">{WAITING}</span>
          ) : count === 0 ? (
            <span className="ov-num ov-clear">
              <span aria-hidden="true">✓ </span>Nothing
            </span>
          ) : (
            <>
              <Link className="ov-num" to="#needs-you">
                <b>{count}</b> to act on
              </Link>
              <span className="ov-sub">
                {actionLines.map(([n, one, many], i) => (
                  <span key={one}>
                    {i > 0 && ' · '}
                    <Link to={one === 'problem' ? '#problems' : '#needs-you'}>
                      {plural(n, one, many)}
                    </Link>
                  </span>
                ))}
              </span>
            </>
          )}
        </Stat>
      </div>
      {/* One line under the row, so the four cards stay short and level. */}
      <p className="src ov-note" id={AGENTS_NOTE_ID} data-agents-note>
        <b>Tickets with agents:</b> {AGENTS_NOTE}
      </p>
    </>
  );
}
