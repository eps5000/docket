/**
 * Map routing (B47; UI_SPEC §6.3.4). The hard rule: no point of an arrow is
 * inside a card, checked by sampling the real SVG paths for a Gameflow-like
 * epic, the STR stress epic's shape and seeded random DAGs. Also: the layout
 * is deterministic, arrows spread across a card's edge, parallel runs get
 * their own lanes, and the largest supported map routes quickly.
 */
import { describe, expect, it } from 'vitest';
import type { LinkEdge, Status } from '@docket/shared';
import { layoutMap, type MapItem } from './layout';
import {
  CARD_WIDTH,
  GUTTER_MIN,
  ROW_GAP_MIN,
  planMap,
  roundedPath,
  routeMap,
  type CardBox,
  type PlanEdge,
  type RoutedMap,
} from './routing';

type Point = readonly [number, number];

/** Every point of an SVG path made of M, L and Q commands, about 1 px apart. */
function samplePath(d: string): Point[] {
  const tokens = d.match(/[MLQ]|-?\d+(?:\.\d+)?/g)!;
  const out: Point[] = [];
  let at: Point = [0, 0];
  const num = (i: number) => Number(tokens[i]);
  for (let i = 0; i < tokens.length;) {
    const cmd = tokens[i]!;
    if (cmd === 'M') {
      at = [num(i + 1), num(i + 2)];
      out.push(at);
      i += 3;
    } else if (cmd === 'L') {
      const to: Point = [num(i + 1), num(i + 2)];
      const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - at[0], to[1] - at[1])));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        out.push([at[0] + (to[0] - at[0]) * t, at[1] + (to[1] - at[1]) * t]);
      }
      at = to;
      i += 3;
    } else {
      const c: Point = [num(i + 1), num(i + 2)];
      const to: Point = [num(i + 3), num(i + 4)];
      for (let s = 1; s <= 16; s++) {
        const t = s / 16;
        const u = 1 - t;
        out.push([
          u * u * at[0] + 2 * u * t * c[0] + t * t * to[0],
          u * u * at[1] + 2 * u * t * c[1] + t * t * to[1],
        ]);
      }
      at = to;
      i += 5;
    }
  }
  return out;
}

const inside = ([x, y]: Point, b: CardBox) =>
  x > b.x + 0.5 && x < b.x + b.width - 0.5 && y > b.y + 0.5 && y < b.y + b.height - 0.5;

/** Arrows that enter a card, as "arrow → card". Endpoints count too: an arrow stops at the edge. */
function violations(map: RoutedMap): string[] {
  const out: string[] = [];
  const boxes = [...map.cards];
  for (const a of map.arrows) {
    const pts = samplePath(a.d);
    for (const [id, box] of boxes) {
      if (pts.some((p) => inside(p, box))) out.push(`${a.from}>${a.to} → ${id}`);
    }
  }
  return out;
}

function overlappingCards(map: RoutedMap): string[] {
  const boxes = [...map.cards];
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [ia, a] = boxes[i]!;
      const [ib, b] = boxes[j]!;
      if (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      )
        out.push(`${ia}/${ib}`);
    }
  }
  return out;
}

