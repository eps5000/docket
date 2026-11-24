/**
 * The context bundle (BUILD_SPEC §5.15; MCP_SPEC §5.2 `get_context`; FR-040;
 * tasks.md T110): section order, the 1k/3k/8k budgets measured as
 * characters ÷ 4 on the compact text, truncation markers, essentials and
 * decisions never cut first, and owner notes counted but never delivered.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderContext, type ContextBundle } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTEXT_BUDGETS } from '../../src/domain/context.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { addProject, NOW, startDomain, withoutRelease, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'TST');
  claude = d.agent('claude');
});
afterEach(() => d.cleanup());

// ---- Fixtures ----

const T = NOW.toISOString();
const para = (n: number, word: string) =>
  Array.from({ length: n }, (_, i) => `${word} sentence ${i + 1} of the long text.`).join(' ');

function create(input: {
  title: string;
  type?: 'Epic' | 'Story' | 'Task';
  epic?: string;
  labels?: string[];
  outcome?: string;
  acceptance?: string[];
}) {
  const id = createRaw(input);
  // Decision 67: these tests count tickets as before every epic had a Release.
  if (input.type === 'Epic') withoutRelease(d, id);
  return id;
}

function createRaw(input: Parameters<typeof create>[0]) {
  return d.write(claude, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type: input.type ?? 'Story',
      title: input.title,
      priority: 2,
      status: 'planning',
      ...(input.epic ? { epic: input.epic } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.outcome ? { outcome_md: input.outcome } : {}),
      ...(input.acceptance ? { acceptance: input.acceptance } : {}),
    }),
  ).id;
}

function publish(
  actor: Actor,
  scope: { kind: 'project' | 'epic' | 'label' | 'item'; id?: string },
  title: string,
  decision = `${title}.`,
  rationale?: string,
) {
  return d.write(actor, (w, s) =>
    s.decisions.publish(w, {
      project: 'TST',
      scope,
      title,
      decision,
      ...(rationale ? { rationale } : {}),
    }),
  );
}

function brief(label: string, text: string) {
  d.sql
    .prepare('UPDATE labels SET brief_md = ? WHERE project_key = ? AND name = ?')
    .run(text, 'TST', label);
}

let docSeq = 0;
function doc(itemId: string, name: string, versions: string[], mime = 'text/markdown') {
  const id = `doc_T${++docSeq}`;
  d.sql
    .prepare(
      `INSERT INTO documents (id, project_key, item_id, name, kind, created_at, updated_at)
       VALUES (?, 'TST', ?, ?, 'planning', ?, ?)`,
    )
    .run(id, itemId, name, T, T);
  versions.forEach((text, i) => {
    const path = `TST/${id}/v${i + 1}/${name}`;
    const full = join(d.server.runtime.config.paths.docs, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    d.sql
      .prepare(
        `INSERT INTO document_versions (id, document_id, version_no, mime, size, sha256, path, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'x', ?, 'claude', ?, ?)`,
      )
      .run(`dv_${id}_${i + 1}`, id, i + 1, mime, text.length, path, T, T);
  });
}

function review(
  itemId: string,
  round: number,
  verdicts: { text: string; kind: string; note?: string }[],
) {
  const pkt = `pkt_${itemId}_${round}`;
  d.sql
    .prepare(
      `INSERT INTO packets (id, item_id, round, content_hash, created_by, state, version, created_at, updated_at)
       VALUES (?, ?, ?, 'h', 'claude', 'decided', 1, ?, ?)`,
    )
    .run(pkt, itemId, round, T, T);
  verdicts.forEach((v, i) => {
    const hr = `hr_${itemId}_${round}_${i}`;
    d.sql
      .prepare(
        `INSERT INTO hr_items (id, item_id, position, text, state, added_by, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'declared', 'claude', 1, ?, ?)`,
      )
      .run(hr, itemId, round * 100 + i, v.text, T, T);
    d.sql
      .prepare(
        `INSERT INTO review_decisions (id, packet_id, hr_item_id, kind, note, decided_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`rd_${hr}`, pkt, hr, v.kind, v.note ?? null, T, T, T);
  });
}

function note(itemId: string, text: string) {
  d.sql
    .prepare(
      `INSERT INTO owner_notes (id, item_id, text, read_by_agent_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(`note_${text.length}_${Math.random().toString(36).slice(2)}`, itemId, text, T, T);
}

function context(id: string, budget: 'small' | 'medium' | 'large' = 'medium') {
  const bundle = d.services.context.getContext(d.read(claude), { id, budget });
  const text = renderContext(bundle, { now: NOW });
  return { bundle, text, tokens: Math.ceil(text.length / 4) };
}

/** A section's first line in the compact text, or -1. */
const at = (text: string, head: RegExp) => text.split('\n').findIndex((l) => head.test(l));

