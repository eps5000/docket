/**
 * Project the existing run and wait evidence onto Work cards. This is a read
 * adapter: views.ts remains the owner of run-state calculation and the Agents
 * response supplies the exact run and lease. Free-form run text never reaches
 * these compact owner-facing cards.
 */
import type {
  AgentRow,
  AgentsResponse,
  CardActivity,
  EpicCard,
  WorkItem,
  WorkResponse,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { cardGithubOf } from './sync.js';

/** Return only a fixed phrase; summaries, paths, IDs and secrets are never echoed. */
function classifiedAction(doing: string | null): string {
  if (!doing) return 'Working on this item';
  if (/\b(review(?:ing)?|inspect(?:ing)?|audit(?:ing)?)\b/i.test(doing)) return 'Reviewing work';
  if (/\b(test(?:ing)?|checks?|verif(?:y|ying)|validat(?:e|ing))\b/i.test(doing))
    return 'Running checks';
  if (/\b(implement(?:ing)?|cod(?:e|ing)|fix(?:ing)?|edit(?:ing)?)\b/i.test(doing))
    return 'Updating work';
  if (/\b(investigat(?:e|ing)|diagnos(?:e|ing)|triag(?:e|ing))\b/i.test(doing))
    return 'Investigating';
  return 'Working on this item';
}

function classifiedWait(wait: NonNullable<WorkItem['wait']>): string {
  if (wait.kind === 'queued') return 'Queued behind another item';
  if (wait.kind === 'blocked') return 'Blocked by a dependency';
  if (wait.reason === 'paused') return 'Project is paused';
  if (wait.reason === 'decision') return 'Waiting for an owner decision';
  return 'Work is held';
}

function runActivity(
  item: Pick<WorkItem | EpicCard, 'id' | 'lead' | 'status'>,
  rows: Map<string, AgentRow>,
): CardActivity | null {
  const lead = item.lead;
  if (!lead)
    return item.status === 'progress' || item.status === 'review'
      ? { state: 'unknown', action: null, actor: null, observed_at: null }
      : null;
  const row = rows.get(lead.run_id);
  if (!row || row.item_id !== item.id) {
    return { state: 'unknown', action: null, actor: null, observed_at: null };
  }
  const base = {
    actor: 'Lead',
    observed_at: row.last_signal_at,
  };
  // A recent report does not prove a working session. A live run with a lost
  // lead lease likewise cannot be called Live.
  if (lead.run_state === 'live' && row.run_state === 'live' && row.lease === 'held') {
    return { ...base, state: 'live', action: classifiedAction(row.doing) };
  }
  if (row.run_state === 'parked' || row.run_state === 'needs_input') {
    return {
      ...base,
      state: 'waiting',
      action: row.run_state === 'needs_input' ? 'Waiting for input' : 'Work is paused',
    };
  }
  if (row.run_state === 'stale' || row.lease === 'expired') {
    return { ...base, state: 'stale', action: 'Latest update is out of date' };
  }
  if (row.run_state === 'failed') return { ...base, state: 'failed', action: 'Run failed' };
  if (row.run_state === 'reported' && row.lease === 'held') {
    return { ...base, state: 'reported', action: 'Recent activity reported' };
  }
  return { ...base, state: 'unknown', action: null };
}

function ticketActivity(item: WorkItem, rows: Map<string, AgentRow>): CardActivity | null {
  if (item.wait) {
    return {
      state: 'waiting',
      action: classifiedWait(item.wait),
      actor: null,
      observed_at: null,
    };
  }
  if (item.producer?.between_workers && !item.lead) {
    return {
      state: 'waiting',
      action: 'Between workers',
      actor: 'Producer',
      observed_at: null,
    };
  }
  return runActivity(item, rows);
}

/** One bounded Agents read, keyed by exact Docket run ID, for the Work response. */
export function withCardActivity(
  work: WorkResponse,
  agents: AgentsResponse,
  db?: Db,
  now?: string,
): WorkResponse {
  const github =
    db && now
      ? cardGithubOf(
          db,
          now,
          work.items.map((item) => item.id),
          work.epics.map((epic) => epic.id),
        )
      : null;
  const rows = new Map(
    agents.rows
      .filter(
        (row): row is AgentRow & { run_id: string } =>
          row.row_kind === 'run' && row.run_id !== null,
      )
      .map((row) => [row.run_id, row]),
  );
  const items = work.items.map((item) => ({
    ...item,
    activity: ticketActivity(item, rows),
    ...(github ? { github: github.tickets.get(item.id) ?? null } : {}),
  }));
  const childActivity = new Map<string, CardActivity>();
  for (const item of items) {
    if (item.epic && item.activity?.state === 'live' && !childActivity.has(item.epic)) {
      childActivity.set(item.epic, {
        ...item.activity,
        action: item.activity.action ? `Child item: ${item.activity.action}` : 'Child item active',
      });
    }
  }
  const epics = work.epics.map((epic) => {
    const own = runActivity(epic, rows);
    return {
      ...epic,
      activity: own,
      child_activity: childActivity.get(epic.id) ?? null,
      ...(github ? { github: github.epics.get(epic.id) ?? null } : {}),
    };
  });
  return { ...work, items, epics };
}
