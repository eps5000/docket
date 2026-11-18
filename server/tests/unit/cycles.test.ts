/**
 * Cycles (BUILD_SPEC §5.2; FR-032; tasks.md T103): `link_items` rejects a
 * link that would close a cycle, with the path; cycles already in the data
 * (imports) are found on read as strongly connected components and shown as
 * Problems; blocking crosses projects.
 */
import type { ToolError } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { addProject, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'DOC');
  addProject(d, 'RCP');
  claude = d.agent('claude');
});
afterEach(() => d.cleanup());

function create(project: string, title = 'Item', imported = false): string {
  const id = d.write(claude, (w, s) =>
    s.items.create(w, { project, type: 'Task', title, priority: 2, status: 'planning' }),
  ).id;
  if (imported) d.sql.prepare('UPDATE items SET imported = 1 WHERE id = ?').run(id);
  return id;
}

const link = (from: string, to: string) =>
  d.write(claude, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));

function cycleError(from: string, to: string): ToolError {
  const err = d.fails(
    claude,
    (w, s) => s.links.link(w, { from, to, type: 'blocks' }),
    'validation',
  );
  return err;
}

/** A link written directly, as an import would leave it (no cycle check). */
function rawLink(from: string, to: string): void {
  const t = d.clock.now().toISOString();
  d.sql
    .prepare(
      `INSERT INTO links (id, from_id, to_id, type, satisfied_when, created_by, version, created_at, updated_at)
       VALUES (?, ?, ?, 'blocks', NULL, 'imported', 1, ?, ?)`,
    )
    .run(`lnk_${from}_${to}`, from, to, t, t);
}

const cycles = (project?: string) =>
  d.services.subgraph.cycles(d.read(), project ? { project } : {});

describe('cycle rejection', () => {
  it('a two-item cycle is refused with the path, and nothing is stored', () => {
    const a = create('DOC');
    const b = create('DOC');
    link(a, b);
    const err = cycleError(b, a);
    expect(err.details).toEqual({ cycle: [a, b, a] });
    expect(err.message).toBe(
      `Linking ${b} blocks ${a} would create a cycle: ${a} → ${b} → ${a}. Remove a link in the path first, or link them the other way.`,
    );
    expect(d.rows('SELECT id FROM links')).toHaveLength(1);
    expect(d.rows("SELECT seq FROM events WHERE type = 'link.added'")).toHaveLength(1);
  });

  it('a longer cycle names every step: A → B → C → A', () => {
    const [a, b, c] = [create('DOC'), create('DOC'), create('DOC')];
    link(a, b);
    link(b, c);
    expect(cycleError(c, a).details).toEqual({ cycle: [a, b, c, a] });
  });

  it('the path found is a real path through existing links', () => {
    // a → b → d, a → c → d; linking d → a closes two cycles; either path is real.
    const [a, b, c, x] = [create('DOC'), create('DOC'), create('DOC'), create('DOC')];
    link(a, b);
    link(a, c);
    link(b, x);
    link(c, x);
    const path = (cycleError(x, a).details as { cycle: string[] }).cycle;
    expect(path[0]).toBe(a);
    expect(path.at(-1)).toBe(a);
    expect(path.at(-2)).toBe(x);
    for (let i = 0; i < path.length - 2; i++) {
      expect(
        d.rows('SELECT id FROM links WHERE from_id = ? AND to_id = ?', path[i], path[i + 1]),
      ).toHaveLength(1);
    }
  });

  it('a diamond is not a cycle', () => {
    const [a, b, c, x] = [create('DOC'), create('DOC'), create('DOC'), create('DOC')];
    link(a, b);
    link(a, c);
    link(b, x);
    expect(() => link(c, x)).not.toThrow();
    expect(cycles()).toEqual([]);
  });

  it('relates links never form a cycle', () => {
    const a = create('DOC');
    const b = create('DOC');
    link(a, b);
    expect(() =>
      d.write(claude, (w, s) => s.links.link(w, { from: b, to: a, type: 'relates' })),
    ).not.toThrow();
  });

  it('cycles across projects are refused too', () => {
    const r = create('RCP');
    const x = create('DOC');
    const y = create('DOC');
    link(r, x);
    link(x, y);
    expect(cycleError(y, r).details).toEqual({ cycle: [r, x, y, r] });
  });

  it('changing the rule on a link that is already part of an imported cycle is allowed', () => {
    const a = create('DOC', 'A', true);
    const b = create('DOC', 'B', true);
    rawLink(a, b);
    rawLink(b, a);
    expect(
      d.write(claude, (w, s) =>
        s.links.link(w, { from: a, to: b, type: 'blocks', satisfied_when: 'merged' }),
      ),
    ).toMatchObject({ updated: true, satisfied_when: 'merged' });
  });
});

