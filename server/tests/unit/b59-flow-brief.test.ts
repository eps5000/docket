/**
 * Flow trends and the daily brief (owner decision 48; BUILD_SPEC §5.29): each
 * metric's definition, empty windows, timezone day boundaries, excluded epics,
 * that merged is never estimated, and the brief's sections with and without data.
 */
import { BRIEF_ROWS, needsYouCount, type BriefResponse, type WaitCard } from '@docket/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayStart } from '../../src/domain/brief.js';
import { bucketFrame, flowNote } from '../../src/domain/flow.js';
import { undoMutation } from '../../src/domain/undo.js';
import { WaitReader } from '../../src/domain/wait.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

const HOUR = minutes(60);
const DAY = 24 * HOUR;

let d: Domain;
let claude: Actor;

function start(env: Record<string, string> = {}, now?: Date) {
  d = startDomain({ seed: false, env, ...(now ? { now } : {}) });
  addProject(d, 'OV');
  addProject(d, 'OW');
  claude = d.agent('claude', { label: 'w1' });
}
afterEach(async () => {
  vi.restoreAllMocks();
  await d?.cleanup();
});

const flow = (scope = 'OV', window: '24h' | '7d' | '30d' = '7d') =>
  d.services.views.overview(d.read(), { scope, window }).flow;
const brief = (day?: string, scope = 'OV'): BriefResponse =>
  d.services.views.brief(d.read(), { scope, ...(day ? { day } : {}) });

function ticket(
  title: string,
  status = 'planning',
  over: { project?: string; type?: 'Task' | 'Epic' } = {},
): string {
  const { id } = d.write(OWNER_ACTOR, (w, s) =>
    s.items.create(w, {
      project: over.project ?? 'OV',
      type: over.type ?? 'Task',
      title,
      priority: 2,
      status: 'planning',
    }),
  );
  if (status !== 'planning') forceStatus(d, id, status);
  return id;
}
const close = (id: string) =>
  d.write(OWNER_ACTOR, (w, s) => s.items.setStatus(w, { id, status: 'done', reason: 'Done.' }));
const finished = (title: string, over: Parameters<typeof ticket>[2] = {}) => {
  const id = ticket(title, 'progress', over);
  close(id);
  return id;
};
const claim = (id: string) =>
  d.write(claude, (w, s) => s.runs.claim(w, { id, agent_label: 'w1' })).run_id;
const park = (run_id: string, waiting_on: Record<string, unknown> = { orchestrator: true }) =>
  d.write({ ...claude, run_id }, (w, s) =>
    s.runs.park(w, { run_id, reason: 'Waiting.', waiting_on }),
  );
const pr = (id: string, label: string, state: string, url: string | null = null) =>
  d.write(claude, (w, s) =>
    s.evidence.linkArtifact(w, { id, kind: 'pr', label, state, ...(url ? { url } : {}) }),
  );
/** A `run.parked` event on any item, as the write path records it. */
const parkEvent = (itemId: string, project = 'OV', at = d.clock.now().toISOString()) =>
  d.sql
    .prepare(
      `INSERT INTO events (at, actor_kind, project_key, item_id, type, summary, mutation_id)
       VALUES (?, 'agent', ?, ?, 'run.parked', 'Parked', ?)`,
    )
    .run(at, project, itemId, `mut_${Math.random()}`);
const lastMutation = () =>
  d.row<{ mutation_id: string }>('SELECT mutation_id FROM events ORDER BY seq DESC LIMIT 1')
    .mutation_id;
const decide = (title: string, extra: Record<string, unknown> = {}, actor: Actor = OWNER_ACTOR) =>
  d.write(actor, (w, s) =>
    s.decisions.publish(w, {
      project: 'OV',
      scope: { kind: 'project' },
      title,
      decision: 'Decided.',
      ...extra,
    }),
  );