/** Pairs of arrows with a stretch of more than 1 px on one horizontal or vertical line. */
function sharedRuns(map: RoutedMap): string[] {
  const lines = new Map<string, { lo: number; hi: number; id: string }[]>();
  for (const a of map.arrows) {
    const pts = samplePath(a.d);
    let start = 0;
    const flush = (end: number) => {
      if (end <= start) return;
      const [x0, y0] = pts[start]!;
      const [x1, y1] = pts[end]!;
      if (x0 !== x1 && y0 !== y1) return;
      const vertical = x0 === x1;
      const key = vertical ? `v${x0.toFixed(1)}` : `h${y0.toFixed(1)}`;
      const [p, q] = vertical ? [y0, y1] : [x0, x1];
      const run = { lo: Math.min(p, q), hi: Math.max(p, q), id: a.id };
      const list = lines.get(key);
      if (list) list.push(run);
      else lines.set(key, [run]);
    };
    // Only the straight stretches: a rounded corner's samples move on both axes.
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[start]!;
      const [bx, by] = pts[i]!;
      if (ax !== bx && ay !== by) {
        flush(i - 1);
        start = i;
      }
    }
    flush(pts.length - 1);
  }
  const out: string[] = [];
  for (const [key, runs] of lines) {
    runs.sort((x, y) => x.lo - y.lo);
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length && runs[j]!.lo < runs[i]!.hi - 1; j++) {
        if (runs[i]!.id !== runs[j]!.id && Math.min(runs[i]!.hi, runs[j]!.hi) - runs[j]!.lo > 1)
          out.push(`${key}: ${runs[i]!.id}/${runs[j]!.id}`);
      }
    }
  }
  return out;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const item = (id: string, status: Status = 'ready'): MapItem =>
  ({
    id,
    project: id.split('-')[0]!,
    type: 'Story',
    title: id,
    status,
    priority: 2,
    epic: null,
    epic_title: null,
    labels: [],
    blocked: false,
    blocked_by: [],
    unblocks: 0,
    lead: null,
    human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
    planned_start: null,
    planned_end: null,
    effort: null,
    archived: false,
    jira_key: null,
    version: 1,
    updated_at: '2026-11-06T10:00:00.000Z',
  }) as MapItem;

const link = (from: string, to: string, i: number): LinkEdge => ({
  link_id: `lnk_${i}`,
  from,
  to,
  type: 'blocks',
  satisfied_when: 'done',
  cleared: false,
});

/** Cards of varied heights, as real titles give them, stable per ID. */
function heightsFor(ids: readonly string[], seed = 7) {
  const r = rng(seed);
  const h = new Map(ids.map((id) => [id, 56 + Math.floor(r() * 50)]));
  return (id: string) => h.get(id);
}

function route(ids: readonly string[], links: readonly LinkEdge[], seed = 7) {
  const l = layoutMap(
    ids.map((id) => item(id)),
    [],
    links,
  );
  const plan = planMap(
    l.waves.map((w) => w.map((i) => i.id)),
    l.edges.map((e) => ({ id: e.link_id, from: e.from, to: e.to })),
  );
  return { l, plan, map: routeMap(plan, { height: heightsFor(ids, seed), head: 32 }) };
}

/** Shaped like the Gameflow pilot's epic: 15 items, 8 waves, several wave-skipping links. */
const GF = Array.from({ length: 15 }, (_, i) => `GF-${221 + i}`);
const GF_LINKS: [number, number][] = [
  [221, 222],
  [222, 223],
  [223, 224],
  [224, 225],
  [225, 226],
  [226, 227],
  [227, 228],
  [221, 229],
  [229, 230],
  [222, 231], // GF-231 skips waves, like the pilot's
  [221, 231],
  [231, 228],
  [223, 232],
  [232, 227],
  [221, 233],
  [233, 226],
  [224, 234],
  [230, 234],
  [234, 228],
  [229, 235],
  [235, 225],
  [222, 228],
];
const gfLinks = GF_LINKS.map(([a, b], i) => link(`GF-${a}`, `GF-${b}`, i));

/** The STR stress epic's shape: 34 tickets, a chain, a fan-in, and links across waves. */
const STR = Array.from({ length: 34 }, (_, i) => `STR-${12 + i}`);
const strLinks = [
  [18, 19],
  [19, 20],
  [20, 21],
  [21, 22],
  [12, 30],
  [13, 30],
  [14, 30],
  [15, 30],
  [16, 30],
  [30, 31],
  [31, 40],
  [18, 40],
  [12, 22],
  [13, 21],
  [23, 24],
  [24, 45],
  [12, 45],
  [19, 45],
  [33, 34],
  [34, 35],
  [33, 35],
  [35, 22],
  [36, 20],
  [37, 45],
].map(([a, b], i) => link(`STR-${a}`, `STR-${b}`, i));

