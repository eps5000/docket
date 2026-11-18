/**
 * The progress map (UI_SPEC §6.3.4): the epic Map tab, label pages and
 * Work → Map. Hand-built SVG over a CSS grid, no graph library.
 *
 * - Header: "n / N done", a bar split by status, counts with swatches,
 *   "n ready but blocked", "n ready to start · working on wave x of y".
 * - Columns are waves (layout.ts), after a dashed outside column, with a
 *   Cycle column last. Columns 200 px, 76 px apart, 16 px between cards.
 * - Arrows: SVG cubic curves from the right edge of a blocker to the left
 *   edge of the blocked card; solid = still blocks, dashed green = cleared.
 *   They are drawn above the cards. One that skips a column (for example
 *   from the outside column to wave 2) crosses the cards between, so it
 *   gets a halo in the card colour and reads as passing over them (B18).
 *   They are measured from the laid-out cards (unscaled), redrawn on resize
 *   (80 ms debounce) and scale with the map on zoom.
 * - Hover or focus on a card highlights its links and dims the rest.
 * - Pan: drag the background (drags under 4 px are clicks), scroll, or the
 *   arrow keys while the canvas has focus (UI_SPEC §11). Edge fades and
 *   *More* pills show when content overflows, with a "Drag to pan" hint.
 * - Zoom: − / percentage (reset to 100%) / + / Fit; steps 50, 67, 80, 100,
 *   125%; Fit shows everything, down to 40%.
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
import { Icon } from '../kit';
import { useRenderLimit } from '../../lib/progressive';
import { MapCard } from './MapCard';
import {
  BAR_ORDER,
  arrowPath,
  skipsColumn,
  fitZoom,
  layoutMap,
  stepZoom,
  type MapEdge,
  type MapItem,
} from './layout';
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
  /** It skips a column, so it crosses cards: draw it with a halo. */
  over: boolean;
}

/** One shared empty `outside`: a fresh `[]` default would change the layout every render and loop. */
const NO_OUTSIDE: readonly MapItem[] = [];