describe('flow trends', () => {
  it('reads zero in an empty window, with one bucket per slot and no note', () => {
    start();
    for (const [window, slots] of [
      ['24h', 24],
      ['7d', 8],
      ['30d', 31],
    ] as const) {
      const f = flow('OV', window);
      expect(f).toMatchObject({ finished: 0, merged: 0, parked: 0, note: null });
      expect(f.finished_without_merge).toBe(0);
      expect(f.buckets).toHaveLength(slots);
      expect(f.buckets.every((b) => b.finished + b.merged + b.parked === 0)).toBe(true);
    }
  });

  it('finished is the Completed count, in the same buckets', () => {
    start();
    finished('One');
    d.clock.advance(DAY);
    finished('Two');
    finished('An epic', { type: 'Epic' });
    const o = d.services.views.overview(d.read(), { scope: 'OV', window: '7d' });
    expect(o.flow.finished).toBe(o.completed.count);
    expect(o.flow.buckets.map((b) => b.finished)).toEqual(o.completed.buckets.map((b) => b.count));
  });

  it('counts every run.parked event on a ticket, and never one on an epic', () => {
    start();
    const id = ticket('Parked twice', 'ready');
    const run = claim(id);
    park(run);
    d.write({ ...claude, run_id: run }, (w, s) => s.runs.resume(w, { run_id: run }));
    park(run);
    const epic = ticket('An epic', 'progress', { type: 'Epic' });
    parkEvent(epic);
    expect(flow().parked).toBe(2);
    expect(flow().buckets.reduce((n, b) => n + b.parked, 0)).toBe(2);
  });

  it('keeps parks in other projects out of a project, and in All', () => {
    start();
    parkEvent(ticket('Here', 'ready'));
    parkEvent(ticket('There', 'ready', { project: 'OW' }), 'OW');
    expect(flow('OV').parked).toBe(1);
    expect(flow('all').parked).toBe(2);
  });

  it('leaves out parks before the window', () => {
    start();
    parkEvent(ticket('Old', 'ready'));
    d.clock.advance(8 * DAY);
    expect(flow().parked).toBe(0);
  });

  it('counts each recorded merged PR once, at its first record', () => {
    start();
    const a = ticket('A', 'progress');
    const b = ticket('B', 'progress');
    const url = 'https://example.test/acme/app/pull/7';
    pr(a, 'PR 7', 'merged', url);
    d.clock.advance(HOUR);
    pr(b, 'PR 7 again', 'MERGED', `${url.toUpperCase()}/`);
    pr(a, 'PR 8', 'open', 'https://example.test/acme/app/pull/8');
    expect(flow().merged).toBe(1);
    d.clock.advance(8 * DAY);
    pr(b, 'PR 7 once more', 'merged', url);
    expect(flow().merged).toBe(0);
  });

  it('says how many finished tickets have no merge on record, and never estimates', () => {
    start();
    const withPr = ticket('With a PR', 'progress');
    pr(withPr, 'PR 1', 'merged', 'https://example.test/acme/app/pull/1');
    close(withPr);
    finished('No PR recorded');
    finished('No PR either');
    expect(flow()).toMatchObject({ finished: 3, merged: 1, finished_without_merge: 2 });
  });

  it('puts a slot on the local day in the configured timezone', () => {
    start({ TZ: 'America/New_York' }, new Date('2026-11-20T12:00:00.000Z'));
    const to = d.clock.now().getTime();
    const frame = bucketFrame('7d', to - 7 * DAY, to, 'America/New_York');
    // 03:00 UTC on the 20th is still the 19th in New York.
    expect(frame.slots[frame.indexOf('2026-11-20T03:00:00.000Z')]!.key).toBe('2026-11-19');
    expect(frame.slots[frame.indexOf('2026-11-20T05:30:00.000Z')]!.key).toBe('2026-11-20');
  });

  it('does not touch the Needs you badge', () => {
    start();
    const before = needsYouCount(d.services.views.needsYou(d.read(), { scope: 'OV' }));
    for (let k = 0; k < 6; k++) parkEvent(ticket(`Parked ${k}`, 'ready'));
    flow();
    expect(needsYouCount(d.services.views.needsYou(d.read(), { scope: 'OV' }))).toBe(before);
  });
});

