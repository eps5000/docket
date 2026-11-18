import type { ReactNode } from 'react';
import {
  STATUS_LABELS,
  WORKSPACE_STATE_LABELS,
  type HumanReviewState,
  type Status,
  type WorkspaceState,
} from '@docket/shared';
import { Icon, type IconName } from './icons';

/** The tone chips (UI_SPEC §4 Chip): always text, never colour alone. */
export type ChipKind = 'neutral' | 'warn' | 'ok' | 'bad' | 'info';

const TONE: Record<ChipKind, string> = {
  neutral: 'c-gray',
  warn: 'c-warn',
  ok: 'c-ok',
  bad: 'c-bad',
  info: 'c-info',
};

export function Chip({
  kind = 'neutral',
  icon,
  title,
  className,
  children,
}: {
  kind?: ChipKind;
  icon?: IconName;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={['chip', TONE[kind], className].filter(Boolean).join(' ')} title={title}>
      {icon && <Icon name={icon} small />}
      {children}
    </span>
  );
}

/** Work status (UI_SPEC §5): Inbox gray, Planning teal, Ready blue, In progress violet, Review amber, Done green, Canceled gray struck through. */
export function StatusChip({ status }: { status: Status }) {
  return <span className={`chip st-${status}`}>{STATUS_LABELS[status]}</span>;
}

/** What a done blocker still waits for (UI_SPEC §5). */
export type BlockerWait = 'merge' | 'verification';

/** "⊘ Blocked by RCP-12, …", or "(needs merge)" / "(needs your verification)" on a single waiting blocker. */
export function BlockedChip({
  blockers,
  waitingFor,
}: {
  blockers: readonly string[];
  waitingFor?: BlockerWait | null;
}) {
  if (blockers.length === 0) return null;
  const suffix =
    waitingFor === 'merge'
      ? ' (needs merge)'
      : waitingFor === 'verification'
        ? ' (needs your verification)'
        : '';
  return (
    <span className="chip c-bad">
      <span aria-hidden="true">⊘</span> Blocked by {blockers.join(', ')}
      {suffix}
    </span>
  );
}

export const HUMAN_REVIEW_CHIP: Record<HumanReviewState, { kind: ChipKind; label: string }> = {
  declared: { kind: 'neutral', label: 'Coming up' },
  ready: { kind: 'warn', label: 'Ready for you' },
  approved: { kind: 'ok', label: 'Approved' },
  deferred: { kind: 'info', label: 'Deferred · not verified' },
};

/** Human review state (UI_SPEC §5): Coming up gray, Ready for you amber, Approved green, Deferred · not verified blue. */
export function HumanReviewChip({ state }: { state: HumanReviewState }) {
  const m = HUMAN_REVIEW_CHIP[state];
  return (
    <Chip kind={m.kind} icon="person">
      {m.label}
    </Chip>
  );
}

const WORKSPACE_TONE: Record<WorkspaceState, ChipKind> = {
  in_use: 'info',
  parked: 'neutral',
  at_risk: 'warn',
  safe_to_prune: 'ok',
  unknown: 'neutral',
};

/** Agents → Workspaces state (UI_SPEC §6.6): At risk in --warn, Safe to prune in --ok. */
export function WorkspaceStateChip({ state }: { state: WorkspaceState }) {
  return <Chip kind={WORKSPACE_TONE[state]}>{WORKSPACE_STATE_LABELS[state]}</Chip>;
}
