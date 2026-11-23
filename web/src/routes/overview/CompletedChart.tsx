import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router';
import type { OverviewResponse } from '@docket/shared';
import { Card, CardHeader } from '../../components/kit';
import { plural } from '../../lib/format';
import { paths } from '../../lib/paths';

type Bucket = OverviewResponse['completed']['buckets'][number];

/** One sentence that says what the bars say. */
export function completedSummary(completed: OverviewResponse['completed']): string {
  if (completed.count === 0) return 'No tickets completed in this window.';
  const peak = completed.buckets.reduce((a, b) => (b.count > a.count ? b : a));
  return `${plural(completed.count, 'ticket')} completed. Busiest: ${peak.label}, with ${peak.count}.`;
}

const MAX_INTERVALS = 4;

/**
 * The vertical axis: whole numbers from 0, stepping by 1, 2 or 5 times a power
 * of ten, in at most four intervals. The last tick is at or above `max`, and is
 * the top of the scale. An empty chart still reads 0 and 1.
 */
export function axisTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max));
  for (let power = 1; ; power *= 10) {
    for (const m of [1, 2, 5]) {
      const step = m * power;
      const intervals = Math.ceil(top / step);
      if (intervals <= MAX_INTERVALS) {
        return Array.from({ length: intervals + 1 }, (_, k) => k * step);
      }
    }
  }
}

/** "RCP-1 Title; RCP-2 Title; and 3 more", or "None". */
export function bucketTicketsText(b: Bucket): string {
  if (b.count === 0) return 'None';
  const names = b.tickets.map((t) => `${t.id} ${t.title}`);
  const more = b.count - b.tickets.length;
  return [...names, ...(more > 0 ? [`and ${more} more`] : [])].join('; ');
}

const EDGE = 8;
const GAP = 6;
/** Time to move the pointer from a bar onto its tooltip. */
const HIDE_MS = 200;

type Box = { left: number; top: number; bottom: number; width: number };

/** Above the bar if it fits, else below, else as high as it can go; always inside the window. */
export function placeTip(
  anchor: Box,
  tip: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.max(EDGE, Math.min(centred, view.width - tip.width - EDGE));
  const above = anchor.top - tip.height - GAP;
  const below = anchor.bottom + GAP;
  if (above >= EDGE) return { left, top: above };
  if (below + tip.height <= view.height - EDGE) return { left, top: below };
  return { left, top: Math.max(EDGE, view.height - tip.height - EDGE) };
}

