/**
 * Decision records (BUILD_SPEC §5.14; MCP_SPEC §5.8; FR-041–FR-043;
 * tasks.md T111): scope inheritance from project to epic to label to item,
 * authority (agents forbidden on owner records), supersede and withdraw
 * states, the owner's confirm, events, undo, and the item-reference check.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { undoMutation } from '../../src/domain/undo.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { addProject, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;
let codex: Actor;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'TST');
  addProject(d, 'OTH');
  claude = d.agent('claude');
  codex = d.agent('codex');
});
afterEach(() => d.cleanup());

type Scope = { kind: 'project' | 'epic' | 'label' | 'item'; id?: string };

function create(
  title: string,
  opts: { epic?: string; labels?: string[]; type?: 'Epic' | 'Story'; project?: string } = {},
) {
  return d.write(claude, (w, s) =>
    s.items.create(w, {
      project: opts.project ?? 'TST',
      type: opts.type ?? 'Story',
      title,
      priority: 2,
      status: 'planning',
      ...(opts.epic ? { epic: opts.epic } : {}),
      ...(opts.labels ? { labels: opts.labels } : {}),
    }),
  ).id;
}

function publish(
  actor: Actor,
  scope: Scope,
  title: string,
  extra: { supersedes?: string; project?: string } = {},
) {
  d.clock.advance(1_000);
  return d.write(actor, (w, s) =>
    s.decisions.publish(w, {
      project: extra.project ?? 'TST',
      scope,
      title,
      decision: `${title}.`,
      ...(extra.supersedes ? { supersedes: extra.supersedes } : {}),
    }),
  );
}

const titles = (records: { title: string }[]) => records.map((r) => r.title);

/** Project, two epics, two labels and items in each place. */
function world() {
  const epic = create('Epic A', { type: 'Epic' });
  const other = create('Epic B', { type: 'Epic' });
  const item = create('Item in A', { epic, labels: ['ui'] });
  const sibling = create('Sibling in A', { epic });
  const elsewhere = create('Item in B', { epic: other, labels: ['api'] });
  return { epic, other, item, sibling, elsewhere };
}

