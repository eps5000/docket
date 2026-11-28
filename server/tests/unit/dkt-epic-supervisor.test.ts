import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const { assessSupervisor, precheckSafe, validMapping } = await import(
  /* @vite-ignore */ pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'tools',
      'dkt-epic-supervisor.mjs',
    ),
  ).href
);

const now = Date.parse('2026-11-28T06:00:00.000Z');
const supervisor = '48ca27d0-4847-4d2e-a2e5-6c6c74a2133e::C:/dkt-3-supervisor-readonly';
const producer = '48ca27d0-4847-4d2e-a2e5-6c6c74a2133e::C:/dkt-3-producer';
const mapping = {
  version: 1,
  entries: [
    {
      epic_id: 'DKT-3',
      automation_id: '11111111-2222-3333-4444-555555555555',
      workspace_id: supervisor,
      producer_run_id: 'run_parent',
      recorded_dispatch_id: 'ctx_original',
      current_producer_dispatch_id: 'ctx_current',
      producer_orca_run_id: 'run_orca',
      producer_workspace_id: producer,
    },
  ],
};

const worker = {
  dispatchId: 'ctx_current',
  runId: 'run_orca',
  workspace: producer,
  host: 'local',
  state: 'ready',
  liveness: 'live',
  agent: 'codex/gpt-6-sol',
};

// The injected read ports intentionally mimic untrusted JSON rather than typed app models.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const base = (): any => ({
  mapping,
  automation: {
    id: mapping.entries[0]!.automation_id,
    workspaceId: supervisor,
    workspaceMode: 'existing',
    enabled: true,
    agentId: 'codex',
  },
  worktree: { id: supervisor },
  ready: { status: 'ready' },
  dkt3: {
    item: {
      id: 'DKT-3',
      title: 'private title',
      runs: [
        {
          is_lead: true,
          run_id: 'run_parent',
          orchestrator: { dispatch_id: 'ctx_original' },
        },
      ],
    },
  },
  dkt12: {
    item: {
      id: 'DKT-12',
      epic: 'DKT-3',
      description_md: 'private text',
      runs: [
        {
          is_lead: true,
          run_id: 'run_child',
          orchestrator: { dispatch_id: 'ctx_child' },
        },
      ],
    },
  },
  agents: {
    rows: [
      { row_kind: 'run', run_id: 'run_parent', run_state: 'reported', lease: 'held' },
      { row_kind: 'run', run_id: 'run_child', run_state: 'reported', lease: 'held' },
    ],
  },
  audit: {
    settings: {
      enabled: true,
      more: false,
      targets: [
        { run_id: 'run_parent', dispatch_id: 'ctx_original' },
        { run_id: 'run_child', dispatch_id: 'ctx_child' },
      ],
    },
    status: {
      stale: false,
      last_error: null,
      last_success_at: new Date(now - 30_000).toISOString(),
    },
  },
  inventory: {
    complete: true,
    workers: [
      worker,
      {
        dispatchId: 'ctx_child',
        workspace: supervisor,
        host: 'local',
        state: 'succeeded',
        liveness: 'exited',
      },
    ],
  },
  producerWorker: worker,
  relay: { running: true, hold: null, docket: { connected: true } },
  now,
});

describe('Docket-only Epic supervisor', () => {
  it('requires one exact DKT-3 automation and a distinct producer worktree', () => {
    expect(validMapping(mapping)).toBe(true);
    expect(
      validMapping({ ...mapping, entries: [{ ...mapping.entries[0], workspace_id: producer }] }),
    ).toBe(false);
    expect(validMapping({ ...mapping, entries: [mapping.entries[0], mapping.entries[0]] })).toBe(
      false,
    );
  });

  it('skips a scheduled start while the supervisor or unknown custody is live', () => {
    expect(precheckSafe(mapping, { complete: true, workers: [worker] })).toBe(true);
    expect(
      precheckSafe(mapping, { complete: true, workers: [{ ...worker, workspace: supervisor }] }),
    ).toBe(false);
    expect(precheckSafe(mapping, { complete: true, workers: [{ ...worker, host: null }] })).toBe(
      false,
    );
    expect(precheckSafe(mapping, { complete: false, workers: [] })).toBe(false);
  });

  it('identifies the mapped producer separately from a live reviewer and surfaces a lost child', () => {
    const input = base();
    input.inventory.workers.push({ ...worker, dispatchId: 'ctx_reviewer', agent: 'claude/opus' });
    const output = assessSupervisor(input);
    expect(output).toMatchObject({
      status: 'problem',
      dkt3: 'active',
      dkt12: 'lost_worker',
      next_actor: 'dkt-3-producer',
    });
    expect(JSON.stringify(output)).not.toContain('private');
    expect(JSON.stringify(output)).not.toContain('ctx_');
  });

  it('holds on a possible second Codex producer or a mismatched current Dispatch', () => {
    const input = base();
    input.inventory.workers.push({ ...worker, dispatchId: 'ctx_other' });
    expect(assessSupervisor(input)).toMatchObject({
      status: 'hold',
      reason: 'competing_producer_possible',
    });
    input.inventory.workers.pop();
    input.producerWorker = { ...worker, workspace: supervisor };
    expect(assessSupervisor(input)).toMatchObject({
      status: 'hold',
      reason: 'producer_identity_unknown',
    });
  });

  it('reports a named future coordinator wait without promising automatic resumption', () => {
    const input = base();
    const waiting_on = {
      orchestrator: true,
      person: false,
      items: [],
      until: null,
      wake: {
        actor: 'orca',
        event: 'reviewed external gate',
        due_at: new Date(now + 60_000).toISOString(),
      },
    };
    input.agents.rows[0].run_state = 'parked';
    input.agents.rows[0].lease = 'paused';
    input.dkt3.item.runs[0].parked = { waiting_on };
    input.agents.rows[1].run_state = 'parked';
    input.agents.rows[1].lease = 'paused';
    input.dkt12.item.runs[0].parked = { waiting_on };
    expect(assessSupervisor(input)).toMatchObject({
      status: 'ok',
      dkt3: 'waiting',
      dkt12: 'waiting',
    });
  });

  it('escalates only after the bounded retry window, and holds malformed wakes', () => {
    const input = base();
    input.agents.rows[0].run_state = 'parked';
    input.agents.rows[0].lease = 'paused';
    input.dkt3.item.runs[0].parked = {
      waiting_on: {
        orchestrator: true,
        person: false,
        items: [],
        wake: {
          actor: 'orca',
          event: 'reviewed gate',
          due_at: new Date(now - 11 * 60_000).toISOString(),
        },
      },
    };
    expect(assessSupervisor(input)).toMatchObject({ status: 'problem', dkt3: 'stalled' });
    input.dkt3.item.runs[0].parked.waiting_on.wake.event = '';
    expect(assessSupervisor(input)).toMatchObject({ status: 'hold', reason: 'state_unknown' });
  });

  it('holds incomplete audits and an unavailable or disabled supervisor', () => {
    const input = base();
    input.audit.settings.more = true;
    expect(assessSupervisor(input)).toMatchObject({
      status: 'hold',
      reason: 'source_or_supervisor_unknown',
    });
    input.audit.settings.more = false;
    input.automation.enabled = false;
    expect(assessSupervisor(input)).toMatchObject({
      status: 'hold',
      reason: 'source_or_supervisor_unknown',
    });
  });
});