function randomDag(seed: number) {
  const r = rng(seed);
  const n = 2 + Math.floor(r() * 59);
  const ids = Array.from({ length: n }, (_, i) => `R-${i + 1}`);
  const density = 0.5 + r() * 2.5;
  const links: LinkEdge[] = [];
  const seen = new Set<string>();
  const tries = Math.floor(n * density);
  for (let t = 0; t < tries; t++) {
    const a = Math.floor(r() * n);
    const b = Math.floor(r() * n);
    if (a === b) continue;
    const [from, to] = a < b ? [a, b] : [b, a];
    const key = `${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link(ids[from]!, ids[to]!, links.length));
  }
  return { ids, links };
}

describe('arrows never cross a card', () => {
  it('a Gameflow-like epic: 15 items, 8 waves, wave-skipping links', () => {
    const { l, map } = route(GF, gfLinks);
    expect(l.waves.length).toBe(8);
    expect(map.arrows.length).toBe(gfLinks.length);
    expect(violations(map)).toEqual([]);
    expect(overlappingCards(map)).toEqual([]);
  });

  it('the STR stress epic: 34 tickets', () => {
    const { map } = route(STR, strLinks);
    expect(map.cards.size).toBe(34);
    expect(map.arrows.length).toBe(strLinks.length);
    expect(violations(map)).toEqual([]);
    expect(overlappingCards(map)).toEqual([]);
  });

  it('200 seeded random DAGs', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { ids, links } = randomDag(seed);
      const { map } = route(ids, links, seed);
      expect(map.arrows.length, `seed ${seed}`).toBe(links.length);
      expect(violations(map), `seed ${seed}`).toEqual([]);
      expect(overlappingCards(map), `seed ${seed}`).toEqual([]);
    }
  });

  it('arrows start on the blocker’s right edge and stop just before the blocked card', () => {
    const { map } = route(GF, gfLinks);
    for (const a of map.arrows) {
      const pts = samplePath(a.d);
      const from = map.cards.get(a.from)!;
      const to = map.cards.get(a.to)!;
      const [sx, sy] = pts[0]!;
      const [ex, ey] = pts[pts.length - 1]!;
      expect(sx).toBeCloseTo(from.x + from.width, 1);
      expect(sy).toBeGreaterThan(from.y);
      expect(sy).toBeLessThan(from.y + from.height);
      expect(ex).toBeCloseTo(to.x - 3, 1);
      expect(ey).toBeGreaterThan(to.y);
      expect(ey).toBeLessThan(to.y + to.height);
    }
  });
});

describe('a readable layout', () => {
  it('is deterministic, whatever order the links arrive in', () => {
    const snapshot = (links: readonly LinkEdge[]) => {
      const { plan, map } = route(GF, links);
      return JSON.stringify({ columns: plan.columns, arrows: map.arrows, cards: [...map.cards] });
    };
    const first = snapshot(gfLinks);
    expect(snapshot(gfLinks)).toBe(first);
    const r = rng(47);
    const shuffled = [...gfLinks]
      .map((l) => ({ l, k: r() }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.l);
    expect(snapshot(shuffled)).toBe(first);
  });

  it('the barycenter pass untangles a crossed pair', () => {
    const plan = planMap(
      [
        ['A-1', 'A-2'],
        ['B-1', 'B-2'],
      ],
      [
        { id: 'x', from: 'A-1', to: 'B-2' },
        { id: 'y', from: 'A-2', to: 'B-1' },
      ],
    );
    const row = (id: string) => plan.place.get(id)!.row;
    expect(row('A-1') < row('A-2')).toBe(row('B-2') < row('B-1'));
  });

  it('a straight run stays straight, along a row that is empty between its cards', () => {
    const plan = planMap([['A-1'], ['B-1'], ['C-1']], [{ id: 'x', from: 'A-1', to: 'C-1' }]);
    // B-1 shares the row, so this arrow takes a channel around it.
    const around = routeMap(plan, { height: () => 60, head: 30 });
    expect(around.arrows[0]!.d).toContain('Q');
    expect(violations(around)).toEqual([]);
    const clear = planMap([['A-1'], ['C-1']], [{ id: 'x', from: 'A-1', to: 'C-1' }]);
    const direct = routeMap(clear, { height: () => 60, head: 30 });
    expect(direct.arrows[0]!.d).not.toContain('Q');
  });

  it('spreads arrows across a card’s edge instead of one point', () => {
    const plan = planMap(
      [['A-1'], ['B-1', 'B-2', 'B-3', 'B-4']],
      ['B-1', 'B-2', 'B-3', 'B-4'].map((to, i) => ({ id: `e${i}`, from: 'A-1', to })),
    );
    const map = routeMap(plan, { height: () => 70, head: 30 });
    const starts = map.arrows.map((a) => samplePath(a.d)[0]![1]);
    expect(new Set(starts).size).toBe(4);
  });

  it('widens a gutter for the lanes it carries', () => {
    const left = Array.from({ length: 6 }, (_, i) => `A-${i + 1}`);
    const right = Array.from({ length: 6 }, (_, i) => `B-${i + 1}`);
    const edges: PlanEdge[] = left.flatMap((from, i) =>
      right.map((to, j) => ({ id: `e${i}-${j}`, from, to })),
    );
    const map = routeMap(planMap([left, right], edges), { height: () => 70, head: 30 });
    expect(map.columnX[1]! - CARD_WIDTH).toBeGreaterThan(GUTTER_MIN);
    expect(violations(map)).toEqual([]);
    expect(sharedRuns(map)).toEqual([]);
  });

  it('no two arrows run along the same line', () => {
    expect(sharedRuns(route(GF, gfLinks).map)).toEqual([]);
    expect(sharedRuns(route(STR, strLinks).map)).toEqual([]);
    for (let seed = 1; seed <= 60; seed++) {
      const { ids, links } = randomDag(seed);
      expect(sharedRuns(route(ids, links, seed).map), `seed ${seed}`).toEqual([]);
    }
  });

  it('keeps the minimum spacing when nothing needs more', () => {
    const map = routeMap(planMap([['A-1'], ['B-1']], []), { height: () => 60, head: 30 });
    expect(map.columnX).toEqual([0, CARD_WIDTH + GUTTER_MIN]);
    expect(map.cards.get('A-1')!.y).toBe(30 + ROW_GAP_MIN);
  });

  it('waits for both ends of an arrow while a long map renders progressively', () => {
    const plan = planMap([['A-1'], ['B-1']], [{ id: 'x', from: 'A-1', to: 'B-1' }]);
    const map = routeMap(plan, {
      height: () => 60,
      head: 30,
      rendered: (id) => id === 'A-1',
    });
    expect(map.arrows).toEqual([]);
  });

  it('rounds corners inside their segments', () => {
    expect(
      roundedPath([
        [0, 0],
        [20, 0],
        [20, 20],
      ]),
    ).toBe('M0,0 L14,0 Q20,0 20,6 L20,20');
  });
});

describe('performance', () => {
  it('routes the largest supported map quickly', () => {
    const r = rng(5000);
    const waves = 12;
    const n = 5000;
    const columns: string[][] = Array.from({ length: waves }, () => []);
    const ids = Array.from({ length: n }, (_, i) => `P-${i + 1}`);
    ids.forEach((id, i) => columns[i % waves]!.push(id));
    const edges: PlanEdge[] = [];
    for (let i = 0; i < 6000; i++) {
      const ca = Math.floor(r() * (waves - 1));
      const cb = ca + 1 + Math.floor(r() * Math.min(3, waves - ca - 1));
      const from = columns[ca]![Math.floor(r() * columns[ca]!.length)]!;
      const to = columns[cb]![Math.floor(r() * columns[cb]!.length)]!;
      edges.push({ id: `e${i}`, from, to });
    }
    const started = performance.now();
    const map = routeMap(planMap(columns, edges), { height: () => 70, head: 32 });
    const elapsed = performance.now() - started;
    console.log(`B47 routing: ${n} cards, ${map.arrows.length} arrows, ${elapsed.toFixed(0)} ms`);
    expect(map.arrows.length).toBe(6000);
    expect(elapsed).toBeLessThan(2500);

    const epicStart = performance.now();
    route(STR, strLinks);
    const epicMs = performance.now() - epicStart;
    console.log(`B47 routing: the 34-ticket epic, ${epicMs.toFixed(1)} ms`);
    expect(epicMs).toBeLessThan(50);
  });
});