describe('scope inheritance: project → epic → label → item', () => {
  it('an item sees its project, its epic, its labels and itself; nothing else', () => {
    const w = world();
    publish(claude, { kind: 'project' }, 'P');
    publish(claude, { kind: 'epic', id: w.epic }, 'E-A');
    publish(claude, { kind: 'epic', id: w.other }, 'E-B');
    publish(claude, { kind: 'label', id: 'ui' }, 'L-ui');
    publish(claude, { kind: 'label', id: 'api' }, 'L-api');
    publish(claude, { kind: 'item', id: w.item }, 'I-item');
    publish(claude, { kind: 'item', id: w.sibling }, 'I-sibling');
    publish(claude, { kind: 'project' }, 'Other project', { project: 'OTH' });

    const inScope = (id: string) =>
      titles(
        d.services.decisions.list(d.read(claude), {
          project: 'TST',
          in_scope_of: id,
          include_inactive: false,
          limit: 50,
        }).items,
      );
    // Newest first (all agent records).
    expect(inScope(w.item)).toEqual(['I-item', 'L-ui', 'E-A', 'P']);
    expect(inScope(w.sibling)).toEqual(['I-sibling', 'E-A', 'P']);
    expect(inScope(w.elsewhere)).toEqual(['L-api', 'E-B', 'P']);
    // An epic sees its own records and the project's.
    expect(inScope(w.epic)).toEqual(['E-A', 'P']);
    // get_context and get_item read the same rule.
    expect(
      titles(
        d.services.context.getContext(d.read(claude), { id: w.item, budget: 'medium' }).decisions,
      ),
    ).toEqual(['I-item', 'L-ui', 'E-A', 'P']);
  });

  it('a decision published on an epic reaches every ticket in it, including ones created later', () => {
    const w = world();
    publish(codex, { kind: 'epic', id: w.epic }, 'Units are metric');
    const later = create('Created later', { epic: w.epic });
    for (const id of [w.item, w.sibling, later]) {
      const ctx = d.services.context.getContext(d.read(claude), { id, budget: 'medium' });
      expect(titles(ctx.decisions)).toContain('Units are metric');
    }
    expect(
      titles(
        d.services.context.getContext(d.read(claude), { id: w.elsewhere, budget: 'medium' })
          .decisions,
      ),
    ).not.toContain('Units are metric');
  });

  it('owner records come first, then newest', () => {
    const w = world();
    publish(claude, { kind: 'item', id: w.item }, 'agent old');
    publish(OWNER_ACTOR, { kind: 'project' }, 'owner old');
    publish(claude, { kind: 'label', id: 'ui' }, 'agent new');
    publish(OWNER_ACTOR, { kind: 'epic', id: w.epic }, 'owner new');
    const list = d.services.decisions.list(d.read(claude), {
      project: 'TST',
      in_scope_of: w.item,
      include_inactive: false,
      limit: 50,
    });
    expect(titles(list.items)).toEqual(['owner new', 'owner old', 'agent new', 'agent old']);
  });

  it('lists one scope, the whole project, pages with a cursor, and checks in_scope_of', () => {
    const w = world();
    publish(claude, { kind: 'label', id: 'ui' }, 'L1');
    publish(claude, { kind: 'label', id: 'ui' }, 'L2');
    publish(claude, { kind: 'project' }, 'P');
    const list = (input: Record<string, unknown>) =>
      d.services.decisions.list(d.read(claude), {
        project: 'TST',
        include_inactive: false,
        limit: 25,
        ...input,
      } as never);
    expect(titles(list({ scope: { kind: 'label', id: 'ui' } }).items)).toEqual(['L2', 'L1']);
    expect(titles(list({ scope: { kind: 'project' } }).items)).toEqual(['P']);
    expect(titles(list({}).items)).toEqual(['P', 'L2', 'L1']);
    const page1 = list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = list({ limit: 2, cursor: page1.next_cursor });
    expect(titles(page2.items)).toEqual(['L1']);
    expect(page2.next_cursor).toBeNull();
    expect(() => list({ cursor: 'nope' })).toThrow(/cursor is not valid/);
    expect(() => list({ in_scope_of: 'TST-99' })).toThrow(/No item TST-99/);
    const oth = create('Other', { project: 'OTH' });
    expect(() => list({ in_scope_of: oth })).toThrow(/is in OTH, not TST/);
    expect(() =>
      d.services.decisions.list(d.read(claude), {
        project: 'NOPE',
        include_inactive: false,
        limit: 5,
      }),
    ).toThrow(/No project NOPE/);
    void w;
  });
});

