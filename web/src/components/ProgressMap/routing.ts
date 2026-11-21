/**
 * Where the map's cards sit and how its arrows run (UI_SPEC §6.3.4; B47). Pure
 * and deterministic, with no DOM: the component measures card heights and
 * passes them in.
 *
 * Cards sit on a shared grid of rows, so the space between two rows is one
 * clear horizontal **channel** across the whole map, and the space between two
 * columns is a vertical **gutter**. An arrow only ever runs in those:
 *
 * - next column, same row: a straight line;
 * - next column, another row: out to a lane in the gutter, along it, and in;
 * - a skipped column: out to a gutter lane, along a channel lane past the
 *   columns between, down the last gutter, and in. If the row is empty all the
 *   way, it is a straight line instead.
 *
 * So no segment can cross a card other than its two ends, at any zoom. Gutters
 * and channels grow with the number of lanes they carry.
 */

export interface PlanEdge {
  id: string;
  from: string;
  to: string;
}

export interface MapPlan {
  /** Card IDs per column, in display order. */
  columns: string[][];
  place: Map<string, { col: number; row: number }>;
  rows: number;
  /** Forward edges only, in a fixed order. */
  edges: PlanEdge[];
}

export interface CardBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RoutedArrow {
  id: string;
  from: string;
  to: string;
  /** The SVG path, with rounded corners. */
  d: string;
}

export interface RoutedMap {
  width: number;
  height: number;
  columnX: number[];
  cards: Map<string, CardBox>;
  arrows: RoutedArrow[];
}

export const CARD_WIDTH = 200;
/** The smallest gutter and row gap (UI_SPEC §6.3.4); both grow with their lanes. */
export const GUTTER_MIN = 76;
export const ROW_GAP_MIN = 16;
const GUTTER_PAD = 14;
const LANE_X = 8;
const CHANNEL_PAD = 7;
const LANE_Y = 7;
/** Ports on one card edge: spacing, and how far they stay from its corners. */
const PORT_STEP = 9;
const PORT_INSET = 6;
/** An arrow stops just before the card, so its head stays visible. */
const ARROW_END = 3;
const CORNER = 6;
/** Height for a card that hasn't rendered yet (a long map renders progressively). */
const ESTIMATED_HEIGHT = 74;
const SWEEPS = 4;
/** Two vertical runs closer than this get separate lanes. */
const LANE_CLEARANCE = 5;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Crossings between edges that span the same pair of columns (a Fenwick count). */
function countCrossings(
  edges: readonly { ca: number; cb: number; a: number; b: number }[],
  columnSizes: readonly number[],
): number {
  const groups = new Map<number, { a: number; b: number }[]>();
  const width = columnSizes.length + 1;
  for (const e of edges) {
    const key = e.ca * width + e.cb;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }
  let crossings = 0;
  for (const [key, group] of groups) {
    const size = columnSizes[key % width]! + 1;
    const tree = new Int32Array(size + 1);
    group.sort((x, y) => x.a - y.a || x.b - y.b);
    let seen = 0;
    for (let i = 0; i < group.length;) {
      let j = i;
      while (j < group.length && group[j]!.a === group[i]!.a) j++;
      for (let k = i; k < j; k++) {
        let notAbove = 0;
        for (let t = group[k]!.b + 1; t > 0; t -= t & -t) notAbove += tree[t]!;
        crossings += seen - notAbove;
      }
      for (let k = i; k < j; k++) {
        for (let t = group[k]!.b + 1; t <= size; t += t & -t) tree[t]!++;
        seen++;
      }
      i = j;
    }
  }
  return crossings;
}

/**
 * Order the cards in each column to reduce crossings (a barycenter sweep,
 * keeping the best order seen), then give each a row near its blockers.
 * Ties keep the incoming order, so the result is stable between renders.
 */
