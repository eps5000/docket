import { describe, expect, it } from 'vitest';
import type { AgentRow, AgentsResponse, EpicCard, WorkItem, WorkResponse } from '@docket/shared';
import { withCardActivity } from '../../src/domain/work-card-activity.js';

const lead = (id: string, run_state: 'live' | 'reported' | 'stale' | 'parked') => ({
  client: 'codex',
  label: 'worker',
  run_id: id,
  run_state,
});

const item = (id: string, run_state: 'live' | 'reported' | 'stale' | 'parked'): WorkItem =>
  ({
    id,
    status: 'progress',
    epic: 'DKT-1',
    lead: lead(`run_${id}`, run_state),
    wait: undefined,
  }) as WorkItem;

const epic = (): EpicCard =>
  ({
    id: 'DKT-1',
    status: 'progress',
    lead: lead('run_epic', 'reported'),
    children: { total: 2, done: 0, by_status: { progress: 2 }, for_you: 0, queued: 0, blocked: 0 },
  }) as EpicCard;

const row = (
  id: string,
  run_state: AgentRow['run_state'],
  lease: AgentRow['lease'] = 'held',
  doing: string | null = 'Lead · Reviewing the source',
): AgentRow =>
  ({
    row_kind: 'run',
    run_id: id,
    item_id: id === 'run_epic' ? 'DKT-1' : id.slice(4),
    run_state,
    lease,
    doing,
    client: 'codex',
    label: 'worker',
    last_signal_at: '2026-11-28T05:00:00Z',
    producer: 'dkt-1-producer',
  }) as AgentRow;

const project = (items: WorkItem[], rows: AgentRow[], epics: EpicCard[] = [epic()]) =>
  withCardActivity({ layout: 'board', items, epics } as WorkResponse, { rows } as AgentsResponse);

describe('Work card activity', () => {
  it('shows Live only for an exact live lead with a held lease and its reported action', () => {
    const result = project(
      [item('DKT-41', 'live')],
      [row('run_DKT-41', 'live'), row('run_epic', 'reported')],
    );
    expect(result.items[0]?.activity).toMatchObject({
      state: 'live',
      action: 'Reviewing the source',
      actor: 'dkt-1-producer',
    });
    expect(result.epics[0]?.activity?.state).toBe('reported');
    expect(result.epics[0]?.child_activity).toMatchObject({
      state: 'live',
      action: 'DKT-41: Reviewing the source',
    });
  });

  it('keeps a recent report and an expired live lease out of Live', () => {
    const result = project(
      [item('DKT-41', 'reported'), item('DKT-42', 'live')],
      [row('run_DKT-41', 'reported'), row('run_DKT-42', 'live', 'expired')],
    );
    expect(result.items[0]?.activity?.state).toBe('reported');
    expect(result.items[1]?.activity?.state).toBe('stale');
  });

  it('shows stale, parked, explicit waits and missing evidence truthfully', () => {
    const parked = item('DKT-42', 'parked');
    const waiting = {
      ...item('DKT-43', 'reported'),
      lead: null,
      wait: { text: 'Waits for DKT-42' },
    };
    const result = project(
      [item('DKT-41', 'stale'), parked, waiting as WorkItem, item('DKT-44', 'live')],
      [
        row('run_DKT-41', 'stale'),
        row('run_DKT-42', 'parked', 'paused', 'Parked · waiting on the coordinator'),
      ],
    );
    expect(result.items.map((i) => i.activity?.state)).toEqual([
      'stale',
      'waiting',
      'waiting',
      'unknown',
    ]);
    expect(result.items[2]?.activity?.action).toBe('Waits for DKT-42');
  });
});
