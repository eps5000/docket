/**
 * Small badges: TypeBadge / TypeIcon, RunState, Provenance, DecisionAuthority,
 * Priority (UI_SPEC §4–§5).
 */
import {
  DECISION_AUTHORITY_LABELS,
  RUN_STATE_LABELS,
  type DecisionAuthority,
  type ItemType,
  type Priority as PriorityValue,
  type RunState as RunStateValue,
} from '@tasklite/shared';
import { Icon, TypeGlyph, type IconName } from './icons';

// ---- TypeBadge / TypeIcon ----

/** 16px square in the type colour with a glyph, plus the name. */
export function TypeBadge({ type, iconOnly = false }: { type: ItemType; iconOnly?: boolean }) {
  const cls = `type t-${type.toLowerCase()}${iconOnly ? ' iconly' : ''}`;
  return (
    <span className={cls} title={iconOnly ? type : undefined}>
      <span className="tsq">
        <TypeGlyph type={type} />
      </span>
      {iconOnly ? <span className="sr">{type}</span> : type}
    </span>
  );
}

/** Icon-only, with an sr-only name (board cards and tabs). */
export function TypeIcon({ type }: { type: ItemType }) {
  return <TypeBadge type={type} iconOnly />;
}

// ---- RunState ----

const RUN_GLYPH: Partial<Record<RunStateValue, string>> = {
  needs_input: '?',
  failed: '×',
  finished: '✓',
  interrupted: '–',
};

/**
 * Icon shape + label + `title` with the one-line meaning (UI_SPEC §5; labels
 * and meanings from shared). `detail` follows the label: an age ("· 40s") or,
 * for parked runs, what it waits on ("· waiting on RCP-12").
 */
export function RunState({
  state,
  age,
  detail,
}: {
  state: RunStateValue;
  age?: string;
  detail?: string;
}) {
  const m = RUN_STATE_LABELS[state];
  const tail = [detail, age].filter(Boolean).join(' · ');
  return (
    <span className={`run run-${state}`} title={m.meaning}>
      <i className={`ri ri-${state}`} aria-hidden="true">
        {RUN_GLYPH[state] ?? ''}
      </i>
      <span>
        {m.label}
        {tail ? ` · ${tail}` : ''}
      </span>
    </span>
  );
}

// ---- Provenance ----

export type ProvenanceKind =
  | 'owner_approve'
  | 'owner_changes'
  | 'owner_defer'
  | 'observed'
  | 'agent'
  | 'relayed'
  | 'ci'
  | 'git';

export const PROVENANCE: Record<ProvenanceKind, { cls: string; icon: IconName; label: string }> = {
  // Only an owner decision is solid-filled; only green means human approval (Principle III).
  owner_approve: { cls: 'pv-owner-approve', icon: 'person', label: 'Your decision' },
  owner_changes: { cls: 'pv-owner-changes', icon: 'person', label: 'Your decision' },
  owner_defer: { cls: 'pv-owner-defer', icon: 'person', label: 'Your decision' },
  observed: { cls: 'pv-observed', icon: 'eye', label: 'Observed child run' },
  agent: { cls: 'pv-agent', icon: 'bot', label: 'Agent-reported' },
  relayed: { cls: 'pv-relayed', icon: 'relay', label: 'Relayed by lead' },
  ci: { cls: 'pv-ci', icon: 'gear', label: 'CI' },
  git: { cls: 'pv-git', icon: 'git', label: 'Git · not approval' },
};

/** Who asserted it and how we know (UI_SPEC §5). With `label`, the kind stays readable to screen readers. */
export function Provenance({ kind, label }: { kind: ProvenanceKind; label?: string }) {
  const m = PROVENANCE[kind];
  return (
    <span className={`prov ${m.cls}`} title={m.label} data-provenance={kind}>
      <Icon name={m.icon} />
      {label ? (
        <>
          <span className="sr">{m.label}: </span>
          {label}
        </>
      ) : (
        m.label
      )}
    </span>
  );
}

// ---- Decision authority ----

/**
 * Decision records' authority (UI_SPEC §5): Owner is an `--ink-2` outline with
 * a person icon, Agent a dashed violet outline. Never solid, so it can't be
 * mistaken for review approval.
 */
export function DecisionAuthorityBadge({
  authority,
  agent,
}: {
  authority: DecisionAuthority;
  /** The agent's name: "Agent · claude". */
  agent?: string;
}) {
  return (
    <span className={`auth auth-${authority}`} title={DECISION_AUTHORITY_LABELS[authority]}>
      <Icon name={authority === 'owner' ? 'person' : 'bot'} />
      {authority === 'owner' ? 'Owner' : `Agent${agent ? ` · ${agent}` : ''}`}
    </span>
  );
}

// ---- Priority ----

/** Three signal bars plus a `title` and sr text. Never coloured. */
export function Priority({ p }: { p: PriorityValue }) {
  return (
    <span className="prio" title={`Priority ${p}`}>
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {[0, 1, 2].map((k) => (
          <rect
            key={k}
            x={k * 4}
            y={8 - k * 3}
            width="3"
            height={4 + k * 3}
            rx=".6"
            className={k < 4 - p ? 'on' : 'off'}
          />
        ))}
      </svg>
      <span className="sr">Priority </span>P{p}
    </span>
  );
}
