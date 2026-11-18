/**
 * Displayed run state (BUILD_SPEC §5.4; FR-015; tasks.md T066): never show
 * more certainty than the data supports. Live needs a *session* signal
 * within LIVE_WINDOW (2 m); any signal within STALE_AFTER (30 m) is
 * *reported*; after that, *stale*. Edges are inclusive: "within" the window.
 */
import type { SignalKind, StoredRunState } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { displayRunState } from '../../src/domain/model.js';
import { minutes, startDomain, type Domain } from '../us1-helpers.js';

const NOW = new Date('2026-11-06T11:00:00.000Z');
const W = { liveWindowMs: minutes(2), staleAfterMs: minutes(30) };
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function state(stored: StoredRunState, kind: SignalKind, agoMs: number) {
  return displayRunState(
    { state: stored, last_signal_kind: kind, last_signal_at: ago(agoMs) },
    W,
    NOW,
  );
}

describe('open runs at the window edges', () => {
  it.each<[SignalKind, number, string]>([
    ['session', 0, 'live'],
    ['session', minutes(2), 'live'],
    ['session', minutes(2) + 1, 'reported'],
    ['session', minutes(30), 'reported'],
    ['session', minutes(30) + 1, 'stale'],
    ['report', 0, 'reported'],
    ['report', minutes(2), 'reported'],
    ['report', minutes(30), 'reported'],
    ['report', minutes(30) + 1, 'stale'],
    ['relayed', 0, 'reported'],
    ['relayed', minutes(30), 'reported'],
    ['relayed', minutes(30) + 1, 'stale'],
  ])('a %s signal %i ms ago shows %s', (kind, agoMs, expected) => {
    expect(state('open', kind, agoMs)).toBe(expected);
  });

  it('a signal from the future (clock skew) counts as now', () => {
    expect(state('open', 'session', -minutes(1))).toBe('live');
  });
});

describe('stored states', () => {
  it.each<StoredRunState>(['finished', 'failed', 'interrupted'])(
    '%s is shown as it is, however old the signal',
    (stored) => {
      expect(state(stored, 'session', 0)).toBe(stored);
      expect(state(stored, 'session', minutes(600))).toBe(stored);
    },
  );

  it('needs_input is shown as needs_input', () => {
    expect(state('needs_input', 'session', minutes(600))).toBe('needs_input');
  });

  it('a parked run is never stale', () => {
    expect(state('parked', 'session', minutes(600))).toBe('parked');
  });

  it('nothing open is ever shown as finished', () => {
    for (const kind of ['session', 'report', 'relayed'] as const) {
      for (const t of [0, minutes(1), minutes(10), minutes(100)]) {
        expect(state('open', kind, t)).not.toBe('finished');
      }
    }
  });
});

describe('configured windows (TASKLITE_LIVE_WINDOW, TASKLITE_STALE_AFTER)', () => {
  it('uses the configured lengths', () => {
    const w = { liveWindowMs: minutes(1), staleAfterMs: minutes(5) };
    const at = (ms: number) => ({
      state: 'open' as const,
      last_signal_kind: 'session' as const,
      last_signal_at: ago(ms),
    });
    expect(displayRunState(at(minutes(1)), w, NOW)).toBe('live');
    expect(displayRunState(at(minutes(1) + 1), w, NOW)).toBe('reported');
    expect(displayRunState(at(minutes(5) + 1), w, NOW)).toBe('stale');
  });
});

describe('signal kinds as recorded (BUILD_SPEC §5.4)', () => {
  let d: Domain | undefined;
  afterEach(async () => {
    await d?.cleanup();
    d = undefined;
  });

  const lead = (dd: Domain) =>
    dd.row<{ id: string }>(
      "SELECT id FROM runs WHERE item_id = 'RCP-14' AND is_lead = 1 AND state = 'open'",
    ).id;
  const runState = async (dd: Domain) => {
    const r = dd.services.items.get(dd.read(), { id: 'RCP-14', view: 'summary' });
    return r.item.lead?.run_state;
  };

  it('session → live, report → reported, then stale after STALE_AFTER', async () => {
    d = startDomain();
    const id = lead(d);
    const r = d.read();
    d.services.runs.recordSignal(r, {
      run_id: id,
      kind: 'session',
      session_id: 'seed-session-RCP-14',
    });
    expect(await runState(d)).toBe('live');
    d.clock.advance(minutes(3));
    expect(await runState(d)).toBe('reported');
    d.services.runs.recordSignal(d.read(), { run_id: id, kind: 'report', session_id: 'other' });
    expect(d.row('SELECT last_signal_kind FROM runs WHERE id = ?', id)).toEqual({
      last_signal_kind: 'report',
    });
    expect(await runState(d)).toBe('reported');
    d.clock.advance(minutes(31));
    expect(await runState(d)).toBe('stale');
  });

  it('a relayed signal (subagent log naming a child run) marks the child, never the lead, and never live', () => {
    d = startDomain();
    const leadId = lead(d);
    const actor = d.agent('claude', {
      label: 'orca-w3',
      run_id: leadId,
      session_id: 'seed-session-RCP-14',
    });
    const { run_id: child } = d.write(actor, (w, s) =>
      s.runs.startRun(w, { id: 'RCP-14', parent_run_id: leadId, agent_label: 'explorer' }),
    );
    d.clock.advance(minutes(5));
    const leadBefore = d.row<{ last_signal_at: string }>(
      'SELECT last_signal_at FROM runs WHERE id = ?',
      leadId,
    );
    d.write(actor, (w, s) =>
      s.checklist.logSubagent(w, {
        id: 'RCP-14',
        name: 'explorer',
        outcome: 'Mapped 214 units',
        provenance: 'relayed',
        child_run_id: child,
      }),
    );
    expect(d.row('SELECT last_signal_kind, last_signal_at FROM runs WHERE id = ?', child)).toEqual({
      last_signal_kind: 'relayed',
      last_signal_at: d.clock.now().toISOString(),
    });
    // The log itself never implies a heartbeat for the lead.
    expect(d.row('SELECT last_signal_at FROM runs WHERE id = ?', leadId)).toEqual(leadBefore);
  });
});
