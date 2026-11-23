import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import {
  TEXT_LIMITS,
  type ItemDetailResponse,
  type SplitCarryKind,
  type SplitRelation,
} from '@docket/shared';
import { Button, Callout, Dialog, DialogCancel } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { plural } from '../../lib/format';
import { runOwnerMutation, showToast } from '../../lib/undo';

type Choice = 'keep' | 'move' | 'copy';
type SplitType = 'Story' | 'Task' | 'Bug';

interface Row {
  key: string;
  kind: SplitCarryKind | 'criterion';
  /** What the server calls it: a 1-based position, an item ID, a part key or a step ID. */
  ref: string;
  text: string;
  /** Why it can't move, when it can't. */
  locked?: string;
}

const RELATIONS: { value: SplitRelation; label: (id: string) => string }[] = [
  { value: 'after_original', label: (id) => `The new ticket waits for ${id}` },
  { value: 'before_original', label: (id) => `${id} waits for the new ticket` },
  { value: 'none', label: () => 'Neither waits for the other' },
];

/** One thing that can stay, move or be copied. The select keeps it to one Tab stop. */
function ChoiceRow({
  row,
  value,
  onChange,
}: {
  row: Row;
  value: Choice;
  onChange: (next: Choice) => void;
}) {
  const id = useId();
  return (
    <div className="split-row" data-split-row={row.key}>
      <label htmlFor={id}>{row.text}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as Choice)}>
        <option value="keep">Keep here</option>
        <option value="move" disabled={!!row.locked}>
          {row.locked ? `Move (${row.locked})` : 'Move'}
        </option>
        <option value="copy">Copy</option>
      </select>
    </div>
  );
}

function ChoiceGroup({
  legend,
  rows,
  choices,
  onChange,
}: {
  legend: string;
  rows: Row[];
  choices: Record<string, Choice>;
  onChange: (key: string, next: Choice) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <fieldset className="split-group">
      <legend>{legend}</legend>
      {rows.map((row) => (
        <ChoiceRow
          key={row.key}
          row={row}
          value={choices[row.key] ?? 'keep'}
          onChange={(next) => onChange(row.key, next)}
        />
      ))}
    </fieldset>
  );
}

/**
 * Split ticket (owner decision 48; UI_SPEC §6.3): name the new ticket, choose
 * what moves, and see both tickets before anything changes. Every row is a
 * labelled select and the relation is a radio group, so it all works by
 * keyboard. A live lead keeps its claim, and the dialog says so.
 */
