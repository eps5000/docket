/**
 * The progress map's layout, as pure data (UI_SPEC §6.3.4): which column
 * each card goes in, which arrows to draw, and the header counts. The
 * blocked state itself comes from the server (`ItemSummary.blocked`, from
 * the one evaluator); this only places things.
 *
 * - **Waves:** wave index = the longest `blocks` path from a root within the
 *   scope set (wave 1: nothing in scope blocks these).
 * - **Outside:** blockers of scope items that aren't in scope ("Outside this
 *   epic / blocks work here"), drawn first.
 * - **Cycle:** members of a `blocks` cycle inside the scope can't be placed
 *   in a wave; they get their own column, and the links between them aren't
 *   drawn (the Dependencies tab fixes them).
 */
import type { ItemSummary, LinkEdge, Status } from '@docket/shared';

/** A card on the map: a summary, plus whether its packet is ready (Work rows know it). */
export type MapItem = ItemSummary & { packet_ready?: boolean };

export interface MapEdge {
  link_id: string;
  from: string;
  to: string;
  /** Dashed green when the blocker no longer blocks. */
  cleared: boolean;
}

export interface MapLayout {
  /** In-scope cards that are counted (canceled items are left out of the counts). */
  scope: MapItem[];
  outside: MapItem[];
  waves: MapItem[][];
  cycle: MapItem[];
  edges: MapEdge[];
  counts: {
    total: number;
    done: number;
    byStatus: Partial<Record<Status, number>>;
    readyButBlocked: number;
    readyToStart: number;
    /** 1-based; null when every wave is done or there is only one. */
    workingOnWave: number | null;
  };
}

/** Bar and legend order (UI_SPEC §6.3.4). */
export const BAR_ORDER = ['done', 'review', 'progress', 'ready', 'planning', 'inbox'] as const;

const CARD_ORDER: Record<Status, number> = {
  done: 0,
  review: 1,
  progress: 2,
  ready: 3,
  planning: 4,
  inbox: 5,
  canceled: 6,
};

/** `RCP-9` before `RCP-10`. */
export function compareIds(a: string, b: string): number {
  const [pa, na] = a.split('-');
  const [pb, nb] = b.split('-');
  return pa === pb ? Number(na) - Number(nb) : pa! < pb! ? -1 : 1;
}

/** Strongly connected components larger than one node, over `next` (Tarjan, iterative). */
export function stronglyConnected(
  nodes: readonly string[],
  next: (id: string) => readonly string[],
): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (order.has(root)) continue;
    const work: { id: string; edges: readonly string[]; i: number }[] = [];
    const visit = (id: string) => {
      order.set(id, counter);
      low.set(id, counter);
      counter++;
      stack.push(id);
      onStack.add(id);
      work.push({ id, edges: next(id), i: 0 });
    };
    visit(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.edges.length) {
        const to = frame.edges[frame.i++]!;
        if (!order.has(to)) visit(to);
        else if (onStack.has(to)) low.set(frame.id, Math.min(low.get(frame.id)!, order.get(to)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === order.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const x = stack.pop()!;
          onStack.delete(x);
          component.push(x);
          if (x === frame.id) break;
        }
        if (component.length > 1) out.push(component.sort(compareIds));
      }
    }
  }
  return out;
}

/** The cycles among `blocks` links (each sorted by ID). */
export function cyclesIn(links: readonly LinkEdge[]): string[][] {
  const next = new Map<string, string[]>();
  for (const l of links) {
    if (l.type !== 'blocks') continue;
    next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
  }
  return stronglyConnected([...next.keys()].sort(compareIds), (id) => next.get(id) ?? []);
}

/** A real path around a cycle from its first ID: `A → B → C → A`. */
export function cyclePath(component: readonly string[], links: readonly LinkEdge[]): string[] {
  const members = new Set(component);
  const start = component[0]!;
  const prev = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const l of links) {
      if (l.type !== 'blocks' || l.from !== id || !members.has(l.to)) continue;
      if (l.to === start) {
        const path = [start];
        for (let at: string | null = id; at !== null; at = prev.get(at) ?? null) path.push(at);
        return path.reverse();
      }
      if (!prev.has(l.to)) {
        prev.set(l.to, id);
        queue.push(l.to);
      }
    }
  }
  return [...component, start];
}

const byCard = (a: MapItem, b: MapItem) =>
  CARD_ORDER[a.status] - CARD_ORDER[b.status] || compareIds(a.id, b.id);

