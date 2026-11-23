/**
 * The progress map (UI_SPEC §6.3.4): the epic Map tab, label pages and
 * Work → Map. Hand-built SVG over a CSS grid, no graph library.
 *
 * - Header: "n / N done", a bar split by status, counts with swatches,
 *   "n ready but blocked", "n ready to start · working on wave x of y".
 * - Columns are waves (layout.ts), after a dashed outside column, with a
 *   Cycle column last. Columns are 200 px wide; gutters (at least 76 px) and
 *   row gaps (at least 16 px) grow with the arrows they carry.
 * - Arrows (routing.ts, B47): rounded runs through the gutters and the
 *   channels between rows, never across a card; solid = still blocks, dashed
 *   green = cleared. Card heights are measured (unscaled), everything is
 *   re-routed on resize (80 ms debounce), and it scales with the map on zoom.
 * - Hover or focus on a card highlights its links and dims the rest.
 * - Pan: drag the background (drags under 4 px are clicks), scroll, or the
 *   arrow keys while the canvas has focus (UI_SPEC §11). Edge fades and
 *   *More* pills show when content overflows, with a "Drag to pan" hint.
 * - Zoom: − / percentage (reset to 100%) / + / Fit; steps 50, 67, 80, 100,
 *   125%; Fit shows everything, down to 40%.
 * - Critical path (decision 48): with a goal, the chain is outlined and numbered
 *   on its cards, everything else is muted, and the ticket to move next is
 *   scrolled into view. Muted cards keep their text contrast (no opacity).
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { STATUS_LABELS, type LinkEdge } from '@docket/shared';
import { Icon, StatusBar, type StatusBarSegment } from '../kit';
import { useRenderLimit } from '../../lib/progressive';
import { MapCard } from './MapCard';
import { fitZoom, layoutMap, stepZoom, type MapEdge, type MapItem } from './layout';
import { planMap, routeMap, type RoutedMap } from './routing';
import './progress-map.css';

export interface ProgressMapProps {
  items: readonly MapItem[];
  /** Cards for blockers outside the scope (the API's `outside`). */
  outside?: readonly MapItem[];
  links: readonly LinkEdge[];
  /** "Outside this epic", "Outside this view", "Without this label". */
  outsideTitle: string;
  /** The epic whose map this is: outside cards in the same project say "other epic". */
  home?: { project: string } | null;
  /** The chain to highlight (decision 48). Keep it stable between renders. */
  critical?: CriticalOverlay | null;
}

/** A critical path on the map (routes/shared/GoalMap.tsx). */
export interface CriticalOverlay {
  /** Item → its 1-based place on the chain. */
  steps: ReadonlyMap<string, number>;
  total: number;
  next: string | null;
  linkIds: ReadonlySet<string>;
  /** Chain tickets the view doesn't include. */
  extras: readonly MapItem[];
  /** The view's links plus the chain's. */
  links: readonly LinkEdge[];
}

/** How a card outside the scope is labelled: "other epic ↗" or its project. */
export function outsideLabel(item: MapItem, home?: { project: string } | null): string {
  return home && item.project === home.project ? 'other epic ↗' : `${item.project} ↗`;
}

const PAN_STEP = 60;
const DRAG_MIN = 4;
const REDRAW_DEBOUNCE_MS = 80;
/** Canvas padding (18 px 22 px) on both sides, and the 540 px height cap. */
const PAD_X = 44;
const PAD_Y = 36;
const MAX_H = 540;

type Zoom = { fit: false; z: number } | { fit: true };

interface Arrow extends MapEdge {
  d: string;
}

/** The map's bar and legend, in order (UI_SPEC §6.3.4); "blocked" is Ready that can't start. */
const MAP_BAR: readonly Exclude<StatusBarSegment, 'canceled'>[] = [
  'done',
  'review',
  'progress',
  'ready',
  'blocked',
  'planning',
  'inbox',
];
const barName = (s: (typeof MAP_BAR)[number]) =>
  s === 'blocked' ? 'ready but blocked' : STATUS_LABELS[s].toLowerCase();

/** One shared empty `outside`: a fresh `[]` default would change the layout every render and loop. */
const NO_OUTSIDE: readonly MapItem[] = [];
const NO_EXTRAS: readonly MapItem[] = [];

