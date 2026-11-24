/**
 * Implied links (owner decision 60, B77): which arrows the map can leave out
 * because a longer chain of other arrows already connects the same two
 * tickets. Display only: links are never changed, and this is recomputed
 * from the arrows currently drawn, so a broken chain brings the direct arrow
 * back on its own.
 *
 * - **Strength.** A link still blocking (hard, not cleared) is hidden only by
 *   a chain of links that still block; a cleared hard link only by a chain of
 *   hard links; a soft (`relates`) link by any chain. A hard dependency never
 *   disappears behind soft ones, and one that still blocks never disappears
 *   behind cleared ones.
 * - **Canceled tickets** (`skip`) don't carry a chain: a canceled middle
 *   ticket brings the direct arrow back.
 * - **Cycles.** A link with an end inside a cycle is always drawn. Hiding by
 *   reachability inside a cycle could hide every link of it; outside cycles
 *   the reduction is unique and keeps every connection (a hidden link's chain
 *   is made of links that are drawn, or hidden by shorter chains).
 * - `keep` links (the critical path's) are always drawn.
 */
import { useCallback, useState } from 'react';
import { readString, STORAGE_KEYS, writeString } from '../../lib/persistence';
import { compareIds, stronglyConnected, type MapLayout } from './layout';

export interface ChainEdge {
  link_id: string;
  from: string;
  to: string;
  /** `blocks` (hard) or `relates` (soft). */
  hard: boolean;
  /** A hard link whose blocker no longer blocks. */
  cleared: boolean;
}

export interface ImpliedOptions {
  /** Tickets a chain can't pass through (canceled ones). */
  skip?: (id: string) => boolean;
  /** Links that are always drawn. */
  keep?: (linkId: string) => boolean;
}

const strength = (e: ChainEdge) => (e.hard ? (e.cleared ? 1 : 2) : 0);

/**
 * Link ID → the middle tickets of one shortest chain that implies it
 * (`['GF-2']` for GF-1 → GF-2 → GF-3). Links not in the map are drawn.
 */
export function impliedLinks(
  edges: readonly ChainEdge[],
  { skip = () => false, keep = () => false }: ImpliedOptions = {},
): Map<string, string[]> {
  const out = new Map<string, ChainEdge[]>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const list = out.get(e.from);
    if (list) list.push(e);
    else out.set(e.from, [e]);
  }
  const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort(compareIds);
  const inCycle = new Set(
    stronglyConnected(nodes, (id) => (out.get(id) ?? []).map((e) => e.to)).flat(),
  );

  const hidden = new Map<string, string[]>();
  for (const e of edges) {
    const { from: u, to: v } = e;
    if (u === v || inCycle.has(u) || inCycle.has(v) || keep(e.link_id)) continue;
    const min = strength(e);
    const strong = (f: ChainEdge) => strength(f) >= min;
    // Breadth-first from u's other strong links, so the chain found is a shortest one.
    const parent = new Map<string, string>();
    const queue: string[] = [];
    for (const f of out.get(u) ?? []) {
      if (f.to === v || f.to === u || !strong(f) || skip(f.to) || parent.has(f.to)) continue;
      parent.set(f.to, u);
      queue.push(f.to);
    }
    let found: string | null = null;
    for (let i = 0; i < queue.length && found === null; i++) {
      const w = queue[i]!;
      for (const g of out.get(w) ?? []) {
        if (!strong(g)) continue;
        if (g.to === v) {
          found = w;
          break;
        }
        if (g.to === u || parent.has(g.to) || skip(g.to)) continue;
        parent.set(g.to, w);
        queue.push(g.to);
      }
    }
    if (found === null) continue;
    const through: string[] = [];
    for (let at: string = found; at !== u; at = parent.get(at)!) through.push(at);
    hidden.set(e.link_id, through.reverse());
  }
  return hidden;
}

/**
 * The links a map hides (decision 60): every arrow the map draws is a `blocks`
 * link, and canceled tickets on it don't carry a chain. The item page uses the
 * same call on the epic's map, so its note always matches the picture.
 */
export function impliedOnMap(
  layout: Pick<MapLayout, 'edges' | 'outside' | 'waves' | 'cycle'>,
  keep?: (linkId: string) => boolean,
): Map<string, string[]> {
  const canceled = new Set(
    [...layout.outside, ...layout.waves.flat(), ...layout.cycle]
      .filter((i) => i.status === 'canceled')
      .map((i) => i.id),
  );
  return impliedLinks(
    layout.edges.map((e) => ({ ...e, hard: true })),
    { skip: (id) => canceled.has(id), keep },
  );
}

/** "GF-2" or "GF-2 → GF-5": a hidden link's chain, for the item page's note. */
export const throughText = (through: readonly string[]) => through.join(' → ');

/** The switch's description (decision 60), as its tooltip and accessible description. */
export const HIDE_IMPLIED_HELP =
  'Hides an arrow when a chain of other arrows already connects the same two tickets.';

/** This viewer's "Hide implied links" setting: on unless they turned it off. */
export function readHideImplied(): boolean {
  return readString(STORAGE_KEYS.mapHideImplied) !== 'off';
}

export function useHideImplied(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readHideImplied);
  const choose = useCallback((next: boolean) => {
    setOn(next);
    // Only the change from the default is stored.
    writeString(STORAGE_KEYS.mapHideImplied, next ? null : 'off');
  }, []);
  return [on, choose];
}