function BucketTip({
  bucket,
  id,
  position,
  tipRef,
  onEnter,
  onLeave,
}: {
  bucket: Bucket;
  id: string;
  position: { left: number; top: number } | null;
  tipRef: React.RefObject<HTMLDivElement | null>;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const more = bucket.count - bucket.tickets.length;
  const counted =
    bucket.count === 0 ? 'None completed' : `${plural(bucket.count, 'ticket')} completed`;
  return (
    <div
      id={id}
      ref={tipRef}
      className="ov-tip"
      role="group"
      aria-label={`${bucket.label}: ${counted}`}
      data-chart-tip={bucket.key}
      style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <p className="ov-tip-h">
        <b>{bucket.label}</b> · {counted}
      </p>
      {bucket.tickets.length > 0 && (
        <ul>
          {bucket.tickets.map((t) => (
            <li key={t.id}>
              <Link to={paths.item(t.id)} title={`${t.id} ${t.title}`}>
                <span className="mono">{t.id}</span> <span className="ov-tip-t">{t.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="ov-tip-more">and {more} more</p>}
    </div>
  );
}

/**
 * Completed per day (per hour for 24h). A single series, so no legend: the
 * title names it. Each bar is a button, one tab stop for the whole row (arrow
 * keys move along it), and opens a tooltip naming its tickets. Tab goes on into
 * the tooltip's links, and Esc closes it. Assistive tech also gets the summary
 * and a table of the same values and tickets.
 */
export function CompletedChart({ completed }: { completed: OverviewResponse['completed'] }) {
  const unit = completed.granularity === 'hour' ? 'hour' : 'day';
  const { buckets } = completed;
  const ticks = axisTicks(Math.max(0, ...buckets.map((b) => b.count)));
  const top = ticks.at(-1)!;
  const first = buckets[0];
  const last = buckets.at(-1);
  const pct = (n: number) => `${(n / top) * 100}%`;

  const baseId = useId();
  const tipId = `${baseId}-tip`;
  const hintId = `${baseId}-hint`;
  const rootRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef(new Map<string, HTMLButtonElement>());
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Esc returns focus to the bar without opening its tooltip again. */
  const quietFocus = useRef(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [stopKey, setStopKey] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const open = buckets.find((b) => b.key === openKey) ?? null;
  const fallbackStop = buckets.findLast((b) => b.count > 0) ?? last;
  const tabStop = buckets.some((b) => b.key === stopKey) ? stopKey : (fallbackStop?.key ?? null);

  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);
  const show = useCallback(
    (key: string) => {
      cancelHide();
      setOpenKey(key);
    },
    [cancelHide],
  );
  /** The pointer left. A tooltip the keyboard is in stays until focus moves on. */
  const hideSoon = useCallback(() => {
    cancelHide();
    hideTimer.current = setTimeout(() => {
      if (!rootRef.current?.contains(document.activeElement)) setOpenKey(null);
    }, HIDE_MS);
  }, [cancelHide]);
  useEffect(() => cancelHide, [cancelHide]);

  // Esc dismisses it wherever focus is, including a tooltip opened by hover alone.
  const openedKey = open?.key ?? null;
  useEffect(() => {
    if (!openedKey) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      cancelHide();
      if (tipRef.current?.contains(document.activeElement)) {
        quietFocus.current = true;
        barRefs.current.get(openedKey)?.focus();
        quietFocus.current = false;
      }
      setOpenKey(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openedKey, cancelHide]);

  // Measured once it's in the page, and again if the page scrolls or resizes under it.
  useLayoutEffect(() => {
    if (!openedKey) return;
    const update = () => {
      const bar = barRefs.current.get(openedKey);
      const tip = tipRef.current;
      if (!bar || !tip) return;
      setPosition(
        placeTip(
          bar.getBoundingClientRect(),
          { width: tip.offsetWidth, height: tip.offsetHeight },
          { width: document.documentElement.clientWidth, height: window.innerHeight },
        ),
      );
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [openedKey, open?.count, open?.tickets]);

  const onBarKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to =
      e.key === 'ArrowRight'
        ? index + 1
        : e.key === 'ArrowLeft'
          ? index - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buckets.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    const next = buckets[Math.max(0, Math.min(buckets.length - 1, to))];
    if (next) barRefs.current.get(next.key)?.focus();
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) {
      cancelHide();
      setOpenKey(null);
    }
  };

  return (
    <Card data-card="completed-chart" className="ov-chart">
      <CardHeader title={`Completed per ${unit}`} />
      <div className="ov-chart-body">
        <p className="src">{completedSummary(completed)}</p>
        <div className="ov-plot" ref={rootRef} onBlur={onBlur}>
          <div className="ov-yaxis" aria-hidden="true" style={{ width: `${String(top).length}ch` }}>
            {ticks.map((t) => (
              <span key={t} style={{ bottom: pct(t) }}>
                {t}
              </span>
            ))}
          </div>
          <div className="ov-plotarea">
            <div className="ov-grid" aria-hidden="true">
              {ticks.map((t) => (
                <i key={t} data-zero={t === 0 || undefined} style={{ bottom: pct(t) }} />
              ))}
            </div>
            <div
              className="ov-bars"
              role="group"
              aria-label={`Tickets completed, one bar per ${unit}`}
              aria-describedby={hintId}
            >
              {buckets.map((b, index) => (
                <button
                  key={b.key}
                  ref={(el) => {
                    if (el) barRefs.current.set(b.key, el);
                    else barRefs.current.delete(b.key);
                  }}
                  type="button"
                  className="ov-bar"
                  data-bar={b.key}
                  tabIndex={b.key === tabStop ? 0 : -1}
                  aria-label={`${b.label}: ${b.count === 0 ? 'none' : plural(b.count, 'ticket')} completed`}
                  aria-expanded={b.key === openedKey}
                  aria-controls={b.key === openedKey ? tipId : undefined}
                  onMouseEnter={() => show(b.key)}
                  onMouseLeave={hideSoon}
                  onClick={() => show(b.key)}
                  onFocus={() => {
                    setStopKey(b.key);
                    if (!quietFocus.current) show(b.key);
                  }}
                  onKeyDown={(e) => onBarKey(e, index)}
                >
                  {b.count > 0 && <i style={{ height: pct(b.count) }} />}
                </button>
              ))}
            </div>
            <span id={hintId} className="sr">
              Left and right arrow keys move between bars. Tab moves into the open bar’s tickets,
              and Escape closes them.
            </span>
          </div>
          {/* Straight after the bars, so Tab from a bar lands on its first ticket. */}
          {open && (
            <BucketTip
              bucket={open}
              id={tipId}
              position={position}
              tipRef={tipRef}
              onEnter={cancelHide}
              onLeave={hideSoon}
            />
          )}
          <div className="ov-axis" aria-hidden="true">
            <span>{first?.label}</span>
            <span>{last?.label}</span>
          </div>
        </div>
        {/* In a wrapper: a table ignores the clipping `.sr` relies on. */}
        <div className="sr">
          <table>
            <caption>Tickets completed per {unit}</caption>
            <thead>
              <tr>
                <th scope="col">{unit === 'hour' ? 'Hour' : 'Day'}</th>
                <th scope="col">Completed</th>
                <th scope="col">Tickets</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.key}>
                  <th scope="row">{b.label}</th>
                  <td>{b.count}</td>
                  <td>{bucketTicketsText(b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
