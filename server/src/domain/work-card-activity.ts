/**
 * Project the existing run and wait evidence onto Work cards. This is a read
 * adapter: views.ts remains the owner of run-state calculation and the Agents
 * response supplies the exact run, lease and latest reported action.
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

const cleanAction = (value: string | null): string | null => {
  const action = value
    ?.replace(/^(?:Lead|Child run) · /, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!action) return null;
  return action.length > 220 ? `${action.slice(0, 219)}…` : action;
};

const actorOf = (lead: { client: string; label: string | null }, row?: AgentRow): string =>
  row?.producer ?? (lead.label ? `${lead.client} · ${lead.label}` : lead.client);

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
  const actor = actorOf(lead, row);
  if (!row || row.item_id !== item.id) {
    return { state: 'unknown', action: null, actor, observed_at: null };
  }
  const base = {
    action: cleanAction(row.doing),
    actor,
    observed_at: row.last_signal_at,
  };
  // A recent report does not prove a working session. A live run with a lost
  // lead lease likewise cannot be called Live.
  if (lead.run_state === 'live' && row.run_state === 'live' && row.lease === 'held') {
    return { ...base, state: 'live' };
  }
  if (row.run_state === 'parked' || row.run_state === 'needs_input') {
    return { ...base, state: 'waiting' };
  }
  if (row.run_state === 'stale' || row.lease === 'expired') {
    return { ...base, state: 'stale' };
  }
  if (row.run_state === 'failed') return { ...base, state: 'failed' };
  if (row.run_state === 'reported' && row.lease === 'held') {
    return { ...base, state: 'reported' };
  }
  return { ...base, state: 'unknown' };
}

function ticketActivity(item: WorkItem, rows: Map<string, AgentRow>): CardActivity | null {
  if (item.wait) {
    return {
      state: 'waiting',
      action: item.wait.text,
      actor: item.producer?.name ?? null,
      observed_at: null,
    };
  }
  if (item.producer?.between_workers && !item.lead) {
    return {
      state: 'waiting',
      action: 'Between workers',
      actor: item.producer.name,
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
        action: item.activity.action ? `${item.id}: ${item.activity.action}` : item.id,
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