export function SplitDialog({ data, onClose }: { data: ItemDetailResponse; onClose: () => void }) {
  const { item } = data;
  const queryClient = useQueryClient();
  const ids = { title: useId(), type: useId(), relation: useId() };
  const titleRef = useRef<HTMLInputElement>(null);
  // The version the dialog opened at: a change while it is open is a conflict, not an overwrite.
  const [version] = useState(item.version);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<SplitType>(item.type === 'Epic' ? 'Task' : item.type);
  const [relation, setRelation] = useState<SplitRelation>('after_original');
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shared = useQuery({
    queryKey: queryKeys.itemShared(item.id),
    queryFn: () => apiClient['itemShared.get']({ params: { id: item.id } }),
  });

  const criteria: Row[] = item.acceptance.map((text, i) => ({
    key: `criterion:${i + 1}`,
    kind: 'criterion',
    ref: String(i + 1),
    text,
  }));
  const blockers: Row[] = item.links.blocked_by.map((l) => ({
    key: `blocker:${l.id}`,
    kind: 'blocker',
    ref: l.id,
    text: `${l.id} ${l.title}`,
  }));
  const parts: Row[] = (shared.data?.declaration.changes ?? []).map((c) => ({
    key: `part:${c.part}`,
    kind: 'part',
    ref: c.part,
    text: c.part,
  }));
  const steps: Row[] = item.checklist.work.map((s) => ({
    key: `step:${s.id}`,
    kind: 'step',
    ref: s.id,
    text: s.text,
    ...(item.lead && s.state === 'current' ? { locked: 'the lead is on it' } : {}),
  }));
  const carried = [...blockers, ...parts, ...steps];
  const all = [...criteria, ...carried];
  const choiceOf = (row: Row) => choices[row.key] ?? 'keep';
  const going = all.filter((r) => choiceOf(r) !== 'keep');
  const staying = all.filter((r) => choiceOf(r) !== 'move');
  const movedCriteria = criteria.filter((r) => choiceOf(r) === 'move');
  const set = (key: string, next: Choice) => {
    setError(null);
    setChoices((c) => ({ ...c, [key]: next }));
  };

  const submit = async () => {
    const name = title.trim();
    if (!name) {
      setError('Give the new ticket a title.');
      titleRef.current?.focus();
      return;
    }
    if (going.length === 0) {
      setError('Choose at least one thing to move or copy to the new ticket.');
      return;
    }
    if (criteria.length > 0 && movedCriteria.length === criteria.length) {
      setError(`${item.id} must keep at least one acceptance criterion. Keep or copy one.`);
      return;
    }
    const positions = (choice: Choice) =>
      criteria.filter((r) => choiceOf(r) === choice).map((r) => Number(r.ref));
    const also = carried
      .filter((r) => choiceOf(r) !== 'keep')
      .map((r) => ({
        kind: r.kind as SplitCarryKind,
        id: r.ref,
        ...(choiceOf(r) === 'copy' ? { copy: true } : {}),
      }));
    const copy = positions('copy');
    setBusy(true);
    try {
      const res = await runOwnerMutation(
        () =>
          apiClient['items.split']({
            params: { id: item.id },
            body: {
              expected_version: version,
              type,
              title: name,
              move: positions('move'),
              relation,
              ...(copy.length > 0 ? { copy } : {}),
              ...(also.length > 0 ? { also } : {}),
            },
          }),
        {
          success: (r) => `Split ${r.item.id} from ${item.id}.`,
          refetch: [queryKeys.item(item.id)],
        },
      );
      if (res) await queryClient.invalidateQueries({ queryKey: queryKeys.all });
      onClose();
    } catch (err) {
      showToast(
        err instanceof Error && err.message ? err.message : 'Couldn’t split it. Try again.',
      );
      setBusy(false);
    }
  };

  const preview = (rows: Row[]) =>
    rows.length === 0 ? (
      <p className="src">Nothing yet</p>
    ) : (
      <ul>
        {rows.map((r) => (
          <li key={r.key}>
            <span className="src">{NOUN[r.kind]}:</span> {r.text}
            {choiceOf(r) === 'copy' && <span className="src"> (copy)</span>}
          </li>
        ))}
      </ul>
    );

  return (
    <Dialog
      title={`Split ${item.id}`}
      onClose={onClose}
      className="split-dlg"
      initialFocus={() => titleRef.current}
      footer={
        <>
          {error && (
            <span className="bad-text split-error" role="alert">
              {error}
            </span>
          )}
          <DialogCancel onClick={onClose} />
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            Split ticket
          </Button>
        </>
      }
    >
      {item.lead && (
        <Callout tone="warn" className="split-note" role="status">
          <b>{item.lead.label ?? item.lead.client} is working on this ticket.</b> It keeps its
          claim, runs and reviews here, and sees the change the next time it reads the ticket.
        </Callout>
      )}
      {data.open_packet && movedCriteria.length > 0 && (
        <Callout tone="warn" className="split-note" role="status">
          Moving criteria marks the open review packet out of date. The packet itself doesn’t
          change.
        </Callout>
      )}
      <div className="split-fields">
        <div>
          <label htmlFor={ids.title}>New ticket title</label>
          <input
            id={ids.title}
            ref={titleRef}
            className="input"
            value={title}
            maxLength={TEXT_LIMITS.title}
            autoComplete="off"
            onChange={(e) => {
              setError(null);
              setTitle(e.target.value);
            }}
          />
        </div>
        <div>
          <label htmlFor={ids.type}>Type</label>
          <select id={ids.type} value={type} onChange={(e) => setType(e.target.value as SplitType)}>
            <option>Story</option>
            <option>Task</option>
            <option>Bug</option>
          </select>
        </div>
      </div>
      <ChoiceGroup legend="Acceptance criteria" rows={criteria} choices={choices} onChange={set} />
      <ChoiceGroup legend="Blockers" rows={blockers} choices={choices} onChange={set} />
      <ChoiceGroup legend="Shared parts" rows={parts} choices={choices} onChange={set} />
      <ChoiceGroup legend="Checklist steps" rows={steps} choices={choices} onChange={set} />
      <fieldset className="split-group">
        <legend>How they relate</legend>
        {RELATIONS.map((r) => (
          <label className="split-radio" key={r.value}>
            <input
              type="radio"
              name={ids.relation}
              value={r.value}
              checked={relation === r.value}
              onChange={() => setRelation(r.value)}
            />{' '}
            {r.label(item.id)}
          </label>
        ))}
      </fieldset>
      <section className="split-preview" aria-label="What will happen" aria-live="polite">
        <div>
          <h3>Stays on {item.id}</h3>
          <p className="src">{plural(staying.length, 'entry', 'entries')}</p>
          {preview(staying)}
        </div>
        <div>
          <h3>On the new ticket</h3>
          <p className="src">{plural(going.length, 'entry', 'entries')}</p>
          {preview(going)}
        </div>
      </section>
    </Dialog>
  );
}

const NOUN: Record<Row['kind'], string> = {
  criterion: 'Criterion',
  blocker: 'Blocker',
  part: 'Shared part',
  step: 'Step',
};
