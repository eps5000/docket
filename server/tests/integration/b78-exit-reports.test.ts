/**
 * B78, implementers report how they finished (owner decision 61), with
 * synthetic text only: a run's summary once it parks, is released or ends;
 * complete and partial exits on park, release, finish and Done; Done refused
 * while a partial exit's items are left and allowed once they are removed
 * with a note; the digest's Finished partly and its clearing on each kind of
 * action; the owner's card and item page; and the implementer's context.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIGEST_MAX_CHARS, renderResult, type ExitReport, type Run } from '@docket/shared';
import { LEASE_EXPIRED_SUMMARY } from '../../src/domain/exit-reports.js';
import { NO_EXIT_WARNING } from '../../src/domain/runs.js';
import { SYSTEM_ACTOR, type Actor } from '../../src/domain/write.js';
import { askForm } from '../helpers.js';
import { addProject, declareNone, forceStatus, startDomain, type Domain } from '../us1-helpers.js';

const OWNER: Actor = { kind: 'owner', client: null, label: null, session_id: null, run_id: null };
const IN_PROGRESS_LINE = 'PR open, CI running, reviewer running';
const FLAG_ITEM = {
  text: 'Check the export with the new format switched on',
  why: 'The switch is turned on by another ticket',
  needs: 'The ticket that turns the switch on',
};

let d: Domain;
let worker: Actor;
let producer: Actor;

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-24T09:00:00.000Z') });
  addProject(d, 'TST');
  worker = d.agent('claude', { label: 'w3' });
  producer = d.agent('codex', { label: 'producer' });
});
afterEach(() => d.cleanup());

const create = (title: string, opts: { epic?: string; type?: 'Task' | 'Epic' } = {}) => {
  const { id } = d.write(producer, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type: opts.type ?? 'Task',
      title,
      priority: 2,
      status: 'planning',
      ...(opts.type === 'Epic' ? {} : { acceptance: ['Export works', FLAG_ITEM.text] }),
      ...(opts.epic ? { epic: opts.epic } : {}),
    }),
  );
  declareNone(d, id);
  forceStatus(d, id, 'ready');
  return id;
};
const claim = (id: string, actor = worker) =>
  d.write(actor, (w, s) =>
    s.runs.claim(w, {
      id,
      agent_label: actor.label ?? undefined,
      orchestrator: { name: 'orca', dispatch_id: 'ctx_synthetic1' },
    }),
  ).run_id;
const as = (run_id: string, actor = worker): Actor => ({ ...actor, run_id });
const say = (run_id: string, note: string) =>
  d.services.runs.heartbeat(d.read(as(run_id)), { run_id, note });
const runOf = (id: string, run_id: string): Run =>
  d.services.views.itemDetail(d.read(), { id }).item.runs.find((r) => r.run_id === run_id)!;
const digest = () => d.services.digest.get(d.read(producer), { project: 'TST' });
const version = (id: string) =>
  d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id).version;
const status = (id: string) =>
  d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status;
const partial = (item?: string) => ({
  outcome: 'partial' as const,
  left: [{ ...FLAG_ITEM, ...(item ? { item } : {}) }],
});
/** A ticket whose lead finished partly, the way the real case went. */
const finishedPartly = (title = 'Synthetic export ticket', item?: string) => {
  const id = create(title);
  const run = claim(id);
  say(run, IN_PROGRESS_LINE);
  d.write(as(run), (w, s) =>
    s.runs.finish(w, {
      run_id: run,
      result: 'finished',
      summary: 'Merged and deployed the export',
      exit: partial(item),
    }),
  );
  return { id, run };
};