export function ProgressMap({
  items,
  outside = NO_OUTSIDE,
  links,
  outsideTitle,
  home,
}: ProgressMapProps) {
  const layout = useMemo(() => layoutMap(items, outside, links), [items, outside, links]);
  // A whole workspace on one map (thousands of cards) renders each column's first cards at
  // once and the rest right after (lib/progressive.ts); arrows redraw as cards arrive.
  const limit = useRenderLimit(items.length + outside.length);
  const uid = useId().replace(/:/g, '');
  const mapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<Zoom>({ fit: false, z: 1 });
  const [geo, setGeo] = useState<{ w: number; h: number; arrows: Arrow[]; view: number }>({
    w: 0,
    h: 0,
    arrows: [],
    view: 0,
  });
  const [cues, setCues] = useState({ l: false, r: false, b: false, pannable: false });
  const [traced, setTraced] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; l: number; t: number; moved: boolean } | null>(null);

  // ---- Measure cards and draw arrows (unscaled coordinates) ----
  const measure = useCallback(() => {
    const map = mapRef.current;
    const canvas = canvasRef.current;
    if (!map || !canvas) return;
    const nodes = new Map<string, HTMLElement>();
    for (const el of map.querySelectorAll<HTMLElement>('[data-pid]'))
      nodes.set(el.dataset.pid!, el);
    const pos = (id: string) => {
      const el = nodes.get(id);
      const col = el?.parentElement;
      if (!el || !col) return null;
      const x = col.offsetLeft + el.offsetLeft;
      const y = col.offsetTop + el.offsetTop;
      return { left: x, right: x + el.offsetWidth, midY: y + el.offsetHeight / 2 };
    };
    const arrows: Arrow[] = [];
    for (const e of layout.edges) {
      const a = pos(e.from);
      const b = pos(e.to);
      if (!a || !b || a.right > b.left) continue;
      arrows.push({ ...e, d: arrowPath(a, b), over: skipsColumn(a, b) });
    }
    setGeo({ w: map.offsetWidth, h: map.offsetHeight, arrows, view: canvas.clientWidth });
  }, [layout]);

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
        { width: Math.max(0, geo.view - PAD_X), height: MAX_H - PAD_Y },
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
  useLayoutEffect(updateCues, [updateCues, geo, z]);

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

  // ---- Hover tracing ----
  const related = useMemo(() => {
    if (!traced) return null;
    const ids = new Set([traced]);
    for (const e of layout.edges) {
      if (e.from === traced) ids.add(e.to);
      if (e.to === traced) ids.add(e.from);
    }
    return ids;
  }, [traced, layout.edges]);
  const tracedOf = (id: string) => (related ? (related.has(id) ? 'on' : 'dim') : null);

  const { counts } = layout;
  const cols: { key: string; title: string; sub: string; cards: MapItem[]; ext?: boolean }[] = [];
  if (layout.outside.length > 0) {
    cols.push({
      key: 'outside',
      title: outsideTitle,
      sub: 'blocks work here',
      cards: layout.outside,
      ext: true,
    });
  }
  layout.waves.forEach((w, k) =>
    cols.push({
      key: `wave-${k + 1}`,
      title: `Wave ${k + 1}`,
      sub: k === 0 ? 'nothing blocks these' : `after wave ${k}`,
      cards: w,
    }),
  );
  if (layout.cycle.length > 0) {
    cols.push({
      key: 'cycle',
      title: 'Cycle',
      sub: 'fix a link to place these',
      cards: layout.cycle,
    });
  }

  const barLabel = BAR_ORDER.map(
    (s) => `${counts.byStatus[s] ?? 0} ${STATUS_LABELS[s].toLowerCase()}`,
  ).join(', ');
  const pct = Math.round(z * 100);

  return (
    <div className={`pm-box${cues.pannable ? ' pannable' : ''}`} data-progress-map="">
      <div className="pm-head">
        <div className="pm-big">
          {counts.done}
          <span className="muted"> / {counts.total} done</span>
        </div>
        <div className="pm-bar" role="img" aria-label={barLabel}>
          {BAR_ORDER.map((s) =>
            counts.byStatus[s] ? (
              <i
                key={s}
                className={`pb-${s}`}
                style={{
                  width: `${((counts.byStatus[s] ?? 0) / Math.max(1, counts.total)) * 100}%`,
                }}
              />
            ) : null,
          )}
        </div>
        <div />
        <div className="pm-legend">
          {BAR_ORDER.filter((s) => counts.byStatus[s]).map((s) => (
            <span key={s}>
              <b className={`pb-${s}`} aria-hidden="true" />
              {counts.byStatus[s]} {STATUS_LABELS[s].toLowerCase()}
            </span>
          ))}
          {counts.readyButBlocked > 0 && (
            <span className="pm-badtext">{counts.readyButBlocked} ready but blocked</span>
          )}
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
          aria-label={`Progress map: ${cols.map((c) => c.title).join(', ')}. Scroll, use the arrow keys, or drag to move around.`}
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
              className={`pm-map${related ? ' tracing' : ''}`}
              style={{ transform: `scale(${z})` }}
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
                {geo.arrows.map((a) => {
                  const on = related && (a.from === traced || a.to === traced);
                  return (
                    <g key={a.link_id}>
                      {a.over && (
                        <path
                          className={['pm-halo', related && !on && 'dim'].filter(Boolean).join(' ')}
                          d={a.d}
                        />
                      )}
                      <path
                        className={[
                          'pm-edge',
                          a.cleared && 'ok',
                          on && 'hl',
                          related && !on && 'dim',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        data-from={a.from}
                        data-to={a.to}
                        d={a.d}
                        markerEnd={`url(#${a.cleared ? `pa-ok-${uid}` : `pa-${uid}`})`}
                      />
                    </g>
                  );
                })}
              </svg>
              {cols.map((c) => (
                <div key={c.key} className={`pm-col${c.ext ? ' ext' : ''}`} data-col={c.key}>
                  <div className="pm-colh">
                    {c.title}
                    <span>{c.sub}</span>
                  </div>
                  {c.cards.slice(0, limit).map((i) => (
                    <MapCard
                      key={i.id}
                      item={i}
                      outside={c.ext ? { label: outsideLabel(i, home) } : null}
                      traced={tracedOf(i.id)}
                      onTrace={setTraced}
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
        Arrow = blocks · dashed green = cleared · hover to trace
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