/** An item with every section filled, small enough for medium. */
function world() {
  const epic = create({ title: 'Meal planning', type: 'Epic', outcome: 'Plan a week of meals.' });
  const item = create({
    title: 'Shopping list',
    epic,
    labels: ['alpha', 'beta'],
    outcome: 'One merged list, grouped by aisle.',
    acceptance: ['Quantities merge', 'Grouped by aisle'],
  });
  const blocker = create({ title: 'Auth scaffold', outcome: 'Sign-in works locally.\nMore.' });
  const dependent = create({ title: 'Export to notes' });
  d.write(claude, (w, s) => s.links.link(w, { from: blocker, to: item, type: 'blocks' }));
  d.write(claude, (w, s) => s.links.link(w, { from: item, to: dependent, type: 'blocks' }));
  brief('alpha', 'Alpha brief: ship screen by screen.');
  publish(claude, { kind: 'epic', id: epic }, 'Agent on the epic');
  publish(OWNER_ACTOR, { kind: 'project' }, 'Owner on the project');
  publish(claude, { kind: 'label', id: 'alpha' }, 'Agent on the label');
  publish(claude, { kind: 'item', id: item }, 'Agent on the item');
  doc(item, 'rules.md', ['# Rules v1', '# Rules v2\nMerge by ingredient.']);
  doc(epic, 'brief.md', ['# Epic brief']);
  doc(item, 'mock.png', ['png'], 'image/png');
  review(item, 1, [{ text: 'Old round', kind: 'changes', note: 'old' }]);
  review(item, 2, [
    { text: 'Check the list on a phone', kind: 'changes', note: 'Too small' },
    { text: 'Export reads well', kind: 'approve' },
  ]);
  return { epic, item, blocker, dependent };
}

// ---- Sections and order ----