describe('publish: scope checks and limits', () => {
  it('rejects a scope that does not exist or is in another project (validation)', () => {
    const w = world();
    const oth = create('Other', { project: 'OTH' });
    d.fails(
      claude,
      (wc, s) =>
        s.decisions.publish(wc, {
          project: 'TST',
          scope: { kind: 'item', id: 'TST-99' },
          title: 't',
          decision: 'd',
        }),
      'validation',
    );
    d.fails(
      claude,
      (wc, s) =>
        s.decisions.publish(wc, {
          project: 'TST',
          scope: { kind: 'item', id: oth },
          title: 't',
          decision: 'd',
        }),
      'validation',
    );
    d.fails(
      claude,
      (wc, s) =>
        s.decisions.publish(wc, {
          project: 'TST',
          scope: { kind: 'label', id: 'nope' },
          title: 't',
          decision: 'd',
        }),
      'validation',
    );
    d.fails(
      claude,
      (wc, s) =>
        s.decisions.publish(wc, {
          project: 'TST',
          scope: { kind: 'epic', id: w.item },
          title: 't',
          decision: 'd',
        }),
      'validation',
    );
    d.fails(
      claude,
      (wc, s) =>
        s.decisions.publish(wc, {
          project: 'NOPE',
          scope: { kind: 'project' },
          title: 't',
          decision: 'd',
        }),
      'not_found',
    );
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM decision_records').n).toBe(0);
  });

  it('records the author and authority from the actor, and an event on the scope', () => {
    const w = world();
    const agentRec = publish(claude, { kind: 'epic', id: w.epic }, 'Agent says');
    expect(agentRec).toMatchObject({
      authority: 'agent',
      author: 'claude',
      status: 'active',
      scope: { kind: 'epic', id: w.epic },
      version: 1,
    });
    const ownerRec = publish(OWNER_ACTOR, { kind: 'label', id: 'ui' }, 'Owner says');
    expect(ownerRec).toMatchObject({
      authority: 'owner',
      author: 'owner',
      scope: { kind: 'label', id: 'ui' },
    });
    const events = d.rows<{
      type: string;
      item_id: string | null;
      project_key: string;
      summary: string;
    }>(
      "SELECT type, item_id, project_key, summary FROM events WHERE type LIKE 'decision.%' ORDER BY seq",
    );
    expect(events).toEqual([
      {
        type: 'decision.published',
        item_id: w.epic,
        project_key: 'TST',
        summary: 'claude recorded a decision: Agent says',
      },
      {
        type: 'decision.published',
        item_id: null,
        project_key: 'TST',
        summary: 'Owner recorded a decision: Owner says',
      },
    ]);
  });

  it('never raises a Needs-you item', () => {
    const w = world();
    publish(claude, { kind: 'item', id: w.item }, 'Quiet');
    const needs = d.services.views.needsYou(d.read(OWNER_ACTOR), { scope: 'all' } as never);
    expect(JSON.stringify(needs)).not.toContain('Quiet');
  });
});

describe('authority (Principle III): owner records are authoritative', () => {
  it('agents get forbidden superseding or withdrawing an owner record, with a pointer to ask_owner', () => {
    const owner = publish(OWNER_ACTOR, { kind: 'project' }, 'Nutrition is per serving');
    const sup = d.fails(
      claude,
      (w, s) =>
        s.decisions.publish(w, {
          project: 'TST',
          scope: { kind: 'project' },
          title: 'x',
          decision: 'y',
          supersedes: owner.id,
        }),
      'forbidden',
    );
    expect(sup.message).toMatch(/ask_owner/);
    const wd = d.fails(
      claude,
      (w, s) => s.decisions.withdraw(w, { decision_id: owner.id, reason: 'no' }),
      'forbidden',
    );
    expect(wd.message).toMatch(/ask_owner/);
    expect(
      d.row<{ status: string }>('SELECT status FROM decision_records WHERE id = ?', owner.id)
        .status,
    ).toBe('active');
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM decision_records').n).toBe(1);
  });

  it('agents can supersede and withdraw agent records, including another agent’s', () => {
    const a = publish(codex, { kind: 'project' }, 'A');
    const b = publish(claude, { kind: 'project' }, 'B', { supersedes: a.id });
    expect(b.supersedes_id).toBe(a.id);
    const c = publish(claude, { kind: 'project' }, 'C');
    const withdrawn = d.write(codex, (w, s) =>
      s.decisions.withdraw(w, { decision_id: c.id, reason: 'Obsolete' }),
    );
    expect(withdrawn.status).toBe('withdrawn');
  });

  it('only the owner confirms; confirming makes an agent record an owner record', () => {
    const rec = publish(claude, { kind: 'project' }, 'Use v2 tokens');
    d.fails(codex, (w, s) => s.decisions.confirm(w, { decision_id: rec.id }), 'forbidden');
    d.clock.advance(5_000);
    const confirmed = d.write(OWNER_ACTOR, (w, s) =>
      s.decisions.confirm(w, { decision_id: rec.id, expected_version: 1 }),
    );
    expect(confirmed).toMatchObject({
      authority: 'owner',
      author: 'claude',
      confirmed_at: d.clock.now().toISOString(),
      version: 2,
    });
    // Now authoritative: agents can't touch it.
    d.fails(
      claude,
      (w, s) => s.decisions.withdraw(w, { decision_id: rec.id, reason: 'mine' }),
      'forbidden',
    );
    // Confirming twice, or with a stale version, is a conflict.
    d.fails(OWNER_ACTOR, (w, s) => s.decisions.confirm(w, { decision_id: rec.id }), 'conflict');
    const other = publish(claude, { kind: 'project' }, 'Other');
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.decisions.confirm(w, { decision_id: other.id, expected_version: 7 }),
      'conflict',
    );
    expect(
      d.row<{ type: string; summary: string }>(
        "SELECT type, summary FROM events WHERE type = 'decision.confirmed'",
      ),
    ).toEqual({
      type: 'decision.confirmed',
      summary: 'Owner confirmed a decision: Use v2 tokens',
    });
  });

  it('the owner may supersede and withdraw anything', () => {
    const agent = publish(claude, { kind: 'project' }, 'Agent');
    const owner = publish(OWNER_ACTOR, { kind: 'project' }, 'Owner');
    const replacement = publish(OWNER_ACTOR, { kind: 'project' }, 'Owner v2', {
      supersedes: owner.id,
    });
    expect(replacement.authority).toBe('owner');
    const w = d.write(OWNER_ACTOR, (wc, s) =>
      s.decisions.withdraw(wc, { decision_id: agent.id, reason: 'Not any more' }),
    );
    expect(w.status).toBe('withdrawn');
  });
});

