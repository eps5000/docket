/**
 * Project decisions reach the owner (owner decision 38; BUILD_SPEC §5.14;
 * FR-175; B44): an agent's active project-scope record is a Needs you card
 * (counted as for you) until the owner confirms, withdraws, supersedes or
 * acknowledges it; undo brings it back; item, epic and label records never
 * make cards; records from before decision 38 share one card per project;
 * only the owner acknowledges, and only agent project records; agents' reads
 * are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectReviews } from '../../src/domain/decisions.js';
import { undoMutation } from '../../src/domain/undo.js';
import { OWNER_ACTOR, type Actor, type WriteContext } from '../../src/domain/write.js';
import type { Services } from '../../src/domain/contracts.js';
import { addProject, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'TST');
  addProject(d, 'OTH');
  claude = d.agent('claude');
});
afterEach(() => d.cleanup());

type Scope = { kind: 'project' | 'epic' | 'label' | 'item'; id?: string };

function publish(actor: Actor, scope: Scope, title: string, project = 'TST', supersedes?: string) {
  d.clock.advance(1_000);
  return d.write(actor, (w, s) =>
    s.decisions.publish(w, {
      project,
      scope,
      title,
      decision: `${title}.`,
      rationale: `Because of ${title}.`,
      ...(supersedes ? { supersedes } : {}),
    }),
  );
}

const ownerWrite = <T>(fn: (w: WriteContext, s: Services) => T) =>
  d.server.runtime.write.run({ actor: OWNER_ACTOR, operation: 'test', args: {} }, (w) =>
    fn(w, d.services),
  );
const undo = (mutationId: string) => undoMutation(d.server.runtime.write, mutationId);

const needs = (scope = 'all') => d.services.views.needsYou(d.read(OWNER_ACTOR), { scope } as never);
const cardTitles = (scope = 'all') => (needs(scope).project_decisions ?? []).map((c) => c.title);
const forYou = () => d.services.views.bootstrap(d.read(OWNER_ACTOR)).counts.for_you;

describe('the Needs you card (decision 38)', () => {
  it('an agent project decision is a card with its text and reason; nothing else is', () => {
    const epic = d.write(claude, (w, s) =>
      s.items.create(w, {
        project: 'TST',
        type: 'Epic',
        title: 'E',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    // Creating an item with a label creates the label.
    d.write(claude, (w, s) =>
      s.items.create(w, {
        project: 'TST',
        type: 'Story',
        title: 'Labelled',
        priority: 2,
        status: 'planning',
        labels: ['ui'],
      }),
    );
    const before = forYou();
    publish(claude, { kind: 'epic', id: epic }, 'Epic one');
    publish(claude, { kind: 'item', id: epic }, 'Item one');
    publish(claude, { kind: 'label', id: 'ui' }, 'Label one');
    publish(OWNER_ACTOR, { kind: 'project' }, 'Owner one');
    expect(cardTitles()).toEqual([]);
    expect(forYou()).toBe(before);

    const rec = publish(claude, { kind: 'project' }, 'Prototypes for owner review');
    const [card] = needs().project_decisions!;
    expect(card).toMatchObject({
      id: rec.id,
      project: 'TST',
      author: 'claude',
      title: 'Prototypes for owner review',
      decision_md: 'Prototypes for owner review.',
      rationale_md: 'Because of Prototypes for owner review.',
    });
    expect(forYou()).toBe(before + 1);
    // Scoped: only that project's.
    expect(cardTitles('TST')).toEqual(['Prototypes for owner review']);
    expect(cardTitles('OTH')).toEqual([]);
    expect(needs().project_decision_groups).toEqual([]);
  });

  it('leaves on confirm, withdraw, supersede or acknowledge; undo brings it back', () => {
    const a = publish(claude, { kind: 'project' }, 'A');
    const confirmed = ownerWrite((w, s) => s.decisions.confirm(w, { decision_id: a.id }));
    expect(cardTitles()).toEqual([]);
    undo(confirmed.mutation_id);
    expect(cardTitles()).toEqual(['A']);

    const withdrawn = ownerWrite((w, s) =>
      s.decisions.withdraw(w, { decision_id: a.id, reason: 'No' }),
    );
    expect(cardTitles()).toEqual([]);
    undo(withdrawn.mutation_id);
    expect(cardTitles()).toEqual(['A']);

    const sup = ownerWrite((w, s) =>
      s.decisions.publish(w, {
        project: 'TST',
        scope: { kind: 'project' },
        title: 'A, the owner’s way',
        decision: 'A2.',
        supersedes: a.id,
      }),
    );
    expect(cardTitles()).toEqual([]);
    undo(sup.mutation_id);
    expect(cardTitles()).toEqual(['A']);

    const acked = ownerWrite((w, s) => s.decisions.acknowledge(w, { decision_ids: [a.id] }));
    expect(cardTitles()).toEqual([]);
    expect(acked.result[0]).toMatchObject({ id: a.id, authority: 'agent', status: 'active' });
    const row = d.row<{ acknowledged_at: string | null; authority: string }>(
      'SELECT acknowledged_at, authority FROM decision_records WHERE id = ?',
      a.id,
    );
    expect(row.authority).toBe('agent');
    expect(row.acknowledged_at).not.toBeNull();
    expect(
      d.row(
        'SELECT type, project_key, item_id, summary FROM events WHERE type = ?',
        'decision.acknowledged',
      ),
    ).toEqual({
      type: 'decision.acknowledged',
      project_key: 'TST',
      item_id: null,
      summary: 'Owner acknowledged a decision by claude: A',
    });
    undo(acked.mutation_id);
    expect(cardTitles()).toEqual(['A']);
  });

  it('an agent superseding an agent project decision replaces its card', () => {
    const a = publish(claude, { kind: 'project' }, 'Old');
    publish(claude, { kind: 'project' }, 'New', 'TST', a.id);
    expect(cardTitles()).toEqual(['New']);
  });
});

describe('acknowledge: who and what', () => {
  it('only the owner; only active, unacknowledged agent project records; all or nothing', () => {
    const a = publish(claude, { kind: 'project' }, 'A');
    const b = publish(claude, { kind: 'project' }, 'B');
    const owner = publish(OWNER_ACTOR, { kind: 'project' }, 'Mine');
    d.fails(claude, (w, s) => s.decisions.acknowledge(w, { decision_ids: [a.id] }), 'forbidden');
    const notAgent = d.fails(
      OWNER_ACTOR,
      (w, s) => s.decisions.acknowledge(w, { decision_ids: [b.id, owner.id] }),
      'conflict',
    );
    expect(notAgent.message).toContain('only those wait for your review');
    // B was checked first but not changed: nothing is half-done.
    expect(cardTitles()).toEqual(['B', 'A']);
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.decisions.acknowledge(w, { decision_ids: ['dec_nope'] }),
      'not_found',
    );

    ownerWrite((w, s) => s.decisions.acknowledge(w, { decision_ids: [a.id, b.id, a.id] }));
    expect(cardTitles()).toEqual([]);
    expect(
      d.row<{ n: number }>("SELECT count(*) AS n FROM events WHERE type = 'decision.acknowledged'")
        .n,
    ).toBe(2);
    const again = d.fails(
      OWNER_ACTOR,
      (w, s) => s.decisions.acknowledge(w, { decision_ids: [a.id] }),
      'conflict',
    );
    expect(again.message).toContain('already acknowledged');
  });
});

describe('records from before decision 38: one grouped card per project', () => {
  it('groups review_grouped records per project, newest first; acting on one shrinks it', () => {
    const olds = ['One', 'Two', 'Three'].map((t) => publish(claude, { kind: 'project' }, t));
    const other = publish(claude, { kind: 'project' }, 'Elsewhere', 'OTH');
    d.sql
      .prepare("UPDATE decision_records SET review_grouped = 1 WHERE scope_kind = 'project'")
      .run();
    const fresh = publish(claude, { kind: 'project' }, 'Fresh');
    const before = forYou();

    expect(cardTitles()).toEqual(['Fresh']);
    const groups = needs().project_decision_groups!;
    expect(groups.map((g) => [g.project, g.decisions.map((x) => x.title)])).toEqual([
      ['OTH', ['Elsewhere']],
      ['TST', ['Three', 'Two', 'One']],
    ]);
    expect(groups[1]!.decisions[0]).toEqual({ id: olds[2]!.id, title: 'Three', author: 'claude' });
    expect(needs('TST').project_decision_groups!.map((g) => g.project)).toEqual(['TST']);

    ownerWrite((w, s) => s.decisions.confirm(w, { decision_id: olds[0]!.id }));
    expect(needs('TST').project_decision_groups![0]!.decisions.map((x) => x.title)).toEqual([
      'Three',
      'Two',
    ]);
    // Acknowledge all: the group's IDs in one mutation, undone together.
    const all = ownerWrite((w, s) =>
      s.decisions.acknowledge(w, { decision_ids: [olds[1]!.id, olds[2]!.id] }),
    );
    expect(needs('TST').project_decision_groups).toEqual([]);
    expect(forYou()).toBe(before - 1);
    undo(all.mutation_id);
    expect(needs('TST').project_decision_groups![0]!.decisions).toHaveLength(2);
    expect(other.id).toMatch(/^dec_/);
    expect(fresh.id).toMatch(/^dec_/);
  });

  it('projectReviews skips deleted projects', () => {
    publish(claude, { kind: 'project' }, 'Gone soon', 'OTH');
    d.sql
      .prepare("UPDATE projects SET deleted_at = '2026-11-20T00:00:00.000Z' WHERE key = 'OTH'")
      .run();
    expect(projectReviews(d.server.runtime.db, 'all').cards).toEqual([]);
  });
});

describe('agents are unchanged', () => {
  it('get_context still includes project decisions, acknowledged or not', () => {
    const item = d.write(claude, (w, s) =>
      s.items.create(w, {
        project: 'TST',
        type: 'Story',
        title: 'S',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    const a = publish(claude, { kind: 'project' }, 'Open with no commands');
    ownerWrite((w, s) => s.decisions.acknowledge(w, { decision_ids: [a.id] }));
    const ctx = d.services.context.getContext(d.read(claude), { id: item, budget: 'medium' });
    expect(ctx.decisions.map((x) => x.title)).toEqual(['Open with no commands']);
    expect(Object.keys(ctx.decisions[0]!)).not.toContain('acknowledged_at');
  });
});