describe("a run's summary once it parks, is released or ends", () => {
  it('a parked run leads with its reason, never the line from before', () => {
    const id = create('Synthetic ticket');
    const other = create('Synthetic switch ticket');
    const run = claim(id);
    say(run, IN_PROGRESS_LINE);
    expect(runOf(id, run).summary).toBe(IN_PROGRESS_LINE);
    d.write(as(run), (w, s) =>
      s.runs.park(w, {
        run_id: run,
        reason: `Waiting for ${other} to turn the switch on`,
        waiting_on: { items: [other] },
      }),
    );
    expect(runOf(id, run).summary).toBe(`Parked: Waiting for ${other} to turn the switch on`);
    expect(
      d.row<{ summary: string | null }>('SELECT summary FROM runs WHERE id = ?', run).summary,
    ).toBeNull();
    const agents = d.services.views.agents(d.read(), { scope: 'TST' });
    expect(agents.rows.find((r) => r.run_id === run)?.doing).toBe(
      `Parked · Waiting for ${other} to turn the switch on`,
    );
    // Working again (any write resumes it): neither the park's line nor the old one comes back.
    d.write(as(run), (w, s) => s.runs.resume(w, { run_id: run }));
    expect(runOf(id, run).summary).toBeNull();
    say(run, 'Resuming');
    expect(runOf(id, run).summary).toBe('Resuming');
  });

  it('a parked run that finished partly says so first', () => {
    const id = create('Synthetic ticket');
    const other = create('Synthetic switch ticket');
    const run = claim(id);
    say(run, IN_PROGRESS_LINE);
    d.write(as(run), (w, s) =>
      s.runs.park(w, {
        run_id: run,
        reason: `Waiting for ${other}`,
        waiting_on: { items: [other] },
        exit: partial(other),
      }),
    );
    expect(runOf(id, run).summary).toBe(
      `Finished partly: 1 item left · Parked: Waiting for ${other}`,
    );
    const agents = d.services.views.agents(d.read(), { scope: 'TST' });
    expect(agents.rows.find((r) => r.run_id === run)?.doing).toBe(
      `Finished partly: 1 item left · Parked · Waiting for ${other}`,
    );
  });

  it('a released run shows its reason', () => {
    const id = create('Synthetic ticket');
    const run = claim(id);
    say(run, IN_PROGRESS_LINE);
    d.write(as(run), (w, s) =>
      s.runs.release(w, { id, run_id: run, reason: 'Out of time for today' }),
    );
    expect(runOf(id, run).summary).toBe('Released: Out of time for today');
  });

  it('a finished run shows its own words, led by a partial exit', () => {
    const { id, run } = finishedPartly();
    expect(runOf(id, run).summary).toBe(
      'Finished partly: 1 item left · Merged and deployed the export',
    );
  });

  it('a run whose lease ran out says that, not its last doing line', () => {
    const id = create('Synthetic ticket');
    const run = claim(id);
    say(run, IN_PROGRESS_LINE);
    d.clock.advance(2 * 60 * 60 * 1000);
    d.write(SYSTEM_ACTOR, (w, s) => s.runs.expireLeases(w));
    expect(runOf(id, run).summary).toBe(LEASE_EXPIRED_SUMMARY);
  });

  it('closing as Done and the owner releasing both replace the line', () => {
    const done = create('Synthetic done ticket');
    const run = claim(done);
    say(run, IN_PROGRESS_LINE);
    d.write(as(run), (w, s) => s.items.setStatus(w, { id: done, status: 'done' }));
    expect(runOf(done, run).summary).toBe(`Closed ${done} as Done`);

    const released = create('Synthetic released ticket');
    const other = claim(released);
    say(other, IN_PROGRESS_LINE);
    d.write(OWNER, (w, s) =>
      s.runs.ownerRelease(w, { id: released, expected_version: version(released) }),
    );
    expect(runOf(released, other).summary).toBe('Ended: the owner released the lead claim');
  });
});