describe('the divergence note', () => {
  const to = Date.parse('2026-11-23T12:00:00.000Z');
  const at = (hoursAgo: number, n = 1) => Array.from({ length: n }, () => to - hoursAgo * HOUR);

  it('says parking is up while finished tickets are down', () => {
    const note = flowNote(
      {
        finished: [...at(40, 8), ...at(5, 2)],
        merged: [],
        parked: [...at(40, 15), ...at(5, 45)],
      },
      to,
    );
    expect(note).toBe(
      'Parking is up while finished tickets are down (parked 15 to 45, finished 8 to 2, first half of this period against the second).',
    );
  });

  it('says PRs are still merging while finished tickets are down', () => {
    const note = flowNote(
      { finished: [...at(40, 8), ...at(5, 2)], merged: [...at(40, 7), ...at(5, 7)], parked: [] },
      to,
    );
    expect(note).toContain('PRs are still merging while finished tickets are down');
  });

  it('stays quiet when nothing diverges', () => {
    const both = { merged: [], parked: [...at(40, 2), ...at(5, 9)] };
    // Finished is up.
    expect(flowNote({ ...both, finished: [...at(40, 1), ...at(5, 5)] }, to)).toBeNull();
    // A drop of one is noise.
    expect(flowNote({ ...both, finished: [...at(40, 3), ...at(5, 2)] }, to)).toBeNull();
    // Finished is down but parking isn't up, and nothing merged.
    expect(
      flowNote({ merged: [], parked: at(40, 3), finished: [...at(40, 8), ...at(5, 2)] }, to),
    ).toBeNull();
    expect(flowNote({ finished: [], merged: [], parked: [] }, to)).toBeNull();
  });

  it('needs at least twelve hours of activity', () => {
    expect(
      flowNote({ finished: [...at(6, 8), ...at(1, 1)], merged: [], parked: at(1, 9) }, to),
    ).toBeNull();
  });
});