describe('strongly connected components on read (imported data)', () => {
  it('finds each cycle larger than one node, in ID order, and ignores the tails', () => {
    const [a, b, c, x, y, tail] = [
      create('DOC', 'A', true),
      create('DOC', 'B', true),
      create('DOC', 'C', true),
      create('RCP', 'X', true),
      create('RCP', 'Y', true),
      create('DOC', 'Tail', true),
    ];
    rawLink(a, b);
    rawLink(b, c);
    rawLink(c, a);
    rawLink(c, tail);
    rawLink(x, y);
    rawLink(y, x);
    const found = cycles();
    expect(found).toHaveLength(2);
    expect(found).toContainEqual([a, b, c]);
    expect(found).toContainEqual([x, y]);
    expect(cycles('RCP')).toEqual([[x, y]]);
  });

  it('a cycle that crosses projects is reported for both projects', () => {
    const r = create('RCP', 'R', true);
    const x = create('DOC', 'X', true);
    rawLink(r, x);
    rawLink(x, r);
    expect(cycles('RCP')).toEqual([[x, r].sort()]);
    expect(cycles('DOC')).toEqual([[x, r].sort()]);
  });

  it('every member of a cycle is blocked, and Problems shows it once, with the path', () => {
    const [a, b, c] = [
      create('DOC', 'A', true),
      create('DOC', 'B', true),
      create('DOC', 'C', true),
    ];
    rawLink(a, b);
    rawLink(b, c);
    rawLink(c, a);
    const state = d.services.links.blockState(d.read(), { ids: [a, b, c] });
    expect([a, b, c].every((id) => state[id]!.blocked)).toBe(true);
    const problems = d.services.views
      .needsYou(d.read(OWNER_ACTOR), { scope: 'all' })
      .problems.filter((p) => p.kind === 'cycle');
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toBe(
      `Dependency cycle in imported data: ${a} → ${b} → ${c} → ${a}. None of them can start until one link is removed.`,
    );
  });

  it('dependency_subgraph lists the cycles among its nodes', () => {
    const [a, b] = [create('DOC', 'A', true), create('DOC', 'B', true)];
    rawLink(a, b);
    rawLink(b, a);
    const out = d.services.subgraph.dependencySubgraph(d.read(claude), {
      id: a,
      depth: 2,
      direction: 'both',
    });
    expect(out.cycles).toEqual([[a, b]]);
  });
});

describe('blocking crosses projects', () => {
  it('an item is blocked by an open blocker in another project, and cleared when it is done', () => {
    const doc = create('DOC');
    const rcp = create('RCP');
    link(doc, rcp);
    expect(d.services.links.blockState(d.read(), { ids: [rcp] })[rcp]).toEqual({
      blocked: true,
      blocked_by: [doc],
      waiting_for: { [doc]: 'done' },
    });
    d.sql.prepare("UPDATE items SET status = 'done' WHERE id = ?").run(doc);
    expect(d.services.links.blockState(d.read(), { ids: [rcp] })[rcp]!.blocked).toBe(false);
  });
});