export function ProgressMap({
  items,
  outside = NO_OUTSIDE,
  links,
  outsideTitle,
  home,
  critical = null,
}: ProgressMapProps) {
  const extras = critical?.extras ?? NO_EXTRAS;
  const layout = useMemo(
    () => layoutMap(items, outside, links, extras),
    [items, outside, links, extras],
  );
  const extraIds = useMemo(() => new Set(extras.map((i) => i.id)), [extras]);
  // A whole workspace on one map (thousands of cards) renders each column's first cards at
  // once and the rest right after (lib/progressive.ts); arrows redraw as cards arrive.
  const limit = useRenderLimit(items.length + outside.length + extras.length);
  const uid = useId().replace(/:/g, '');
  const mapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<Zoom>({ fit: false, z: 1 });
  const [geo, setGeo] = useState<{
    w: number;
    h: number;
    arrows: Arrow[];
    routed: RoutedMap | null;
  }>({ w: 0, h: 0, arrows: [], routed: null });
  const [view, setView] = useState(0);
  const routedFor = useRef('');
  const geoPlan = useRef<unknown>(null);
  const [cues, setCues] = useState({ l: false, r: false, b: false, pannable: false });
  const [traced, setTraced] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; l: number; t: number; moved: boolean } | null>(null);

  // ---- Columns, card order and rows (pure, so the map doesn't jump between renders) ----
  const cols = useMemo(() => {
    const out: { key: string; title: string; sub: string; cards: MapItem[]; ext?: boolean }[] = [];
    if (layout.outside.length > 0) {
      out.push({
        key: 'outside',
        title: outsideTitle,
        sub: 'blocks work here',
        cards: layout.outside,
        ext: true,
      });
    }
    layout.waves.forEach((w, k) =>
      out.push({
        key: `wave-${k + 1}`,
        title: `Wave ${k + 1}`,
        sub: k === 0 ? 'nothing blocks these' : `after wave ${k}`,
        cards: w,
      }),
    );
    if (layout.cycle.length > 0) {
      out.push({
        key: 'cycle',
        title: 'Cycle',
        sub: 'fix a link to place these',
        cards: layout.cycle,
      });
    }
    const plan = planMap(
      out.map((c) => c.cards.map((i) => i.id)),
      layout.edges.map((e) => ({ id: e.link_id, from: e.from, to: e.to })),
    );
    const byId = new Map(out.flatMap((c) => c.cards).map((i) => [i.id, i]));
    return {
      plan,
      list: out.map((c, i) => ({ ...c, cards: plan.columns[i]!.map((id) => byId.get(id)!) })),
    };
  }, [layout, outsideTitle]);

  // ---- Measure card heights and route the arrows (unscaled coordinates) ----
  const measure = useCallback(() => {
    const map = mapRef.current;
    const canvas = canvasRef.current;
    if (!map || !canvas) return;
    setView(canvas.clientWidth);
    const heights = new Map<string, number>();
    for (const el of map.querySelectorAll<HTMLElement>('[data-pid]'))
      heights.set(el.dataset.pid!, el.offsetHeight);
    let head = 0;
    for (const el of map.querySelectorAll<HTMLElement>('.pm-colh'))
      head = Math.max(head, el.offsetHeight);
    // Re-route only when something changed: the observer also fires for our own resize.
    const stamp = `${head}|${[...heights].map(([id, h]) => `${id}:${h}`).join(',')}`;
    if (routedFor.current === stamp && geoPlan.current === cols.plan) return;
    routedFor.current = stamp;
    geoPlan.current = cols.plan;
    const routed = routeMap(cols.plan, {
      height: (id) => heights.get(id),
      head,
      rendered: (id) => heights.has(id),
    });
    const edgeById = new Map(layout.edges.map((e) => [e.link_id, e]));
    setGeo({
      w: routed.width,
      h: routed.height,
      routed,
      arrows: routed.arrows.map((a) => ({ ...edgeById.get(a.id)!, d: a.d })),
    });
  }, [cols, layout.edges]);

  // Again when more cards arrive (`limit`), so their arrows are drawn too.
  useLayoutEffect(() => {
    measure();
  }, [measure, limit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const map = mapRef.current;
    if (!canvas || !map || typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, REDRAW_DEBOUNCE_MS);
    });
    ro.observe(canvas);
    ro.observe(map);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [measure]);

  const z = zoom.fit
    ? fitZoom(
        { width: geo.w, height: geo.h },
        { width: Math.max(0, view - PAD_X), height: MAX_H - PAD_Y },
      )
    : zoom.z;

  // ---- Overflow cues ----
  const updateCues = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const next = {
      l: c.scrollLeft > 2,
      r: c.scrollLeft + c.clientWidth < c.scrollWidth - 2,
      b: c.scrollTop + c.clientHeight < c.scrollHeight - 2,
      pannable: c.scrollWidth > c.clientWidth + 2 || c.scrollHeight > c.clientHeight + 2,
    };
    setCues((prev) =>
      prev.l === next.l && prev.r === next.r && prev.b === next.b && prev.pannable === next.pannable
        ? prev
        : next,
    );
  }, []);
  // `view` too: a narrower window changes what overflows without moving any arrow.
  useLayoutEffect(updateCues, [updateCues, geo, z, view]);

  // ---- Pan ----
  const pan = (dx: number, dy: number) => {
    const c = canvasRef.current;
    if (!c) return;
    c.scrollBy({ left: dx, top: dy });
    updateCues();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-PAN_STEP, 0],
      ArrowRight: [PAN_STEP, 0],
      ArrowUp: [0, -PAN_STEP],
      ArrowDown: [0, PAN_STEP],
    };
    const m = move[e.key];
    if (!m) return;
    e.preventDefault();
    pan(m[0], m[1]);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.pm-node')) return;
    const c = canvasRef.current!;
    drag.current = { x: e.clientX, y: e.clientY, l: c.scrollLeft, t: c.scrollTop, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const c = canvasRef.current;
    if (!d || !c) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_MIN) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
      c.setPointerCapture?.(e.pointerId);
    }
    c.scrollLeft = d.l - dx;
    c.scrollTop = d.t - dy;
    updateCues();
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.moved) canvasRef.current?.releasePointerCapture?.(e.pointerId);
    drag.current = null;
    setDragging(false);
  };

  // Bring the ticket to move next into view when a chain appears.
  const nextId = critical?.next ?? null;
  const routedReady = geo.routed !== null;
  useEffect(() => {
    const c = canvasRef.current;
    if (!nextId || !routedReady || !c?.scrollBy) return;
    const card = c.querySelector<HTMLElement>(`[data-pid="${nextId}"]`);
    if (!card) return;
    const box = c.getBoundingClientRect();
    const at = card.getBoundingClientRect();
    c.scrollBy({
      left: at.left - box.left - (box.width - at.width) / 2,
      top: at.top - box.top - (box.height - at.height) / 2,
    });
  }, [nextId, routedReady]);

  // ---- Hover tracing (off while a chain is shown: one highlight at a time) ----
  const related = useMemo(() => {
    if (!traced || critical) return null;
    const ids = new Set([traced]);
    for (const e of layout.edges) {
      if (e.from === traced) ids.add(e.to);
      if (e.to === traced) ids.add(e.from);
    }
    return ids;
  }, [traced, layout.edges, critical]);
  const tracedOf = (id: string) => (related ? (related.has(id) ? 'on' : 'dim') : null);
  const criticalOf = (id: string) => {
    if (!critical) return null;
    const step = critical.steps.get(id);
    return step === undefined
      ? ('off' as const)
      : { step, total: critical.total, next: id === critical.next };
  };

  const { counts } = layout;
  // Ready splits into what can start and what can't, so the bar adds up to the total.
  const bar: Record<(typeof MAP_BAR)[number], number> = {
    done: counts.byStatus.done ?? 0,
    review: counts.byStatus.review ?? 0,
    progress: counts.byStatus.progress ?? 0,
    ready: (counts.byStatus.ready ?? 0) - counts.readyButBlocked,
    blocked: counts.readyButBlocked,
    planning: counts.byStatus.planning ?? 0,
    inbox: counts.byStatus.inbox ?? 0,
  };
  const barLabel = MAP_BAR.map((s) => `${bar[s]} ${barName(s)}`).join(', ');
  // A traced arrow is painted last, so it stays on top where arrows share a channel.
  const paintOrder = related
    ? [
        ...geo.arrows.filter((a) => a.from !== traced && a.to !== traced),
        ...geo.arrows.filter((a) => a.from === traced || a.to === traced),
      ]
    : geo.arrows;
  const pct = Math.round(z * 100);

  return (
    <div className={`pm-box${cues.pannable ? ' pannable' : ''}`} data-progress-map="">
      <div className="pm-head">
        <div className="pm-big">
          {counts.done}
          <span className="muted"> / {counts.total} done</span>
        </div>
        <StatusBar counts={bar} label={barLabel} />
        <div />
        <div className="pm-legend">
          {MAP_BAR.filter((s) => bar[s] > 0).map((s) => (
            <span key={s} className={s === 'blocked' ? 'pm-badtext' : undefined}>
              <b className={`sb-${s}`} aria-hidden="true" />
              {bar[s]} {barName(s)}
            </span>
          ))}
          <span className="muted">
            {counts.readyToStart} ready to start
            {counts.workingOnWave !== null
              ? ` · working on wave ${counts.workingOnWave} of ${layout.waves.length}`
              : ''}
          </span>
        </div>
      </div>

      <div className="pm-tools">
        <span className="src pm-hint">Drag to pan</span>
        <div className="seg" role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={!zoom.fit && z <= 0.5}
            onClick={() => setZoom({ fit: false, z: stepZoom(z, -1) })}
          >
            −
          </button>
          <button
            type="button"
            aria-label={`Zoom ${pct}%. Reset to 100%`}
            onClick={() => setZoom({ fit: false, z: 1 })}
          >
            {pct}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={!zoom.fit && z >= 1.25}
            onClick={() => setZoom({ fit: false, z: stepZoom(z, 1) })}
          >
            +
          </button>
          <button
            type="button"
            aria-pressed={zoom.fit}
            onClick={() => setZoom(zoom.fit ? { fit: false, z: 1 } : { fit: true })}
          >
            Fit
          </button>
        </div>
      </div>

      <div
        className={['pm-frame', cues.l && 'more-l', cues.r && 'more-r', cues.b && 'more-b']
          .filter(Boolean)
          .join(' ')}
      >
        <div
          ref={canvasRef}
          className={`pm-canvas${dragging ? ' dragging' : ''}`}
          tabIndex={0}
          role="region"
          aria-label={`Progress map: ${cols.list.map((c) => c.title).join(', ')}. Scroll, use the arrow keys, or drag to move around.`}
          onKeyDown={onKeyDown}
          onScroll={updateCues}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            className="pm-sizer"
            style={{ width: Math.ceil(geo.w * z), height: Math.ceil(geo.h * z) }}
          >
            <div
              ref={mapRef}
              className={['pm-map', geo.routed && 'routed', related && 'tracing']
                .filter(Boolean)
                .join(' ')}
              style={{
                transform: `scale(${z})`,
                ...(geo.routed ? { width: geo.w, height: geo.h } : null),
              }}
              data-zoom={pct}
            >
              <svg
                className="pm-edges"
                width={geo.w}
                height={geo.h}
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  <marker
                    id={`pa-${uid}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M0,0L10,5L0,10z" className="pm-head-block" />
                  </marker>
                  <marker
                    id={`pa-ok-${uid}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M0,0L10,5L0,10z" className="pm-head-ok" />
                  </marker>
                </defs>
                {paintOrder.map((a) => {
                  const on = related && (a.from === traced || a.to === traced);
                  return (
                    <path
                      key={a.link_id}
                      className={[
                        'pm-edge',
                        a.cleared && 'ok',
                        on && 'hl',
                        related && !on && 'dim',
                        critical && (critical.linkIds.has(a.link_id) ? 'crit' : 'critoff'),
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      data-from={a.from}
                      data-to={a.to}
                      d={a.d}
                      markerEnd={`url(#${a.cleared ? `pa-ok-${uid}` : `pa-${uid}`})`}
                    />
                  );
                })}
              </svg>
              {cols.list.map((c, colIndex) => (
                <div
                  key={c.key}
                  className={`pm-col${c.ext ? ' ext' : ''}`}
                  data-col={c.key}
                  style={
                    geo.routed
                      ? { left: geo.routed.columnX[colIndex] ?? 0, height: geo.h }
                      : undefined
                  }
                >
                  <div className="pm-colh">
                    {c.title}
                    <span>{c.sub}</span>
                  </div>
                  {c.cards.slice(0, limit).map((i) => (
                    <MapCard
                      key={i.id}
                      item={i}
                      outside={
                        c.ext || extraIds.has(i.id) ? { label: outsideLabel(i, home) } : null
                      }
                      critical={criticalOf(i.id)}
                      traced={tracedOf(i.id)}
                      onTrace={setTraced}
                      top={geo.routed?.cards.get(i.id)?.y}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="pm-more l"
          tabIndex={cues.l ? 0 : -1}
          onClick={() => pan(-320, 0)}
        >
          ← More<span className="sr"> (scroll the map left)</span>
        </button>
        <button
          type="button"
          className="pm-more r"
          tabIndex={cues.r ? 0 : -1}
          onClick={() => pan(320, 0)}
        >
          More →<span className="sr"> (scroll the map right)</span>
        </button>
        <button
          type="button"
          className="pm-more b"
          tabIndex={cues.b ? 0 : -1}
          onClick={() => pan(0, 240)}
        >
          More ↓<span className="sr"> (scroll the map down)</span>
        </button>
      </div>

      <div className="src pm-key">
        Arrow = blocks · dashed green = cleared ·{' '}
        {critical ? 'numbered cards = the chain, muted cards aren’t on it' : 'hover to trace'}
        <span className="pm-keyitem">
          <span className="pm-hr now" aria-hidden="true">
            <Icon name="person" small />
          </span>
          packet ready for you
        </span>
        ·
        <span className="pm-keyitem">
          <span className="pm-hr later" aria-hidden="true">
            <Icon name="person" small />
          </span>
          your review later
        </span>
      </div>
    </div>
  );
}