describe('exit reports', () => {
  it('finish_run records a complete exit; without one a lead is warned', () => {
    const id = create('Synthetic ticket');
    const run = claim(id);
    const out = d.write(as(run), (w, s) =>
      s.runs.finish(w, {
        run_id: run,
        result: 'finished',
        summary: 'All done',
        exit: { outcome: 'complete' },
      }),
    ) as { warnings?: string[] };
    expect(out.warnings ?? []).not.toContain(NO_EXIT_WARNING);
    expect(runOf(id, run).exit).toMatchObject({
      outcome: 'complete',
      left: [],
      via: 'finish',
      settled: null,
    });

    const bare = create('Synthetic bare ticket');
    const run2 = claim(bare);
    const out2 = d.write(as(run2), (w, s) =>
      s.runs.finish(w, { run_id: run2, result: 'finished', summary: 'Stopped' }),
    ) as { warnings?: string[] };
    expect(out2.warnings).toContain(NO_EXIT_WARNING);
    expect(runOf(bare, run2).exit).toBeUndefined();
  });

  it('a partial exit records each item and appends run.finished_partly', () => {
    const other = create('Synthetic switch ticket');
    const { id, run } = finishedPartly('Synthetic export ticket', other);
    const exit = runOf(id, run).exit as ExitReport;
    expect(exit).toMatchObject({
      outcome: 'partial',
      via: 'finish',
      left: [{ ...FLAG_ITEM, item: other }],
      settled: null,
    });
    const events = d.rows<{ type: string; summary: string }>(
      "SELECT type, summary FROM events WHERE item_id = ? AND type = 'run.finished_partly'",
      id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toContain('finished partly: 1 item left');
  });

  it('release_lead and park_run record exits too', () => {
    const id = create('Synthetic ticket');
    const run = claim(id);
    d.write(as(run), (w, s) =>
      s.runs.release(w, { id, run_id: run, reason: 'Handing back', exit: partial() }),
    );
    expect(runOf(id, run).exit).toMatchObject({ outcome: 'partial', via: 'release' });
    expect(runOf(id, run).summary).toBe('Finished partly: 1 item left · Released: Handing back');

    const parked = create('Synthetic parked ticket');
    const other = create('Synthetic switch ticket');
    const run2 = claim(parked);
    d.write(as(run2), (w, s) =>
      s.runs.park(w, {
        run_id: run2,
        reason: 'Waiting',
        waiting_on: { items: [other] },
        exit: { outcome: 'complete' },
      }),
    );
    expect(runOf(parked, run2).exit).toMatchObject({ outcome: 'complete', via: 'park' });
    // Resuming clears it: the run is working again.
    d.write(as(run2), (w, s) => s.runs.resume(w, { run_id: run2 }));
    expect(runOf(parked, run2).exit).toBeUndefined();
  });

  it('closing as Done is a complete exit', () => {
    const id = create('Synthetic ticket');
    const run = claim(id);
    d.write(as(run), (w, s) => s.items.setStatus(w, { id, status: 'done' }));
    expect(runOf(id, run).exit).toMatchObject({ outcome: 'complete', via: 'done', left: [] });
  });

  it('an exit naming a ticket that does not exist is refused', () => {
    const id = create('Synthetic ticket');
    const run = claim(id);
    d.fails(
      as(run),
      (w, s) =>
        s.runs.finish(w, {
          run_id: run,
          result: 'finished',
          summary: 'Done',
          exit: partial('TST-99'),
        }),
      'not_found',
    );
  });
});

describe('Done with items left (decision 61)', () => {
  it('is refused for an agent, naming the items and the ways forward', () => {
    const { id } = finishedPartly();
    const err = d.fails(
      producer,
      (w, s) => s.items.setStatus(w, { id, status: 'done' }),
      'validation',
    );
    expect(err.message).toContain(FLAG_ITEM.text);
    expect(err.details).toMatchObject({
      reason: 'items_left',
      left: [{ ...FLAG_ITEM, item: null }],
      ways_forward: ['remove_with_note', 'move', 'link', 'ask_owner'],
    });
    expect(status(id)).toBe('progress');
  });

  it('is allowed once the items are removed with a note saying which and why', () => {
    const { id } = finishedPartly();
    d.write(producer, (w, s) =>
      s.items.update(w, { id, expected_version: version(id), acceptance: ['Export works'] }),
    );
    d.write(producer, (w, s) =>
      s.evidence.addNote(w, {
        id,
        text: `Removed "${FLAG_ITEM.text}": the switch ticket checks it once the switch is on.`,
      }),
    );
    d.write(producer, (w, s) => s.items.setStatus(w, { id, status: 'done' }));
    expect(status(id)).toBe('done');
  });

  it('the owner may close it anyway, which settles it', () => {
    const { id, run } = finishedPartly();
    d.write(OWNER, (w, s) =>
      s.items.setStatus(w, { id, status: 'done', expected_version: version(id) }),
    );
    expect(runOf(id, run).exit?.settled).toMatchObject({ how: 'closed', by: 'owner' });
  });
});

describe("the producer's digest: Finished partly", () => {
  it('lists the ticket, the items and the reasons, on every digest, within its cap', () => {
    const { id, run } = finishedPartly();
    const full = digest();
    expect(full.finished_partly).toEqual({
      total: 1,
      rows: [
        {
          item_id: id,
          title: 'Synthetic export ticket',
          run_id: run,
          label: 'w3',
          via: 'finish',
          at: d.clock.now().toISOString(),
          left: [{ ...FLAG_ITEM, item: null }],
        },
      ],
    });
    const text = renderResult('get_digest', full, { now: d.clock.now() });
    expect(text).toContain(`finished partly 1:\n- ${id} 1 left · w3 · `);
    expect(text).toContain('(why: The switch is turned on by another');
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    // Also on a digest since a later cursor: it waits until someone acts.
    const since = d.services.digest.get(d.read(producer), { project: 'TST', cursor: full.cursor });
    expect(since.finished_partly?.total).toBe(1);
  });

  it('a complete exit is never listed', () => {
    const id = create('Synthetic ticket');
    const run = claim(id);
    d.write(as(run), (w, s) =>
      s.runs.finish(w, {
        run_id: run,
        result: 'finished',
        summary: 'Done',
        exit: { outcome: 'complete' },
      }),
    );
    expect(digest().finished_partly).toBeUndefined();
  });

  type How = NonNullable<ExitReport['settled']>['how'];
  const actions: [string, How, (id: string) => void][] = [
    [
      'moving the items (acceptance edited)',
      'moved',
      (id) =>
        d.write(producer, (w, s) =>
          s.items.update(w, { id, expected_version: version(id), acceptance: ['Export works'] }),
        ),
    ],
    [
      'moving the items (a split)',
      'moved',
      (id) =>
        d.write(producer, (w, s) =>
          s.items.create(w, {
            project: 'TST',
            type: 'Task',
            title: 'Synthetic follow-up',
            status: 'inbox',
            split_from: { id, expected_version: version(id), move: [2], relation: 'none' },
          }),
        ),
    ],
    [
      'linking the ticket that will finish them',
      'linked',
      (id) => {
        const other = create('Synthetic switch ticket');
        d.write(producer, (w, s) => s.links.link(w, { from: id, to: other, type: 'relates' }));
      },
    ],
    ['starting work', 'started', (id) => claim(id, d.agent('claude', { label: 'w4' }))],
    [
      'asking the owner on the ticket',
      'asked',
      (id) =>
        d.write(producer, (w, s) =>
          s.messages.askOwner(w, { id, ...askForm('Which ticket should check the export?') }),
        ),
    ],
    [
      'closing them with a note',
      'noted',
      (id) =>
        d.write(producer, (w, s) =>
          s.evidence.addNote(w, { id, text: 'Not needed: the switch ticket covers this check.' }),
        ),
    ],
  ];
  it.each(actions)('clears on %s', (_name, how, act) => {
    const { id, run } = finishedPartly();
    expect(digest().finished_partly?.total).toBe(1);
    d.clock.advance(1000);
    act(id);
    expect(digest().finished_partly).toBeUndefined();
    expect(runOf(id, run).exit?.settled?.how).toBe(how);
  });

  it('clears when the owner is asked on the epic', () => {
    const epic = create('Synthetic epic', { type: 'Epic' });
    const id = create('Synthetic export ticket', { epic });
    const run = claim(id);
    d.write(as(run), (w, s) =>
      s.runs.finish(w, { run_id: run, result: 'finished', summary: 'Merged', exit: partial() }),
    );
    d.write(producer, (w, s) =>
      s.messages.askOwner(w, { id: epic, ...askForm('Which ticket should check the export?') }),
    );
    expect(digest().finished_partly).toBeUndefined();
    expect(runOf(id, run).exit?.settled?.how).toBe('asked');
  });
});

describe("the owner's ticket view", () => {
  it('the card says Finished partly with the reasons; the item page lists each item', () => {
    const { id, run } = finishedPartly();
    const work = d.services.views.work(d.read(), { scope: 'TST', layout: 'board' });
    expect(work.items.find((i) => i.id === id)?.finished_partly).toEqual({
      left: 1,
      reasons: [`${FLAG_ITEM.text}: ${FLAG_ITEM.why}`],
    });
    expect(runOf(id, run).exit?.left).toEqual([{ ...FLAG_ITEM, item: null }]);
    // Once someone acts, the card stops saying it.
    d.write(producer, (w, s) => s.evidence.addNote(w, { id, text: 'Moved to the switch ticket.' }));
    const after = d.services.views.work(d.read(), { scope: 'TST', layout: 'board' });
    expect(after.items.find((i) => i.id === id)?.finished_partly).toBeUndefined();
  });
});

describe("the next implementer's context", () => {
  it('get_context lists what the last lead left, until someone acts', () => {
    const { id } = finishedPartly();
    const ctx = d.services.context.getContext(d.read(worker), { id, budget: 'small' });
    expect(ctx.finished_partly).toMatchObject({ label: 'w3', via: 'finish' });
    const text = renderResult(
      'get_context',
      { context: ctx },
      { args: { id }, now: d.clock.now() },
    );
    expect(text).toContain('finished partly: 1 item left by w3 (finish');
    expect(text).toContain(`1. ${FLAG_ITEM.text} · why: ${FLAG_ITEM.why}`);
  });
});