describe('sections, in the §5.15 priority order', () => {
  it('holds all six parts, in order, within the default budget', () => {
    const { epic, item, blocker, dependent } = world();
    const { bundle, text, tokens } = context(item);
    expect(bundle.budget).toBe('medium');
    expect(tokens).toBeLessThanOrEqual(CONTEXT_BUDGETS.medium);
    expect(bundle.truncated_sections).toEqual([]);

    // 1. essentials
    expect(bundle.item).toMatchObject({
      id: item,
      title: 'Shopping list',
      status: 'planning',
      outcome_md: 'One merged list, grouped by aisle.',
      acceptance: ['Quantities merge', 'Grouped by aisle'],
      open_question: null,
      unread_owner_notes: 0,
    });
    // 2. decisions in scope, owner first, then newest
    expect(bundle.decisions.map((x) => x.title)).toEqual([
      'Owner on the project',
      'Agent on the item',
      'Agent on the label',
      'Agent on the epic',
    ]);
    // 3. epic and label briefs
    expect(bundle.epic).toEqual({
      id: epic,
      title: 'Meal planning',
      outcome_md: 'Plan a week of meals.',
    });
    expect(bundle.labels).toEqual([
      { name: 'alpha', brief_md: 'Alpha brief: ship screen by screen.' },
      { name: 'beta', brief_md: '' },
    ]);
    // 4. blockers with what each waits for, and dependents
    expect(bundle.blockers).toEqual([
      {
        id: blocker,
        title: 'Auth scaffold',
        status: 'planning',
        cleared: false,
        waiting_for: 'done',
        outcome_first_line: 'Sign-in works locally.',
      },
    ]);
    expect(bundle.dependents).toEqual([
      { id: dependent, title: 'Export to notes', status: 'planning' },
    ]);
    // 5. Markdown planning docs on the item, then its epic; newest version; not the PNG
    expect(bundle.planning_docs).toEqual([
      {
        name: 'rules.md',
        version_no: 2,
        content_md: '# Rules v2\nMerge by ingredient.',
        truncated: false,
      },
      { name: 'brief.md', version_no: 1, content_md: '# Epic brief', truncated: false },
    ]);
    // 6. the latest decided review round
    expect(bundle.last_review).toEqual({
      round: 2,
      items: [
        { text: 'Check the list on a phone', kind: 'changes', note: 'Too small' },
        { text: 'Export reads well', kind: 'approve', note: null },
      ],
    });

    const order = [
      /^Context for /,
      /^decisions:/,
      /^epic /,
      /^labels:/,
      /^blocked_by:/,
      /^blocks:/,
      /^planning_docs:/,
      /^last_review round 2:/,
    ].map((re) => at(text, re));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('a cleared blocker says so; an item without anything shows only the essentials', () => {
    const blocker = create({ title: 'Done first' });
    const item = create({ title: 'Plain' });
    d.write(claude, (w, s) => s.links.link(w, { from: blocker, to: item, type: 'blocks' }));
    d.sql.prepare("UPDATE items SET status = 'done' WHERE id = ?").run(blocker);
    const { bundle } = context(item);
    expect(bundle.blockers[0]).toMatchObject({ cleared: true, waiting_for: null });

    const lone = context(create({ title: 'Lonely' }));
    expect(lone.bundle).toMatchObject({
      decisions: [],
      epic: null,
      labels: [],
      blockers: [],
      dependents: [],
      planning_docs: [],
      last_review: null,
      truncated_sections: [],
    });
    expect(lone.text).toContain('blocked_by: none');
  });

  it('leaves withdrawn and superseded decisions out', () => {
    const item = create({ title: 'Item' });
    const gone = publish(claude, { kind: 'item', id: item }, 'Gone');
    d.write(claude, (w, s) =>
      s.decisions.withdraw(w, { decision_id: gone.id, reason: 'No longer applies' }),
    );
    const old = publish(claude, { kind: 'item', id: item }, 'Old');
    d.write(claude, (w, s) =>
      s.decisions.publish(w, {
        project: 'TST',
        scope: { kind: 'item', id: item },
        title: 'New',
        decision: 'New.',
        supersedes: old.id,
      }),
    );
    expect(context(item).bundle.decisions.map((x) => x.title)).toEqual(['New']);
  });

  it('not_found for an unknown item', () => {
    expect(() =>
      d.services.context.getContext(d.read(claude), { id: 'TST-99', budget: 'medium' }),
    ).toThrow(/No item TST-99/);
  });
});

// ---- Read-only ----

describe('read-only: notes counted, never delivered', () => {
  it('counts unread owner notes without marking them read; get_item then delivers them once', () => {
    const item = create({ title: 'Noted' });
    note(item, 'Use the v2 tokens');
    note(item, 'Keep the old export');
    const events = d.row<{ n: number }>('SELECT count(*) AS n FROM events').n;

    for (const budget of ['small', 'medium', 'large'] as const) {
      const { bundle, text } = context(item, budget);
      expect(bundle.item.unread_owner_notes).toBe(2);
      expect(text).toContain('notes_unread: 2');
      expect(text).not.toContain('Use the v2 tokens');
    }
    expect(
      d.row<{ n: number }>(
        'SELECT count(*) AS n FROM owner_notes WHERE read_by_agent_at IS NOT NULL',
      ).n,
    ).toBe(0);
    // Nothing was written: no events, no receipts.
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM events').n).toBe(events);
    expect(context(item).bundle.item.unread_owner_notes).toBe(2);
  });

  it('shows an answered, unread question with its answer, and leaves it unread', () => {
    const item = create({ title: 'Asked' });
    d.sql
      .prepare(
        `INSERT INTO questions (id, item_id, text, asked_by, answer, answered_at, created_at, updated_at)
         VALUES ('q_1', ?, 'Metric or imperial?', 'claude', 'Metric.', ?, ?, ?)`,
      )
      .run(item, T, T, T);
    const { bundle, text } = context(item);
    expect(bundle.item.open_question).toMatchObject({ id: 'q_1', answer: 'Metric.' });
    expect(text).toContain('answer: Metric.');
    expect(
      d.row<{ r: string | null }>("SELECT read_by_agent_at AS r FROM questions WHERE id = 'q_1'").r,
    ).toBeNull();
  });
});

// ---- Budgets and truncation ----

describe('budgets: 1k / 3k / 8k tokens, characters ÷ 4 on the compact text', () => {
  /** An item whose full context is far over every budget. */
  function heavy() {
    const epic = create({ title: 'Big epic', type: 'Epic', outcome: para(40, 'Epic') });
    const item = create({
      title: 'Heavy item',
      epic,
      labels: ['alpha', 'beta'],
      outcome: 'Essential outcome that must always be shown.',
      acceptance: ['First criterion', 'Second criterion'],
    });
    brief('alpha', para(30, 'Alpha'));
    brief('beta', para(30, 'Beta'));
    for (let i = 1; i <= 6; i++) {
      const b = create({ title: `Blocker ${i}`, outcome: para(2, `B${i}`) });
      d.write(claude, (w, s) => s.links.link(w, { from: b, to: item, type: 'blocks' }));
    }
    publish(OWNER_ACTOR, { kind: 'project' }, 'Owner rule', para(10, 'Owner'));
    publish(claude, { kind: 'epic', id: epic }, 'Agent rule', para(10, 'Agent'), 'Because.');
    doc(item, 'pantry-prd.md', ['v1', '# PRD v2', `# PRD v3\n${para(400, 'Prd')}`]);
    doc(item, 'pantry-tdd.md', [`# TDD\n${para(400, 'Tdd')}`]);
    doc(epic, 'epic-brief.md', [`# Epic brief\n${para(400, 'Brief')}`]);
    review(
      item,
      1,
      Array.from({ length: 8 }, (_, i) => ({
        text: para(3, `Review ${i}`),
        kind: 'changes',
        note: para(2, 'Note'),
      })),
    );
    return { epic, item };
  }

  it.each(['small', 'medium', 'large'] as const)(
    '%s stays within budget, cuts marked',
    (budget) => {
      const { item } = heavy();
      const { bundle, text, tokens } = context(item, budget);
      expect(tokens).toBeLessThanOrEqual(CONTEXT_BUDGETS[budget]);
      expect(bundle.budget).toBe(budget);
      // Essentials are whole.
      expect(bundle.item.outcome_md).toBe('Essential outcome that must always be shown.');
      expect(bundle.item.acceptance).toEqual(['First criterion', 'Second criterion']);
      // Something was cut, and the text says so.
      expect(
        bundle.truncated_sections.length + bundle.planning_docs.filter((x) => x.truncated).length,
      ).toBeGreaterThan(0);
      expect(text).toMatch(/…truncated; /);
      for (const s of bundle.truncated_sections) expect(text).toContain(`…truncated; ${s}`);
      for (const x of bundle.planning_docs.filter((p) => p.truncated))
        expect(text).toContain(`…truncated; read ${x.name} v${x.version_no} with get_item`);
    },
  );

  it('larger budgets carry strictly more, lower sections first to go', () => {
    const { item } = heavy();
    const small = context(item, 'small');
    const medium = context(item, 'medium');
    const large = context(item, 'large');
    expect(small.tokens).toBeLessThan(medium.tokens);
    expect(medium.tokens).toBeLessThan(large.tokens);
    // Decisions are whole at medium and large; at small the owner's comes first and is kept.
    expect(medium.bundle.decisions.map((x) => x.title)).toEqual(['Owner rule', 'Agent rule']);
    expect(medium.bundle.decisions[1]!.decision_md).toBe(para(10, 'Agent'));
    expect(small.bundle.decisions[0]!.title).toBe('Owner rule');
    // More planning text at each step up.
    const docChars = (b: ContextBundle) =>
      b.planning_docs.reduce((n, x) => n + (x.content_md?.length ?? 0), 0);
    expect(docChars(small.bundle)).toBeLessThan(docChars(medium.bundle));
    expect(docChars(medium.bundle)).toBeLessThan(docChars(large.bundle));
  });

  it('planning docs: text until the budget runs out, then names and versions, each marked', () => {
    const { item } = heavy();
    const { bundle, text } = context(item, 'medium');
    const names = bundle.planning_docs.map((x) => `${x.name} v${x.version_no}`);
    expect(names).toEqual(['pantry-prd.md v3', 'pantry-tdd.md v1', 'epic-brief.md v1']);
    // The first doc's text is in (cut), the later ones are names only.
    const [prd, tdd, epicDoc] = bundle.planning_docs;
    expect(prd!.truncated).toBe(true);
    expect(prd!.content_md).toMatch(/^# PRD v3\n/);
    expect(prd!.content_md!.endsWith('…')).toBe(true);
    expect(tdd).toMatchObject({ content_md: null, truncated: true });
    expect(epicDoc).toMatchObject({ content_md: null, truncated: true });
    expect(text).toContain('…truncated; read pantry-prd.md v3 with get_item');
    expect(text).toContain('…truncated; read pantry-tdd.md v1 with get_item');
    // Everything below the docs is left out, and says how to read it.
    expect(bundle.last_review).toBeNull();
    expect(bundle.truncated_sections).toContain(
      `last review round 1; read it with get_review ${item}`,
    );
  });

  it('essentials and decisions are never cut while lower sections are kept', () => {
    const { item } = heavy();
    for (const budget of ['small', 'medium', 'large'] as const) {
      const { bundle } = context(item, budget);
      const decisionsWhole =
        bundle.decisions.length === 2 &&
        !bundle.truncated_sections.some((s) => /decisions? shown/.test(s));
      const lowerKept =
        bundle.epic !== null ||
        bundle.labels.length > 0 ||
        bundle.blockers.length > 0 ||
        bundle.planning_docs.some((x) => x.content_md) ||
        bundle.last_review !== null;
      if (lowerKept) expect(decisionsWhole, budget).toBe(true);
    }
  });

  it('when decisions alone exceed the budget, the lowest-priority ones are cut and counted', () => {
    const item = create({ title: 'Many rules', outcome: 'Short outcome.' });
    publish(OWNER_ACTOR, { kind: 'item', id: item }, 'Owner first', para(20, 'Owner'));
    for (let i = 1; i <= 8; i++) {
      d.clock.advance(1_000);
      publish(claude, { kind: 'item', id: item }, `Agent ${i}`, para(20, `Agent${i}`));
    }
    // One unresolved blocker (a safety fact, always kept) and one cleared one (cut first).
    const open = create({ title: 'Still open', outcome: 'x' });
    d.write(claude, (w, s) => s.links.link(w, { from: open, to: item, type: 'blocks' }));
    const lower = create({ title: 'Lower', outcome: 'x' });
    d.write(claude, (w, s) => s.links.link(w, { from: lower, to: item, type: 'blocks' }));
    d.sql.prepare("UPDATE items SET status = 'done' WHERE id = ?").run(lower);

    const { bundle, text, tokens } = context(item, 'small');
    expect(tokens).toBeLessThanOrEqual(CONTEXT_BUDGETS.small);
    expect(bundle.item.outcome_md).toBe('Short outcome.');
    // Owner first and whole; newer agent records before older ones.
    expect(bundle.decisions[0]).toMatchObject({
      title: 'Owner first',
      decision_md: para(20, 'Owner'),
    });
    expect(bundle.decisions[1]!.title).toBe('Agent 8');
    expect(bundle.decisions.length).toBeLessThan(9);
    const marker = bundle.truncated_sections.find((s) => s.includes('decisions shown'));
    expect(marker).toMatch(
      new RegExp(`^\\d of 9 decisions shown.*; read them with list_decisions in_scope_of ${item}$`),
    );
    expect(text).toContain(`…truncated; ${marker}`);
    // A cut decision ends in "…" and loses its rationale.
    const last = bundle.decisions[bundle.decisions.length - 1]!;
    if (marker!.includes(' cut)')) expect(last.decision_md.endsWith('…')).toBe(true);
    // The lower sections went first; the unresolved blocker stayed, so blocked_by is true.
    expect(bundle.blockers.map((x) => x.id)).toEqual([open]);
    expect(text).toContain(`blocked_by:
  - ${open} Still open · planning · waiting for done`);
    expect(bundle.truncated_sections).toContain(
      `1 cleared blocker; read them with get_item ${item}`,
    );
  });

  it('essentials alone over the budget: cut last, and marked', () => {
    const item = create({
      title: 'Huge',
      outcome: para(100, 'Outcome'),
      acceptance: Array.from({ length: 20 }, (_, i) => para(3, `Criterion ${i}`)),
    });
    publish(OWNER_ACTOR, { kind: 'item', id: item }, 'Rule');
    const { bundle, text, tokens } = context(item, 'small');
    expect(tokens).toBeLessThanOrEqual(CONTEXT_BUDGETS.small);
    expect(bundle.truncated_sections[0]).toBe(
      `outcome and acceptance cut; read ${item} with get_item`,
    );
    expect(text).toContain(`…truncated; outcome and acceptance cut; read ${item} with get_item`);
    expect(bundle.item.outcome_md.length).toBeGreaterThan(0);
  });
});

describe('the compact text is the measure', () => {
  it('renders the bundle in the §5.15 order with the get_context summary line', () => {
    const { item } = world();
    const { text, bundle } = context(item, 'small');
    expect(text.split('\n')[0]).toBe(`Context for ${item} Shopping list · budget small`);
    expect(renderContext(bundle as ContextBundle, { now: NOW })).toBe(text);
  });
});

// ---- Section 5: the project's Workflow notes (decision 29; T157) ----

describe('section 5: Workflow notes', () => {
  let wfVersion = 0;
  function workflow(content_md: string) {
    d.write(OWNER_ACTOR, (w, s) =>
      s.agentFiles.putWorkflow(w, { key: 'TST', content_md, expected_version: wfVersion }),
    );
    wfVersion += 1;
  }
  beforeEach(() => {
    wfVersion = 0;
  });

  it('delivers the current notes after blocks and before planning_docs', () => {
    const { item } = world();
    workflow('- Old notes.');
    workflow('- Branch per item: tst-<n>.\n- Open PRs against main.');
    const { bundle, text, tokens } = context(item);
    expect(tokens).toBeLessThanOrEqual(CONTEXT_BUDGETS.medium);
    expect(bundle.workflow).toEqual({
      project: 'TST',
      version_no: 2,
      content_md: '- Branch per item: tst-<n>.\n- Open PRs against main.',
      truncated: false,
    });
    expect(text).toContain(
      'workflow: TST v2\n  - Branch per item: tst-<n>.\n  - Open PRs against main.',
    );
    const order = [/^blocks:/, /^workflow: TST v2/, /^planning_docs:/].map((re) => at(text, re));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order.every((n) => n >= 0)).toBe(true);
  });

  it('is null without notes, and after they are cleared', () => {
    const item = create({ title: 'Plain' });
    expect(context(item).bundle.workflow).toBeNull();
    workflow('- Notes.');
    expect(context(item).bundle.workflow).not.toBeNull();
    workflow('');
    expect(context(item).bundle.workflow).toBeNull();
    expect(context(item).text).not.toContain('workflow:');
  });

  it('is cut inline (marked) before anything in sections 1–4 at a small budget', () => {
    const { item } = world();
    workflow(para(120, 'Workflow'));
    const { bundle, text, tokens } = context(item, 'small');
    expect(tokens).toBeLessThanOrEqual(CONTEXT_BUDGETS.small);
    // Sections 1–4 are whole.
    expect(bundle.decisions).toHaveLength(4);
    expect(bundle.epic).not.toBeNull();
    expect(bundle.labels).toHaveLength(2);
    expect(bundle.dependents).toHaveLength(1);
    // The notes are cut, marked inline, and everything below is left out with markers.
    expect(bundle.workflow).toMatchObject({ project: 'TST', version_no: 1, truncated: true });
    expect(bundle.workflow!.content_md.endsWith('…')).toBe(true);
    expect(text).toContain('  …truncated; ask get_context with a larger budget');
    expect(bundle.planning_docs).toEqual([]);
    expect(bundle.truncated_sections.some((s) => s.startsWith('2 planning docs'))).toBe(true);
    // A larger budget carries the whole notes.
    const large = context(item, 'large').bundle.workflow!;
    expect(large.truncated).toBe(false);
    expect(large.content_md).toBe(para(120, 'Workflow'));
  });

  it('left out with a marker when a higher section already ran out of room', () => {
    const item = create({ title: 'Big outcome', outcome: para(200, 'Outcome') });
    workflow('- Notes.');
    const { bundle, text } = context(item, 'small');
    expect(bundle.workflow).toBeNull();
    expect(bundle.truncated_sections).toContain(
      'workflow notes TST v1; ask get_context with a larger budget',
    );
    expect(text).toContain(
      '…truncated; workflow notes TST v1; ask get_context with a larger budget',
    );
  });
});
