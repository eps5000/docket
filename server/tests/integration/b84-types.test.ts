/**
 * B84, ticket types by kind of work (owner decision 67), with synthetic text
 * only: the transition aliases (Story and Task stored as Implementation, with
 * a note), setting a type and clearing an inferred mark, the count of inferred
 * types remaining, the rollout marker, what a blocker's type means for the
 * wait line, and Exploration (no declaration, findings linked to the tickets
 * that use them, and its readiness exception in words).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderResult, type Status } from '@docket/shared';
import { inferredTypeCount } from '../../src/domain/ticket-types.js';
import type { Actor } from '../../src/domain/write.js';
import { addProject, declareNone, forceStatus, startDomain, type Domain } from '../us1-helpers.js';
import { owner } from '../us3-helpers.js';

let d: Domain;
let planner: Actor;
let worker: Actor;

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-24T08:00:00.000Z') });
  addProject(d, 'TST');
  planner = d.agent('claude', { label: 'planner' });
  worker = d.agent('codex', { label: 'worker' });
});
afterEach(() => d.cleanup());

type In = Parameters<Domain['services']['items']['create']>[1];
const createRaw = (actor: Actor, input: Partial<In>) =>
  d.server.runtime.write.run({ actor, operation: 'test', args: {}, idempotencyKey: null }, (w) =>
    d.services.items.create(w, {
      project: 'TST',
      type: 'Implementation',
      title: 'Synthetic ticket',
      priority: 2,
      status: 'planning',
      ...input,
    } as In),
  );
const create = (input: Partial<In> = {}, statusValue?: Status) => {
  const { id } = createRaw(planner, input).result;
  if (statusValue) forceStatus(d, id, statusValue);
  return id;
};
const version = (id: string) =>
  d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id).version;
const row = (id: string) =>
  d.row<{ type: string; type_info: string | null; rollout: number; findings_md: string | null }>(
    'SELECT type, type_info, rollout, findings_md FROM items WHERE id = ?',
    id,
  );
const summaryOf = (id: string) => d.services.items.get(d.read(), { id, view: 'summary' }).item;
/** A ticket as the 0032 migration leaves a Story: Implementation, inferred. */
const inferred = (original: 'Story' | 'Task' = 'Story') => {
  const id = create();
  d.sql
    .prepare('UPDATE items SET type_info = ? WHERE id = ?')
    .run(JSON.stringify({ inferred: true, original }), id);
  return id;
};

describe('Story and Task, for a transition period', () => {
  it('create_item stores Implementation and says so in the reply', () => {
    const out = createRaw(planner, { type: 'Story', title: 'Synthetic story' });
    expect(row(out.result.id)).toMatchObject({ type: 'Implementation', type_info: null });
    expect(out.warnings).toContain(
      `Story is now Implementation (decision 67): ${out.result.id} was stored as Implementation.`,
    );
  });

  it('update_item and search_items accept them too', () => {
    const id = create({ type: 'Design' });
    const out = d.server.runtime.write.run({ actor: planner, operation: 'test', args: {} }, (w) =>
      d.services.items.update(w, { id, expected_version: version(id), type: 'Task' }),
    );
    expect(row(id).type).toBe('Implementation');
    expect(out.warnings?.[0]).toContain('Task is now Implementation');
    const found = d.services.search.searchItems(d.read(), {
      project: 'TST',
      type: ['Story'],
      include_archived: true,
      limit: 25,
    } as never);
    expect(found.items.map((i: { id: string }) => i.id)).toEqual([id]);
  });

  it('tool definitions list only the six types', async () => {
    const { inputJsonSchema, TOOLS } = await import('@docket/shared');
    const create = TOOLS.find((t) => t.name === 'create_item')!;
    const schema = inputJsonSchema(create) as { properties: { type: { enum: string[] } } };
    expect(schema.properties.type.enum).toEqual([
      'Epic',
      'Exploration',
      'Design',
      'Implementation',
      'Bug',
      'Release',
    ]);
    expect(JSON.stringify(schema)).not.toContain('x-docket-aliases');
  });
});

describe('inferred types', () => {
  it('reads show the mark and the original type; setting the type clears it and keeps the original', () => {
    const id = inferred('Story');
    expect(summaryOf(id)).toMatchObject({
      type: 'Implementation',
      type_inferred: true,
      type_original: 'Story',
    });
    const text = renderResult('get_item', { item: summaryOf(id) } as never, {
      args: { id },
      now: d.clock.now(),
    });
    expect(text).toContain('implementation (inferred from story)');
    d.write(planner, (w, s) =>
      s.items.update(w, { id, expected_version: version(id), type: 'Design' }),
    );
    expect(summaryOf(id)).toMatchObject({ type: 'Design', type_original: 'Story' });
    expect(summaryOf(id).type_inferred).toBeUndefined();
  });

  it('confirming the same type clears the mark, and the owner can do it from the item page', () => {
    const id = inferred('Task');
    owner(d, (w, s) =>
      s.items.ownerPatch(w, { id, expected_version: version(id), type: 'Implementation' }),
    );
    expect(summaryOf(id).type_inferred).toBeUndefined();
    const event = d.row<{ summary: string }>(
      "SELECT summary FROM events WHERE item_id = ? AND type = 'item.updated' ORDER BY seq DESC LIMIT 1",
      id,
    );
    expect(event.summary).toBe(`You confirmed ${id}'s type, Implementation`);
  });

  it('counts the open ones: in the digest, Work and the daily brief', () => {
    inferred();
    inferred();
    const done = inferred();
    forceStatus(d, done, 'done');
    expect(inferredTypeCount(d.server.runtime.db, 'TST')).toBe(2);
    const digest = d.services.digest.get(d.read(worker), { project: 'TST' });
    expect(digest.inferred_types).toBe(2);
    expect(renderResult('get_digest', digest, { now: d.clock.now() })).toContain(
      '2 inferred types to check while shaping (update_item type)',
    );
    const work = d.services.views.work(d.read(), {
      scope: 'TST',
      layout: 'board',
      has: 'inferred_type',
    } as never);
    expect(work.items).toHaveLength(2);
    expect(work.filter_counts.has.inferred_type).toBe(2);
  });

  it('an Epic stays an Epic', () => {
    const epic = create({ type: 'Epic' });
    const err = d.fails(
      planner,
      (w, s) => s.items.update(w, { id: epic, expected_version: version(epic), type: 'Design' }),
      'validation',
    );
    expect(err.message).toContain('is an Epic and stays one');
    const ticket = create();
    d.fails(
      planner,
      (w, s) => s.items.update(w, { id: ticket, expected_version: version(ticket), type: 'Epic' }),
      'validation',
    );
  });
});