describe('supersede and withdraw: states and history', () => {
  it('superseding marks the old record superseded, links both ways, and both stay readable', () => {
    const old = publish(claude, { kind: 'project' }, 'Old');
    const neu = publish(codex, { kind: 'project' }, 'New', { supersedes: old.id });
    const all = d.services.decisions.list(d.read(claude), {
      project: 'TST',
      include_inactive: true,
      limit: 50,
    }).items;
    const oldNow = all.find((r) => r.id === old.id)!;
    expect(oldNow).toMatchObject({ status: 'superseded', superseded_by_id: neu.id, version: 2 });
    expect(neu).toMatchObject({ status: 'active', supersedes_id: old.id, superseded_by_id: null });
    // Active-only lists leave it out.
    expect(
      titles(
        d.services.decisions.list(d.read(claude), {
          project: 'TST',
          include_inactive: false,
          limit: 50,
        }).items,
      ),
    ).toEqual(['New']);
    expect(
      d
        .rows<{ type: string }>("SELECT type FROM events WHERE type LIKE 'decision.%' ORDER BY seq")
        .map((e) => e.type),
    ).toEqual(['decision.published', 'decision.superseded', 'decision.published']);
  });

  it('withdrawn records drop out of context bundles but stay in history', () => {
    const item = create('Item');
    const rec = publish(claude, { kind: 'item', id: item }, 'Temporary');
    d.write(claude, (w, s) =>
      s.decisions.withdraw(w, { decision_id: rec.id, reason: 'Done with it' }),
    );
    expect(
      d.services.context.getContext(d.read(claude), { id: item, budget: 'medium' }).decisions,
    ).toEqual([]);
    const all = d.services.decisions.list(d.read(claude), {
      project: 'TST',
      in_scope_of: item,
      include_inactive: true,
      limit: 50,
    }).items;
    expect(all).toMatchObject([{ id: rec.id, status: 'withdrawn' }]);
    const ev = d.row<{ type: string; item_id: string; summary: string; data: string }>(
      "SELECT type, item_id, summary, data FROM events WHERE type = 'decision.withdrawn'",
    );
    expect(ev).toMatchObject({
      item_id: item,
      summary: 'claude withdrew a decision: Temporary (Done with it)',
    });
    expect(JSON.parse(ev.data)).toMatchObject({
      reason: 'Done with it',
      status: { old: 'active', new: 'withdrawn' },
    });
  });

  it('an inactive record cannot be withdrawn, confirmed or superseded again (conflict)', () => {
    const a = publish(claude, { kind: 'project' }, 'A');
    d.write(claude, (w, s) => s.decisions.withdraw(w, { decision_id: a.id, reason: 'x' }));
    d.fails(
      claude,
      (w, s) => s.decisions.withdraw(w, { decision_id: a.id, reason: 'again' }),
      'conflict',
    );
    d.fails(OWNER_ACTOR, (w, s) => s.decisions.confirm(w, { decision_id: a.id }), 'conflict');
    d.fails(
      claude,
      (w, s) =>
        s.decisions.publish(w, {
          project: 'TST',
          scope: { kind: 'project' },
          title: 't',
          decision: 'd',
          supersedes: a.id,
        }),
      'conflict',
    );
    d.fails(
      claude,
      (w, s) => s.decisions.withdraw(w, { decision_id: 'dec_nope', reason: 'x' }),
      'not_found',
    );
    d.fails(
      claude,
      (w, s) =>
        s.decisions.publish(w, {
          project: 'TST',
          scope: { kind: 'project' },
          title: 't',
          decision: 'd',
          supersedes: 'dec_nope',
        }),
      'not_found',
    );
  });
});

