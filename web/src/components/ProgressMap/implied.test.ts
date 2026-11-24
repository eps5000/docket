/**
 * Implied links (owner decision 60, B77): the transitive reduction of what
 * the map draws. Synthetic tickets only.
 */
import { describe, expect, it } from 'vitest';
import type { LinkEdge, Status } from '@docket/shared';
import { impliedLinks, impliedOnMap, throughText, type ChainEdge } from './implied';
import { layoutMap, type MapItem } from './layout';

const hard = (from: string, to: string, cleared = false): ChainEdge => ({
  link_id: `${from}>${to}`,
  from,
  to,
  hard: true,
  cleared,
});
const soft = (from: string, to: string): ChainEdge => ({
  link_id: `${from}~${to}`,
  from,
  to,
  hard: false,
  cleared: false,
});
/** The hidden links, as `id: through`. */
const hiddenOf = (edges: ChainEdge[], opts?: Parameters<typeof impliedLinks>[1]) =>
  Object.fromEntries([...impliedLinks(edges, opts)].map(([id, t]) => [id, throughText(t)]));

describe('impliedLinks', () => {
  it('a chain: C waits on B, B on A, so A → C is implied through B', () => {
    expect(hiddenOf([hard('T-1', 'T-2'), hard('T-2', 'T-3'), hard('T-1', 'T-3')])).toEqual({
      'T-1>T-3': 'T-2',
    });
  });

  it('a longer chain names every middle ticket, and only the direct link hides', () => {
    expect(
      hiddenOf([hard('T-1', 'T-2'), hard('T-2', 'T-3'), hard('T-3', 'T-4'), hard('T-1', 'T-4')]),
    ).toEqual({ 'T-1>T-4': 'T-2 → T-3' });
  });

  it('a diamond keeps all four sides and hides only the shortcut across it', () => {
    const diamond = [
      hard('T-1', 'T-2'),
      hard('T-1', 'T-3'),
      hard('T-2', 'T-4'),
      hard('T-3', 'T-4'),
    ];
    expect(hiddenOf(diamond)).toEqual({});
    expect(Object.keys(hiddenOf([...diamond, hard('T-1', 'T-4')]))).toEqual(['T-1>T-4']);
  });

  it('a cycle doesn’t crash and hides none of its links, even fully cross-linked', () => {
    const triangle = [hard('T-1', 'T-2'), hard('T-2', 'T-3'), hard('T-3', 'T-1')];
    expect(hiddenOf(triangle)).toEqual({});
    const complete = ['T-1', 'T-2', 'T-3'].flatMap((a) =>
      ['T-1', 'T-2', 'T-3'].filter((b) => b !== a).map((b) => hard(a, b)),
    );
    expect(hiddenOf(complete)).toEqual({});
    // A self-link is drawn too.
    expect(hiddenOf([hard('T-1', 'T-1')])).toEqual({});
  });

  it('a chain through a cycle still implies a link between tickets outside it', () => {
    const edges = [
      hard('T-1', 'T-2'),
      hard('T-2', 'T-3'),
      hard('T-3', 'T-2'),
      hard('T-3', 'T-4'),
      hard('T-1', 'T-4'),
    ];
    expect(hiddenOf(edges)).toEqual({ 'T-1>T-4': 'T-2 → T-3' });
  });

  it('a hard link behind a chain of soft links is kept', () => {
    expect(hiddenOf([soft('T-1', 'T-2'), soft('T-2', 'T-3'), hard('T-1', 'T-3')])).toEqual({});
    // One soft link in the chain is enough to keep it.
    expect(hiddenOf([hard('T-1', 'T-2'), soft('T-2', 'T-3'), hard('T-1', 'T-3')])).toEqual({});
  });

  it('a soft link behind a chain of hard links is hidden, and behind soft ones too', () => {
    expect(hiddenOf([hard('T-1', 'T-2'), hard('T-2', 'T-3'), soft('T-1', 'T-3')])).toEqual({
      'T-1~T-3': 'T-2',
    });
    expect(hiddenOf([soft('T-1', 'T-2'), soft('T-2', 'T-3'), soft('T-1', 'T-3')])).toEqual({
      'T-1~T-3': 'T-2',
    });
  });

  it('a link that still blocks isn’t hidden behind a cleared one; a cleared link is', () => {
    expect(hiddenOf([hard('T-1', 'T-2'), hard('T-2', 'T-3', true), hard('T-1', 'T-3')])).toEqual(
      {},
    );
    expect(
      hiddenOf([hard('T-1', 'T-2', true), hard('T-2', 'T-3'), hard('T-1', 'T-3', true)]),
    ).toEqual({ 'T-1>T-3': 'T-2' });
  });

  it('a middle ticket removed, or skipped as canceled, brings the direct arrow back', () => {
    const chain = [hard('T-1', 'T-2'), hard('T-2', 'T-3'), hard('T-1', 'T-3')];
    expect(Object.keys(hiddenOf(chain))).toEqual(['T-1>T-3']);
    expect(hiddenOf(chain.filter((e) => e.from !== 'T-2' && e.to !== 'T-2'))).toEqual({});
    expect(hiddenOf(chain, { skip: (id) => id === 'T-2' })).toEqual({});
  });

  it('`keep` links are always drawn', () => {
    const chain = [hard('T-1', 'T-2'), hard('T-2', 'T-3'), hard('T-1', 'T-3')];
    expect(hiddenOf(chain, { keep: (id) => id === 'T-1>T-3' })).toEqual({});
  });

  it('parallel links between the same two tickets don’t imply each other', () => {
    const twice = [hard('T-1', 'T-2'), { ...hard('T-1', 'T-2'), link_id: 'again' }];
    expect(hiddenOf(twice)).toEqual({});
  });

  it('keeps every connection: each hidden link’s ends are still joined by drawn links', () => {
    // Every link from a lower to a higher number among 8 tickets, plus a cycle on the side.
    const ids = Array.from({ length: 8 }, (_, i) => `T-${i + 1}`);
    const edges = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => hard(a, b)));
    edges.push(hard('T-9', 'T-10'), hard('T-10', 'T-9'), hard('T-8', 'T-9'));
    const hidden = impliedLinks(edges);
    const drawn = edges.filter((e) => !hidden.has(e.link_id));
    expect(drawn.map((e) => e.link_id)).toEqual([
      ...ids.slice(0, -1).map((a, i) => `${a}>${ids[i + 1]}`),
      'T-9>T-10',
      'T-10>T-9',
      'T-8>T-9',
    ]);
    const reach = (from: string, to: string) => {
      const seen = new Set([from]);
      const queue = [from];
      while (queue.length) {
        const at = queue.shift()!;
        for (const e of drawn)
          if (e.from === at && !seen.has(e.to)) {
            seen.add(e.to);
            queue.push(e.to);
          }
      }
      return seen.has(to);
    };
    for (const e of edges) expect(reach(e.from, e.to)).toBe(true);
  });
});