export function planMap(
  columns: readonly (readonly string[])[],
  edges: readonly PlanEdge[],
): MapPlan {
  const colOf = new Map<string, number>();
  columns.forEach((c, i) => c.forEach((id) => colOf.set(id, i)));
  const forward = edges
    .filter((e) => {
      const a = colOf.get(e.from);
      const b = colOf.get(e.to);
      return a !== undefined && b !== undefined && a < b;
    })
    .sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to) || cmp(x.id, y.id));

  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  for (const e of forward) {
    (before.get(e.to) ?? before.set(e.to, []).get(e.to)!).push(e.from);
    (after.get(e.from) ?? after.set(e.from, []).get(e.from)!).push(e.to);
  }

  let order = columns.map((c) => [...c]);
  const pos = new Map<string, number>();
  const index = (cols: readonly string[][]) =>
    cols.forEach((c) => c.forEach((id, i) => pos.set(id, i)));
  const sizes = columns.map((c) => c.length);
  const score = () => {
    let length = 0;
    const spans = forward.map((e) => {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      length += Math.abs(a - b);
      return { ca: colOf.get(e.from)!, cb: colOf.get(e.to)!, a, b };
    });
    return { crossings: countCrossings(spans, sizes), length };
  };
  const reorder = (c: number, neighbours: Map<string, string[]>) => {
    const keyed = order[c]!.map((id, i) => {
      const ns = neighbours.get(id);
      const key = ns?.length ? ns.reduce((n, x) => n + pos.get(x)!, 0) / ns.length : i;
      return { id, i, key };
    });
    keyed.sort((x, y) => x.key - y.key || x.i - y.i);
    order[c] = keyed.map((k) => k.id);
    order[c]!.forEach((id, i) => pos.set(id, i));
  };

  index(order);
  let best = order.map((c) => [...c]);
  let bestScore = score();
  const keep = () => {
    const s = score();
    if (
      s.crossings < bestScore.crossings ||
      (s.crossings === bestScore.crossings && s.length < bestScore.length)
    ) {
      bestScore = s;
      best = order.map((c) => [...c]);
    }
  };
  if (forward.length > 0) {
    for (let sweep = 0; sweep < SWEEPS && bestScore.crossings > 0; sweep++) {
      for (let c = 1; c < order.length; c++) reorder(c, before);
      keep();
      for (let c = order.length - 2; c >= 0; c--) reorder(c, after);
      keep();
    }
  }
  order = best;

  // Rows: near the mean of a card's blockers, in order, inside the tallest column.
  const rows = Math.max(1, ...order.map((c) => c.length));
  const place = new Map<string, { col: number; row: number }>();
  order.forEach((column, col) => {
    const wanted = column.map((id, i) => {
      const ns = (before.get(id) ?? []).filter((x) => place.has(x));
      return ns.length ? Math.round(ns.reduce((n, x) => n + place.get(x)!.row, 0) / ns.length) : i;
    });
    for (let i = 0; i < wanted.length; i++) {
      wanted[i] = Math.max(wanted[i]!, i === 0 ? 0 : wanted[i - 1]! + 1);
    }
    for (let i = wanted.length - 1; i >= 0; i--) {
      const limit = i === wanted.length - 1 ? rows - 1 : wanted[i + 1]! - 1;
      wanted[i] = Math.min(wanted[i]!, limit);
    }
    column.forEach((id, i) => place.set(id, { col, row: wanted[i]! }));
  });
  return { columns: order, place, rows, edges: forward };
}