describe('the rollout marker', () => {
  it('only an Implementation ticket can be a rollout; changing the type clears it', () => {
    const id = create({ rollout: true, title: 'Deploy the synthetic build to staging' });
    expect(row(id).rollout).toBe(1);
    expect(summaryOf(id).rollout).toBe(true);
    const err = d.fails(
      planner,
      (w, s) =>
        s.items.create(w, {
          project: 'TST',
          type: 'Design',
          title: 'x',
          priority: 2,
          status: 'inbox',
          rollout: true,
        } as never),
      'validation',
    );
    expect(err.message).toContain('Only an Implementation ticket can be a rollout');
    d.write(planner, (w, s) =>
      s.items.update(w, { id, expected_version: version(id), type: 'Exploration' }),
    );
    expect(row(id).rollout).toBe(0);
    const other = create();
    d.write(planner, (w, s) =>
      s.items.update(w, { id: other, expected_version: version(other), rollout: true }),
    );
    const work = d.services.views.work(d.read(), {
      scope: 'TST',
      layout: 'board',
      has: 'rollout',
    } as never);
    expect(work.items.map((i: { id: string }) => i.id)).toEqual([other]);
  });
});

describe("what a blocker's type means for the wait", () => {
  it.each([
    ['Design', 'ready', (b: string) => `Starts after ${b}’s design`],
    ['Exploration', 'ready', (b: string) => `Starts after ${b}’s findings`],
    ['Exploration', 'planning', (b: string) => `Shaping waits on ${b}’s findings`],
    ['Implementation', 'ready', (b: string) => `Starts after ${b}`],
    ['Bug', 'ready', (b: string) => `Starts after ${b}`],
  ] as const)('a %s blocker, the dependent %s', (type, dependentStatus, text) => {
    const blocker = create({ type }, 'progress');
    const dependent = create({ blocked_by: [blocker] }, dependentStatus);
    const detail = d.services.views.itemDetail(d.read(), { id: dependent });
    expect(detail.item_wait).toMatchObject({ kind: 'queued', after: blocker });
    expect(detail.item_wait?.text).toBe(text(blocker));
  });
});

describe('Exploration', () => {
  it('needs no shared-changes declaration to move to Ready, and is not Needs shaping for it', () => {
    const id = create({
      type: 'Exploration',
      outcome_md: 'Which cache fits',
      acceptance: ['A recommendation'],
    });
    expect(summaryOf(id).needs_shaping).toBeUndefined();
    d.write(planner, (w, s) => s.items.setStatus(w, { id, status: 'ready' }));
    expect(d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status).toBe(
      'ready',
    );
  });

  it('finishes with its findings, linked to the tickets that use them', () => {
    const id = create({ type: 'Exploration' }, 'ready');
    const lead = d.agent('codex', {
      label: 'worker',
      run_id: d.write(worker, (w, s) => s.runs.claim(w, { id, agent_label: 'worker' })).run_id,
    });
    const noFindings = d.fails(
      lead,
      (w, s) => s.items.setStatus(w, { id, status: 'done' }),
      'validation',
    );
    expect(noFindings.message).toContain('it finishes with its findings');
    const findings = 'Use the synthetic in-memory cache: it was fastest. Recommend it.';
    const unlinked = d.fails(
      lead,
      (w, s) => s.items.setStatus(w, { id, status: 'done', reason: findings }),
      'validation',
    );
    expect(unlinked.message).toContain('Link');
    const user = create();
    declareNone(d, user);
    d.write(planner, (w, s) => s.links.link(w, { from: id, to: user, type: 'relates' }));
    d.write(lead, (w, s) => s.items.setStatus(w, { id, status: 'done', reason: findings }));
    expect(row(id).findings_md).toBe(findings);
  });

  it('the epic start refusal says Exploration may run now', () => {
    const epic = create({ type: 'Epic' }, 'ready');
    create({ epic });
    const err = d.fails(
      worker,
      (w, s) => s.runs.claim(w, { id: epic, agent_label: 'worker' }),
      'epic_not_ready',
    );
    expect(err.message).toContain('Exploration tickets may run now to settle them');
  });
});