export function layoutMap(
  items: readonly MapItem[],
  outsideItems: readonly MapItem[],
  links: readonly LinkEdge[],
): MapLayout {
  const blocks = links.filter((l) => l.type === 'blocks');
  const inScope = new Map(items.map((i) => [i.id, i]));
  // A canceled item stays on the map only while it still blocks something here.
  const blocksHere = new Set(
    blocks
      .filter((l) => inScope.has(l.to) && inScope.get(l.to)!.status !== 'canceled')
      .map((l) => l.from),
  );
  const placed = items.filter((i) => i.status !== 'canceled' || blocksHere.has(i.id));
  const placedIds = new Set(placed.map((i) => i.id));
  const among = blocks.filter((l) => placedIds.has(l.from) && placedIds.has(l.to));

  const cycleIds = new Set(cyclesIn(among).flat());
  const blockersOf = new Map<string, string[]>();
  for (const l of among) {
    if (cycleIds.has(l.from) || cycleIds.has(l.to)) continue;
    blockersOf.set(l.to, [...(blockersOf.get(l.to) ?? []), l.from]);
  }
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    depth.set(id, 0); // Guards against anything cyclic that slipped through.
    const bs = blockersOf.get(id) ?? [];
    const d = bs.length === 0 ? 0 : 1 + Math.max(...bs.map(depthOf));
    depth.set(id, d);
    return d;
  };
  const waves: MapItem[][] = [];
  for (const i of placed) {
    if (cycleIds.has(i.id)) continue;
    const d = depthOf(i.id);
    (waves[d] ??= []).push(i);
  }
  const denseWaves = waves.filter((w) => w && w.length > 0).map((w) => w.sort(byCard));
  const cycle = placed.filter((i) => cycleIds.has(i.id)).sort(byCard);

  const outsideById = new Map(outsideItems.map((i) => [i.id, i]));
  const outsideIds = new Set(
    blocks
      .filter((l) => placedIds.has(l.to) && !placedIds.has(l.from) && outsideById.has(l.from))
      .map((l) => l.from),
  );
  const outside = [...outsideIds].map((id) => outsideById.get(id)!).sort(byCard);

  const edges: MapEdge[] = blocks
    .filter(
      (l) =>
        placedIds.has(l.to) &&
        (placedIds.has(l.from) || outsideIds.has(l.from)) &&
        !(cycleIds.has(l.from) && cycleIds.has(l.to)),
    )
    .map((l) => ({ link_id: l.link_id, from: l.from, to: l.to, cleared: l.cleared === true }));

  const counted = placed.filter((i) => i.status !== 'canceled');
  const byStatus: Partial<Record<Status, number>> = {};
  for (const i of counted) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
  const next = denseWaves.findIndex((w) => w.some((i) => i.status !== 'done'));
  return {
    scope: counted,
    outside,
    waves: denseWaves,
    cycle,
    edges,
    counts: {
      total: counted.length,
      done: byStatus.done ?? 0,
      byStatus,
      readyButBlocked: counted.filter((i) => i.status === 'ready' && i.blocked).length,
      readyToStart: counted.filter((i) => i.status === 'ready' && !i.blocked && i.lead === null)
        .length,
      workingOnWave: next >= 0 && denseWaves.length > 1 ? next + 1 : null,
    },
  };
}

/** Zoom steps (UI_SPEC §6.3.4). Fit goes down to `FIT_MIN`. */
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25] as const;
export const FIT_MIN = 0.4;

/** The next zoom step in `dir` from `current` (which may be a Fit value between steps). */
export function stepZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS.at(-1)!;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0];
}

/** The Fit zoom: everything visible, never above 100% or below 40%. */
export function fitZoom(
  content: { width: number; height: number },
  view: { width: number; height: number },
): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  return Math.max(FIT_MIN, Math.min(1, view.width / content.width, view.height / content.height));
}

/** A cubic curve from the right edge of the blocker to the left edge of the blocked card. */
export function arrowPath(
  a: { right: number; midY: number },
  b: { left: number; midY: number },
): string {
  const mx = (a.right + b.left) / 2;
  return `M${a.right},${a.midY} C${mx},${a.midY} ${mx},${b.midY} ${b.left - 3},${b.midY}`;
}

/** The gap between columns (UI_SPEC §6.3.4), in unscaled pixels. */
const COL_GAP = 76;

/** Whether an arrow from `a` to `b` skips at least one column (and so crosses its cards). */
export function skipsColumn(a: { right: number }, b: { left: number }): boolean {
  return b.left - a.right > COL_GAP + 1;
}