/** Polyline to an SVG path, with each corner rounded inside its two segments. */
export function roundedPath(points: readonly (readonly [number, number])[]): string {
  const f = (v: number) => String(Math.round(v * 10) / 10);
  const pts = points.filter(
    (p, i) => i === 0 || p[0] !== points[i - 1]![0] || p[1] !== points[i - 1]![1],
  );
  let d = `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]!;
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    const r = Math.min(CORNER, inLen / 2, outLen / 2);
    const ax = x - ((x - px) / inLen) * r;
    const ay = y - ((y - py) / inLen) * r;
    const bx = x + ((nx - x) / outLen) * r;
    const by = y + ((ny - y) / outLen) * r;
    d += ` L${f(ax)},${f(ay)} Q${f(x)},${f(y)} ${f(bx)},${f(by)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${f(last[0])},${f(last[1])}`;
}

interface Leg {
  edge: PlanEdge;
  ca: number;
  ra: number;
  cb: number;
  rb: number;
  kind: 'straight' | 'adjacent' | 'channel';
  channel: number;
  lane: number;
  trunkY: number;
  startY: number;
  endY: number;
  /** Gutter lane x of the first and last vertical runs. */
  x1: number;
  x2: number;
}

interface VerticalRun {
  leg: Leg;
  /** 1: the leg's first vertical; 2: its last. */
  which: 1 | 2;
  top: number;
  bottom: number;
  up: boolean;
  lane: number;
}

/** First-fit lanes for runs in sweep order; `free` says whether a run fits after a lane's last. */
function fitLanes(
  runs: VerticalRun[],
  firstLane: number,
  free: (last: VerticalRun, run: VerticalRun) => boolean,
): number {
  const lanes: VerticalRun[] = [];
  for (const run of runs) {
    let lane = lanes.findIndex((last) => free(last, run));
    if (lane < 0) lane = lanes.length;
    lanes[lane] = run;
    run.lane = firstLane + lane;
  }
  return lanes.length;
}

export function routeMap(
  plan: MapPlan,
  sizes: {
    /** Measured card height; missing or 0 uses an estimate. */
    height: (id: string) => number | undefined;
    /** Height of the column headings. */
    head: number;
    /** Whether a card is on the page yet; arrows wait for both ends. */
    rendered?: (id: string) => boolean;
  },
): RoutedMap {
  const { columns, place, rows } = plan;
  const heightOf = (id: string) => sizes.height(id) || ESTIMATED_HEIGHT;
  const rowHeight = new Array<number>(rows).fill(0);
  const occupied = new Set<number>();
  const cellKey = (col: number, row: number) => col * (rows + 1) + row;
  for (const [id, p] of place) {
    rowHeight[p.row] = Math.max(rowHeight[p.row]!, heightOf(id));
    occupied.add(cellKey(p.col, p.row));
  }
  for (let r = 0; r < rows; r++) rowHeight[r] ||= ESTIMATED_HEIGHT;

  // ---- Classify each arrow, and pick a channel for those that skip a column ----
  const gutters = Math.max(0, columns.length - 1);
  const isRendered = sizes.rendered ?? (() => true);
  const legs: Leg[] = [];
  for (const edge of plan.edges) {
    if (!isRendered(edge.from) || !isRendered(edge.to)) continue;
    const a = place.get(edge.from)!;
    const b = place.get(edge.to)!;
    let clear = a.row === b.row;
    for (let c = a.col + 1; clear && c < b.col; c++) clear = !occupied.has(cellKey(c, a.row));
    const kind = clear ? 'straight' : b.col === a.col + 1 ? 'adjacent' : 'channel';
    legs.push({
      edge,
      ca: a.col,
      ra: a.row,
      cb: b.col,
      rb: b.row,
      kind,
      channel: -1,
      lane: 0,
      trunkY: 0,
      startY: 0,
      endY: 0,
      x1: 0,
      x2: 0,
    });
  }

  const load = new Map<number, Int32Array>();
  const loadOf = (channel: number) => {
    let l = load.get(channel);
    if (!l) load.set(channel, (l = new Int32Array(Math.max(1, gutters))));
    return l;
  };
  const peak = (channel: number, from: number, to: number) => {
    const l = loadOf(channel);
    let max = 0;
    for (let g = from; g <= to; g++) max = Math.max(max, l[g]!);
    return max;
  };
  const trunks = legs
    .filter((l) => l.kind === 'channel')
    .sort((x, y) => x.cb - x.ca - (y.cb - y.ca) || x.ca - y.ca || x.ra - y.ra || x.rb - y.rb);
  for (const leg of trunks) {
    const hi = Math.min(leg.ra, leg.rb);
    const lo = Math.max(leg.ra, leg.rb);
    const options = hi === lo ? [hi, hi + 1] : [hi + 1, lo];
    const mid = (leg.ra + leg.rb + 1) / 2;
    let chosen = options[0]!;
    let bestPeak = peak(chosen, leg.ca, leg.cb - 1);
    for (const o of options.slice(1)) {
      const p = peak(o, leg.ca, leg.cb - 1);
      if (p < bestPeak || (p === bestPeak && Math.abs(o - mid) < Math.abs(chosen - mid))) {
        chosen = o;
        bestPeak = p;
      }
    }
    leg.channel = chosen;
    const l = loadOf(chosen);
    for (let g = leg.ca; g < leg.cb; g++) l[g]!++;
  }

  // ---- Channel lanes (spans in gutter units), then channel and row positions ----
  const channelLegs = new Map<number, Leg[]>();
  for (const leg of trunks) {
    const list = channelLegs.get(leg.channel);
    if (list) list.push(leg);
    else channelLegs.set(leg.channel, [leg]);
  }
  const laneCount = new Array<number>(rows + 1).fill(0);
  for (const [channel, list] of channelLegs) {
    list.sort((x, y) => x.ca - y.ca || x.cb - y.cb || x.rb - y.rb || cmp(x.edge.id, y.edge.id));
    const ends: number[] = [];
    for (const leg of list) {
      let lane = ends.findIndex((end) => end < leg.ca);
      if (lane < 0) lane = ends.length;
      ends[lane] = leg.cb - 1;
      leg.lane = lane;
    }
    laneCount[channel] = ends.length;
  }
  const channelHeight = laneCount.map((n, j) => {
    const needed = n > 0 ? 2 * CHANNEL_PAD + (n - 1) * LANE_Y : 0;
    return j === rows ? needed : Math.max(ROW_GAP_MIN, needed);
  });
  const rowY = new Array<number>(rows).fill(0);
  const channelTop = new Array<number>(rows + 1).fill(0);
  let y = sizes.head;
  for (let r = 0; r < rows; r++) {
    channelTop[r] = y;
    y += channelHeight[r]!;
    rowY[r] = y;
    y += rowHeight[r]!;
  }
  channelTop[rows] = y;
  const height = y + channelHeight[rows]!;
  const rowMid = (r: number) => rowY[r]! + rowHeight[r]! / 2;
  for (const leg of trunks) {
    const n = laneCount[leg.channel]!;
    const start = channelTop[leg.channel]! + (channelHeight[leg.channel]! - (n - 1) * LANE_Y) / 2;
    leg.trunkY = start + leg.lane * LANE_Y;
  }

  // ---- Ports: arrows spread along a card's edge, ordered by where they go ----
  const cardTop = (id: string) => {
    const r = place.get(id)!.row;
    return rowY[r]! + (rowHeight[r]! - heightOf(id)) / 2;
  };
  const outOf = new Map<string, Leg[]>();
  const into = new Map<string, Leg[]>();
  for (const leg of legs) {
    (outOf.get(leg.edge.from) ?? outOf.set(leg.edge.from, []).get(leg.edge.from)!).push(leg);
    (into.get(leg.edge.to) ?? into.set(leg.edge.to, []).get(leg.edge.to)!).push(leg);
  }
  // Cards in a row share a middle and a step. Exits sit on whole steps and entries on half
  // steps, so an arrow leaving one card never lines up with one entering the next.
  const ports: { id: string; leg: Leg; slot: number; set: (l: Leg, y: number) => void }[] = [];
  const planPorts = (
    id: string,
    list: Leg[],
    toward: (l: Leg) => number,
    set: (l: Leg, y: number) => void,
    entry: boolean,
  ) => {
    const sorted = [...list].sort((x, y) => toward(x) - toward(y) || cmp(x.edge.id, y.edge.id));
    const straight = sorted.findIndex((l) => l.kind === 'straight');
    sorted.forEach((leg, i) => {
      let slot: number;
      if (straight >= 0) {
        const off = i - straight;
        slot = !entry || off === 0 ? off : off < 0 ? off + 0.5 : off - 0.5;
      } else {
        slot = entry
          ? i - Math.floor(sorted.length / 2) + 0.5
          : i - Math.floor((sorted.length - 1) / 2);
      }
      ports.push({ id, leg, slot, set });
    });
  };
  for (const [id, list] of outOf) {
    planPorts(
      id,
      list,
      (l) => (l.kind === 'channel' ? l.trunkY : rowMid(l.rb)),
      (l, py) => (l.startY = py),
      false,
    );
  }
  for (const [id, list] of into) {
    planPorts(
      id,
      list,
      (l) => (l.kind === 'channel' ? l.trunkY : rowMid(l.ra)),
      (l, py) => (l.endY = py),
      true,
    );
  }
  const rowReach = new Array<number>(rows).fill(0);
  const rowShortest = new Array<number>(rows).fill(Infinity);
  for (const p of ports) {
    const r = place.get(p.id)!.row;
    rowReach[r] = Math.max(rowReach[r]!, Math.abs(p.slot));
    rowShortest[r] = Math.min(rowShortest[r]!, heightOf(p.id));
  }
  const stepOf = (r: number) =>
    rowReach[r]! > 0
      ? Math.min(PORT_STEP, Math.max(0, rowShortest[r]! / 2 - PORT_INSET) / rowReach[r]!)
      : 0;
  for (const p of ports) {
    const r = place.get(p.id)!.row;
    p.set(p.leg, rowMid(r) + p.slot * stepOf(r));
  }

  // ---- Gutter lanes, then column positions ----
  const runsIn: VerticalRun[][] = Array.from({ length: gutters }, () => []);
  const addRun = (g: number, leg: Leg, which: 1 | 2, from: number, to: number) => {
    runsIn[g]!.push({
      leg,
      which,
      top: Math.min(from, to),
      bottom: Math.max(from, to),
      up: to < from,
      lane: 0,
    });
  };
  for (const leg of legs) {
    if (leg.kind === 'adjacent') addRun(leg.ca, leg, 1, leg.startY, leg.endY);
    else if (leg.kind === 'channel') {
      addRun(leg.ca, leg, 1, leg.startY, leg.trunkY);
      addRun(leg.cb - 1, leg, 2, leg.trunkY, leg.endY);
    }
  }
  const tie = (x: VerticalRun, y: VerticalRun) =>
    cmp(x.leg.edge.id, y.leg.edge.id) || x.which - y.which;
  const gutterWidth = new Array<number>(gutters).fill(GUTTER_MIN);
  const gutterLanes = new Array<number>(gutters).fill(0);
  runsIn.forEach((runs, g) => {
    // Rising runs take the left lanes top first, falling ones bottom first: fewer crossings.
    const up = runs
      .filter((r) => r.up)
      .sort((x, z) => x.top - z.top || x.bottom - z.bottom || tie(x, z));
    const down = runs
      .filter((r) => !r.up)
      .sort((x, z) => z.bottom - x.bottom || z.top - x.top || tie(x, z));
    const nUp = fitLanes(up, 0, (last, run) => last.bottom + LANE_CLEARANCE < run.top);
    const nDown = fitLanes(down, nUp, (last, run) => last.top - LANE_CLEARANCE > run.bottom);
    const n = nUp + nDown;
    gutterLanes[g] = n;
    gutterWidth[g] = Math.max(GUTTER_MIN, 2 * GUTTER_PAD + Math.max(0, n - 1) * LANE_X);
  });
  const columnX: number[] = [];
  let x = 0;
  for (let c = 0; c < columns.length; c++) {
    columnX.push(x);
    x += CARD_WIDTH + (gutterWidth[c] ?? 0);
  }
  const width = columns.length > 0 ? columnX[columns.length - 1]! + CARD_WIDTH : 0;
  runsIn.forEach((runs, g) => {
    const n = gutterLanes[g]!;
    const start = columnX[g]! + CARD_WIDTH + (gutterWidth[g]! - (n - 1) * LANE_X) / 2;
    for (const run of runs) {
      const laneX = start + run.lane * LANE_X;
      if (run.which === 1) run.leg.x1 = laneX;
      else run.leg.x2 = laneX;
    }
  });

  // ---- Boxes and paths ----
  const cards = new Map<string, CardBox>();
  for (const [id, p] of place) {
    cards.set(id, {
      x: columnX[p.col]!,
      y: cardTop(id),
      width: CARD_WIDTH,
      height: heightOf(id),
    });
  }
  const arrows: RoutedArrow[] = legs.map((leg) => {
    const ax = columnX[leg.ca]! + CARD_WIDTH;
    const bx = columnX[leg.cb]! - ARROW_END;
    const { startY: sy, endY: ey } = leg;
    const points: [number, number][] =
      leg.kind === 'straight'
        ? [
            [ax, sy],
            [bx, ey],
          ]
        : leg.kind === 'adjacent'
          ? [
              [ax, sy],
              [leg.x1, sy],
              [leg.x1, ey],
              [bx, ey],
            ]
          : [
              [ax, sy],
              [leg.x1, sy],
              [leg.x1, leg.trunkY],
              [leg.x2, leg.trunkY],
              [leg.x2, ey],
              [bx, ey],
            ];
    return { id: leg.edge.id, from: leg.edge.from, to: leg.edge.to, d: roundedPath(points) };
  });
  return { width, height, columnX, cards, arrows };
}