function item(id: string, status: Status = 'ready'): MapItem {
  return {
    id,
    project: 'T',
    type: 'Story',
    title: `Ticket ${id}`,
    status,
    priority: 2,
    epic: 'T-100',
    epic_title: 'Synthetic epic',
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
    updated_at: '2026-11-24T10:00:00.000Z',
  };
}
const link = (from: string, to: string): LinkEdge => ({
  link_id: `${from}>${to}`,
  from,
  to,
  type: 'blocks',
  satisfied_when: 'done',
  cleared: false,
});

describe('impliedOnMap', () => {
  const links = [link('T-1', 'T-2'), link('T-2', 'T-3'), link('T-1', 'T-3')];

  it('works from the arrows the map draws', () => {
    const l = layoutMap([item('T-1'), item('T-2'), item('T-3')], [], links);
    expect([...impliedOnMap(l)]).toEqual([['T-1>T-3', ['T-2']]]);
  });

  it('a canceled middle ticket stays on the map but carries no chain', () => {
    const l = layoutMap([item('T-1'), item('T-2', 'canceled'), item('T-3')], [], links);
    expect(l.edges.map((e) => e.link_id)).toContain('T-2>T-3');
    expect(impliedOnMap(l).size).toBe(0);
  });

  it('a middle ticket moved out of the view brings the arrow back', () => {
    const l = layoutMap([item('T-1'), item('T-3')], [], links);
    expect(impliedOnMap(l).size).toBe(0);
  });

  it('an outside blocker’s link is implied through a ticket in the view', () => {
    const l = layoutMap(
      [item('T-2'), item('T-3')],
      [{ ...item('X-1'), project: 'X' }],
      [link('X-1', 'T-2'), link('T-2', 'T-3'), link('X-1', 'T-3')],
    );
    expect([...impliedOnMap(l)]).toEqual([['X-1>T-3', ['T-2']]]);
  });
});