describe('owner actions are undoable', () => {
  const undo = (mutationId: string) => undoMutation(d.server.runtime.write, mutationId);
  const ownerWrite = <T>(fn: Parameters<typeof d.write<T>>[1]) =>
    d.server.runtime.write.run({ actor: OWNER_ACTOR, operation: 'test', args: {} }, (w) =>
      fn(w, d.services),
    );

  it('undo of record, confirm, withdraw and supersede restores the previous state', () => {
    const rec = ownerWrite((w, s) =>
      s.decisions.publish(w, {
        project: 'TST',
        scope: { kind: 'project' },
        title: 'Mine',
        decision: 'Mine.',
      }),
    );
    undo(rec.mutation_id);
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM decision_records').n).toBe(0);

    const agent = publish(claude, { kind: 'project' }, 'Theirs');
    const confirmed = ownerWrite((w, s) => s.decisions.confirm(w, { decision_id: agent.id }));
    undo(confirmed.mutation_id);
    expect(
      d.row('SELECT authority, confirmed_at FROM decision_records WHERE id = ?', agent.id),
    ).toEqual({ authority: 'agent', confirmed_at: null });

    const withdrawn = ownerWrite((w, s) =>
      s.decisions.withdraw(w, { decision_id: agent.id, reason: 'x' }),
    );
    undo(withdrawn.mutation_id);
    expect(
      d.row<{ status: string }>('SELECT status FROM decision_records WHERE id = ?', agent.id)
        .status,
    ).toBe('active');

    const sup = ownerWrite((w, s) =>
      s.decisions.publish(w, {
        project: 'TST',
        scope: { kind: 'project' },
        title: 'Replacement',
        decision: 'R.',
        supersedes: agent.id,
      }),
    );
    undo(sup.mutation_id);
    expect(
      d.row<{ status: string }>('SELECT status FROM decision_records WHERE id = ?', agent.id)
        .status,
    ).toBe('active');
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM decision_records').n).toBe(1);
    // Undo is recorded as an event of the same type.
    expect(
      d.row<{ n: number }>("SELECT count(*) AS n FROM events WHERE summary LIKE 'Undid: %'").n,
    ).toBe(5);
  });
});

describe('the write checks apply to decision text', () => {
  it('warns on item IDs that do not exist, and rejects secrets', () => {
    const item = create('Real');
    const result = d.server.runtime.write.run(
      {
        actor: claude,
        operation: 'publish_decision',
        args: { project: 'TST', title: 'See TST-99', decision: `Like ${item} and TST-98.` },
      },
      (w) =>
        d.services.decisions.publish(w, {
          project: 'TST',
          scope: { kind: 'project' },
          title: 'See TST-99',
          decision: `Like ${item} and TST-98.`,
        }),
    );
    expect(result.warnings).toEqual(["TST-99 doesn't exist", "TST-98 doesn't exist"]);
    const secret = {
      project: 'TST',
      scope: { kind: 'project' as const },
      title: 'Token',
      decision: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    };
    let caught: unknown;
    try {
      d.server.runtime.write.run(
        { actor: claude, operation: 'publish_decision', args: secret },
        (w) => d.services.decisions.publish(w, secret),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'validation' });
    expect(
      d.row<{ n: number }>("SELECT count(*) AS n FROM decision_records WHERE title = 'Token'").n,
    ).toBe(0);
  });
});