describe('the day', () => {
  it('starts at local midnight', () => {
    start();
    expect(new Date(dayStart('2026-11-20', 'UTC')).toISOString()).toBe('2026-11-20T00:00:00.000Z');
    expect(new Date(dayStart('2026-11-20', 'America/New_York')).toISOString()).toBe(
      '2026-11-20T05:00:00.000Z',
    );
    expect(new Date(dayStart('2026-11-20', 'Asia/Tokyo')).toISOString()).toBe(
      '2026-11-19T15:00:00.000Z',
    );
  });

  it('handles a day whose midnight is skipped by a clock change', () => {
    start();
    // Havana moves from 00:00 to 01:00 on this day.
    expect(new Date(dayStart('2026-03-08', 'America/Havana')).toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });

  it('defaults to today in the configured timezone, and reads a future day as today', () => {
    // 02:00 UTC on the 21st is still the 20th in New York.
    start({ TZ: 'America/New_York' }, new Date('2026-11-21T02:00:00.000Z'));
    expect(brief()).toMatchObject({
      day: '2026-11-20',
      today: '2026-11-20',
      timezone: 'America/New_York',
      to: '2026-11-21T02:00:00.000Z',
    });
    expect(brief('2030-01-01').day).toBe('2026-11-20');
  });

  it('counts a ticket on the local day it finished', () => {
    start({ TZ: 'America/New_York' }, new Date('2026-11-20T03:00:00.000Z'));
    const late = finished('Late on the 19th in New York');
    d.clock.advance(3 * HOUR);
    const early = finished('Early on the 20th in New York');
    expect(brief('2026-11-19').finished.rows.map((r) => r.id)).toEqual([late]);
    expect(brief('2026-11-20').finished.rows.map((r) => r.id)).toEqual([early]);
  });
});

describe('the brief', () => {
  it('has every section, empty, with no cost field', () => {
    start();
    const b = brief();
    expect(b.finished).toEqual({ count: 0, rows: [] });
    expect(b.stuck).toEqual({
      parked: { count: 0, rows: [] },
      unowned_blockers: { count: 0, rows: [] },
      held: { count: 0, rows: [] },
    });
    expect(b.decisions).toEqual({ count: 0, rows: [] });
    expect(JSON.stringify(b)).not.toMatch(/cost|estimate|token/i);
  });

  it('keeps the whole count when it lists only the first rows', () => {
    start();
    for (let k = 0; k <= BRIEF_ROWS; k++) finished(`Ticket ${k}`);
    const b = brief();
    expect(b.finished.count).toBe(BRIEF_ROWS + 1);
    expect(b.finished.rows).toHaveLength(BRIEF_ROWS);
  });

  it('lists parked tickets longest first, with no run ID in the next step', () => {
    start();
    const blocker = ticket('The blocker', 'progress');
    const first = ticket('Parked first', 'ready');
    const second = ticket('Parked second', 'ready');
    park(claim(first), { items: [blocker] });
    d.clock.advance(HOUR);
    park(claim(second), { orchestrator: true });
    const rows = brief().stuck.parked.rows;
    expect(rows.map((r) => r.id)).toEqual([first, second]);
    expect(rows[0]!.next).toContain(blocker);

    close(blocker);
    const resumable = brief().stuck.parked.rows.find((r) => r.id === first)!;
    expect(resumable.next).toBe('What it waited for has cleared, so it can resume.');
    expect(resumable.next).not.toMatch(/run_/);
  });

  it('lists a blocker nobody owns, most blocking first, and not one with a lead', () => {
    start();
    const big = ticket('Blocks two', 'planning');
    const small = ticket('Blocks one', 'ready');
    const led = ticket('Has a lead', 'ready');
    const [w1, w2, w3, w4] = ['W1', 'W2', 'W3', 'W4'].map((t) => ticket(t, 'ready'));
    const link = (from: string, to: string) =>
      d.write(OWNER_ACTOR, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));
    link(small, w1!);
    link(big, w2!);
    link(big, w3!);
    link(led, w4!);
    claim(led);
    expect(
      brief().stuck.unowned_blockers.rows.map((r) => ({ id: r.id, blocks: r.blocks })),
    ).toEqual([
      { id: big, blocks: 2 },
      { id: small, blocks: 1 },
    ]);
  });

  it('lists a run held by an owner decision separately, once B58 reports it', () => {
    start();
    const heldId = ticket('Held', 'ready');
    const parkedId = ticket('Parked', 'ready');
    park(claim(heldId));
    park(claim(parkedId));
    // Until B58 lands, the card has no `held_by`, and the group stays empty.
    expect(brief().stuck.held.count).toBe(0);
    expect(brief().stuck.parked.count).toBe(2);

    const real = WaitReader.prototype.card;
    vi.spyOn(WaitReader.prototype, 'card').mockImplementation(function (
      this: WaitReader,
      run: Parameters<typeof real>[0],
    ) {
      const card = real.call(this, run) as WaitCard & { held_by?: unknown };
      card.held_by =
        run.item_id === heldId ? { decision_id: 'dec_1', title: 'Wait for the launch' } : null;
      return card;
    });
    const b = brief();
    expect(b.stuck.held.rows).toMatchObject([
      { id: heldId, decision_id: 'dec_1', decision_title: 'Wait for the launch' },
    ]);
    expect(b.stuck.parked.rows.map((r) => r.id)).toEqual([parkedId]);
  });

  it('lists what changed in decisions, a replacement as one line', () => {
    start();
    const first = decide('First rule');
    d.clock.advance(1000);
    decide('Second rule', { supersedes: first.id });
    const rows = brief().decisions.rows;
    expect(rows.map((r) => [r.title, r.change, r.by])).toEqual([
      ['Second rule', 'replaced', 'owner'],
      ['First rule', 'recorded', 'owner'],
    ]);
  });

  it('leaves out a change the owner undid', () => {
    start();
    decide('Kept');
    d.clock.advance(1000);
    decide('Undone');
    undoMutation(d.server.runtime.write, lastMutation());
    expect(brief().decisions.rows.map((r) => r.title)).toEqual(['Kept']);
  });

  it('keeps another day and another project out', () => {
    start();
    decide('Yesterday');
    d.clock.advance(DAY);
    d.write(OWNER_ACTOR, (w, s) =>
      s.decisions.publish(w, {
        project: 'OW',
        scope: { kind: 'project' },
        title: 'Other project',
        decision: 'Decided.',
      }),
    );
    expect(brief().decisions.count).toBe(0);
    expect(brief(undefined, 'all').decisions.rows.map((r) => r.title)).toEqual(['Other project']);
  });
});
