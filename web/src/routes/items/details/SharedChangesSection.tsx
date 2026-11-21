import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  SHARED_CHANGES,
  normaliseSharedPartKey,
  splitPartMember,
  type ItemDetailResponse,
  type ItemSharedResponse,
  type SharedChange,
} from '@docket/shared';
import {
  Button,
  Callout,
  Chip,
  Dialog,
  DialogCancel,
  EmptyState,
  Section,
  Skeleton,
} from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { QueryState } from '../../../app/QueryState';
import { HelpLink } from '../../../help/HelpLink';
import { queryKeys } from '../../../lib/api';
import { formatClock, isoTitle } from '../../../lib/format';
import { paths } from '../../../lib/paths';
import { runOwnerMutation, showToast } from '../../../lib/undo';
import { errorText } from '../../agent-files/install-common';
import {
  ChangeChip,
  OVERLAP_REASON_WORDS,
  fileCount,
  findingText,
  overlapOutcomeText,
  partLabel,
  partsText,
} from '../../shared/sharedChanges';

/**
 * Shared changes (UI_SPEC §6.3.6; owner decision 36): the parts the item
 * declares it will change (or "None", or "Not declared yet"), its overlaps
 * with other items, the leases it holds (with *Release lease*), held
 * hand-offs and radar findings. *Edit* opens the declaration editor.
 */
export function SharedChangesSection({ data }: { data: ItemDetailResponse }) {
  const id = data.item.id;
  const query = useQuery({
    queryKey: queryKeys.itemShared(id),
    queryFn: () => apiClient['itemShared.get']({ params: { id } }),
  });
  const [editing, setEditing] = useState(false);
  const closed = data.item.status === 'done' || data.item.status === 'canceled';
  const d = query.data;
  const summary = !d
    ? undefined
    : d.declaration.state === 'declared'
      ? `${d.declaration.changes.length} ${d.declaration.changes.length === 1 ? 'part' : 'parts'}`
      : d.declaration.state === 'none'
        ? 'none'
        : 'not declared';
  return (
    <Section
      sectionKey="shared"
      title="Shared changes"
      summary={summary}
      extraHead={
        <div className="row" style={{ gap: 4 }}>
          {!closed && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit<span className="sr"> shared changes</span>
            </Button>
          )}
          <HelpLink anchor="item.shared-changes" />
        </div>
      }
    >
      <QueryState query={query} skeleton={<Skeleton lines={2} label="Loading shared changes" />}>
        {(s) => <SharedBody itemId={id} shared={s} closed={closed} />}
      </QueryState>
      {editing && d && (
        <DeclarationDialog
          itemId={id}
          project={data.item.project}
          declaration={d.declaration}
          onClose={() => setEditing(false)}
        />
      )}
    </Section>
  );
}

function SharedBody({
  itemId,
  shared: s,
  closed,
}: {
  itemId: string;
  shared: ItemSharedResponse;
  closed: boolean;
}) {
  const decl = s.declaration;
  const live = s.overlaps.filter((o) => o.state !== 'resolved');
  const openHolds = s.holds.filter((h) => h.state === 'open');
  return (
    <div className="shared-sec" data-shared-state={decl.state}>
      {decl.state === 'not_declared' ? (
        <Callout tone="warn">
          Not declared yet. Agents declare the shared parts an item will change (or none) before it
          moves to Ready.
        </Callout>
      ) : decl.state === 'none' ? (
        <div className="lrow">
          <span>None</span>
          <span className="src">
            Changes no shared part{decl.declared_by ? ` · declared by ${decl.declared_by}` : ''}
          </span>
        </div>
      ) : (
        <ul className="shared-list" aria-label="Declared shared parts">
          {decl.changes.map((c) => (
            <li key={c.part} className="lrow" data-part={c.part}>
              <span className="mono one">{c.part}</span>
              <ChangeChip change={c.change} />
              {c.design_impact === 'changes_approved_design' && (
                <Chip kind="warn">changes approved design</Chip>
              )}
              {c.disputed && <Chip kind="warn">ownership disputed</Chip>}
              {c.note && <span className="src grow">{c.note}</span>}
              {c.design_note && <span className="src grow">Design: {c.design_note}</span>}
            </li>
          ))}
        </ul>
      )}
      {decl.state === 'declared' && decl.declared_by && (
        <div className="src">Declared by {decl.declared_by}</div>
      )}

      <BranchesRow itemId={itemId} branches={s.branches} closed={closed} />

      {live.length > 0 && (
        <>
          <h4>Overlaps</h4>
          {live.map((o) => (
            <OverlapOutcomeRow key={o.id} itemId={itemId} overlap={o} closed={closed} />
          ))}
        </>
      )}

      {s.leases.length > 0 && (
        <>
          <h4>Leases</h4>
          {s.leases.map((l) => (
            <LeaseRow key={l.id} itemId={itemId} lease={l} />
          ))}
        </>
      )}

      {openHolds.length > 0 && (
        <>
          <h4>Held for you</h4>
          {openHolds.map((h) => (
            <div key={h.id} className="lrow" data-hold={h.id}>
              <span>Changed shared parts it didn’t declare: {partsText(h.parts)}</span>
              <Link to={paths.needsYou()} className="src">
                Decide in Needs you
              </Link>
            </div>
          ))}
        </>
      )}

      {s.findings.length > 0 && (
        <>
          <h4>Conflict radar</h4>
          <p className="src" style={{ margin: 0 }}>
            The radar sees committed local branches only. A clean trial merge means git can combine
            them, not that they work together.
          </p>
          {s.findings.map((f) => {
            const { other, branch, own } = findingText(f, itemId);
            const mine = f.item_a?.id === itemId ? f.source_a : f.source_b;
            return (
              <div key={f.id} className="lrow" data-finding={f.id}>
                <Chip kind="bad">conflict ahead</Chip>
                <span>
                  Heading for a conflict with {other}: {fileCount(f.files.length)} ·{' '}
                  <span className="mono">{own}</span> vs <span className="mono">{branch}</span>
                </span>
                {f.merge_first && (
                  <span className="src" data-merge-first={f.merge_first}>
                    {f.merge_first === itemId
                      ? 'This item merges first'
                      : `Rebases after ${f.merge_first} merges`}
                  </span>
                )}
                {mine === 'discovered' && <span className="src">branch found by the radar</span>}
                <span className="src mono one grow" title={f.files.join('\n')}>
                  {f.files.slice(0, 3).join(', ')}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/**
 * One overlap on the ticket (decision 39): who decided, why, on what evidence.
 * An outcome Docket chose can be overruled here (*Run in parallel*, *Run in
 * order*), with Undo on the toast.
 */
function OverlapOutcomeRow({
  itemId,
  overlap: o,
  closed,
}: {
  itemId: string;
  overlap: ItemSharedResponse['overlaps'][number];
  closed: boolean;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const other = o.items[0].id === itemId ? o.items[1] : o.items[0];
  const byDocket = o.decided_by === 'docket';
  const overrule = async (decision: 'parallel' | 'order') => {
    setBusy(true);
    try {
      await runOwnerMutation(
        () => apiClient['overlaps.overrule']({ params: { id: o.id }, body: { decision } }),
        {
          success:
            decision === 'order'
              ? `${o.items[1].id} now waits until ${o.items[0].id} is merged.`
              : `${o.items[0].id} and ${o.items[1].id} now run in parallel.`,
          refetch: [queryKeys.itemShared(itemId)],
        },
      );
      await qc.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      showToast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const changes = o.evidence?.changes ?? [];
  const textFiles = o.evidence?.text_conflict ?? [];
  return (
    <div className="shared-outcome" data-overlap={o.id} data-outcome={o.outcome ?? undefined}>
      <div className="lrow">
        <span>
          Overlaps <Link to={paths.item(other.id)}>{other.id}</Link> on {partsText(o.parts)}
        </span>
        <Chip kind={o.state === 'open' ? 'warn' : 'neutral'}>{overlapOutcomeText(o)}</Chip>
      </div>
      {o.reason && o.decided_by !== 'owner' && (
        <p className="src shared-why">
          {OVERLAP_REASON_WORDS[o.reason]}
          {o.outcome === 'sequence' && ` ${o.items[1].id} waits until ${o.items[0].id} is merged.`}
          {o.evidence?.design_note && ` Design: ${o.evidence.design_note}`}
        </p>
      )}
      {changes.length > 0 && (
        <ul className="sq-files mono" aria-label={`What the overlap with ${other.id} rests on`}>
          {changes.slice(0, 6).map((c) => (
            <li key={`${c.item}:${c.part}`}>
              {c.item} {c.change} {c.part}
            </li>
          ))}
          {changes.length > 6 && <li className="src">and {changes.length - 6} more</li>}
        </ul>
      )}
      {textFiles.length > 0 && (
        <p className="src shared-why">Lines collide in {textFiles.slice(0, 3).join(', ')}.</p>
      )}
      {byDocket && !closed && (
        <div className="row wrap" style={{ gap: 4 }}>
          {o.state !== 'compatible' && (
            <Button size="sm" disabled={busy} onClick={() => void overrule('parallel')}>
              Run in parallel<span className="sr"> with {other.id}</span>
            </Button>
          )}
          {o.state !== 'sequenced' && (
            <Button size="sm" disabled={busy} onClick={() => void overrule('order')}>
              Run in order<span className="sr"> with {other.id}</span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The item's branches for the conflict radar (B40; B41: several). The radar
 * trial-merges every reported branch (by an agent or you); with none, the one
 * local branch it found named after the item, or none when several match.
 * *Add branch* reports one; *Remove* on each takes it off, and removing the
 * last lets the radar look again. Both are undoable.
 */
function BranchesRow({
  itemId,
  branches: b,
  closed,
}: {
  itemId: string;
  branches: ItemSharedResponse['branches'];
  closed: boolean;
}) {
  const [adding, setAdding] = useState(false);
  // Removing a branch unmounts its focused button: focus moves to *Add branch* (B34).
  const addRef = useRef<HTMLButtonElement>(null);
  const reported = b.reported.length > 0;
  return (
    <>
      <h4>Branches</h4>
      {reported ? (
        <ul className="shared-list" aria-label="Reported branches">
          {b.reported.map((r) => (
            <BranchItem
              key={r.name}
              itemId={itemId}
              branch={r}
              closed={closed}
              onRemoved={() => addRef.current?.focus()}
            />
          ))}
        </ul>
      ) : b.discovered ? (
        <div className="lrow" data-branch-source="discovered">
          <span className="grow">
            Branch found by the radar: <span className="mono">{b.discovered}</span>
          </span>
        </div>
      ) : b.matches.length > 0 ? (
        <div className="lrow" data-branch-source="matches">
          <Callout tone="warn" className="grow">
            Several branches match; add the branch:{' '}
            <span className="mono">{b.matches.join(', ')}</span>
          </Callout>
        </div>
      ) : (
        <div className="lrow" data-branch-source="none">
          <span className="src grow">
            No branch yet. The radar looks for a local branch named after the item.
          </span>
        </div>
      )}
      {!closed && (
        <div className="row" style={{ gap: 4 }}>
          <Button ref={addRef} size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add branch
          </Button>
        </div>
      )}
      {adding && (
        <BranchDialog
          itemId={itemId}
          initial={reported ? '' : (b.discovered ?? b.matches[0] ?? '')}
          suggestions={reported ? [] : b.matches}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}

/** One reported branch, with who reported it and *Remove*. */
function BranchItem({
  itemId,
  branch: r,
  closed,
  onRemoved,
}: {
  itemId: string;
  branch: ItemSharedResponse['branches']['reported'][number];
  closed: boolean;
  onRemoved: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      const out = await runOwnerMutation(
        () =>
          apiClient['itemShared.branches']({
            params: { id: itemId },
            body: { op: 'remove', branch: r.name },
          }),
        {
          success: (res) =>
            res.branches.reported.length === 0
              ? `Removed ${r.name}; the radar looks for ${itemId}’s branch.`
              : `Removed ${r.name} from ${itemId}’s branches.`,
          refetch: [queryKeys.itemShared(itemId)],
        },
      );
      if (out) onRemoved();
      await qc.invalidateQueries({ queryKey: queryKeys.itemShared(itemId) });
    } catch (err) {
      showToast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="lrow" data-branch={r.name} data-branch-source="reported">
      <span className="mono one grow">{r.name}</span>
      {r.reported_by && (
        <span className="src" title={isoTitle(r.reported_at)}>
          reported by {r.reported_by === 'owner' ? 'you' : r.reported_by}
        </span>
      )}
      {!closed && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
          Remove<span className="sr"> branch {r.name}</span>
        </Button>
      )}
    </li>
  );
}

function BranchDialog({
  itemId,
  initial,
  suggestions,
  onClose,
}: {
  itemId: string;
  initial: string;
  suggestions: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { input: useId(), list: useId() };
  const save = async () => {
    const branch = value.trim();
    setError(null);
    if (branch === '') {
      setError('Type the branch the work is on.');
      return;
    }
    setBusy(true);
    try {
      const out = await runOwnerMutation(
        () =>
          apiClient['itemShared.branches']({
            params: { id: itemId },
            body: { op: 'add', branch },
          }),
        {
          success: `Added ${branch} to ${itemId}’s branches.`,
          refetch: [queryKeys.itemShared(itemId)],
        },
      );
      await qc.invalidateQueries({ queryKey: queryKeys.itemShared(itemId) });
      if (out) onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Add branch · ${itemId}`}
      onClose={onClose}
      footer={
        <>
          <DialogCancel onClick={onClose} />
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </>
      }
    >
      <p className="src" style={{ marginTop: 0 }}>
        A branch the work on this item is on. The conflict radar trial-merges every branch you or an
        agent report, instead of any branch it found by name.
      </p>
      <label className="f" htmlFor={ids.input}>
        Branch
      </label>
      <input
        id={ids.input}
        className="input mono"
        list={suggestions.length > 0 ? ids.list : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        placeholder="eps5000/gf-239-visual-shell"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
        }}
      />
      {suggestions.length > 0 && (
        <datalist id={ids.list}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      {error && (
        <Callout tone="bad" className="mt">
          {error}
        </Callout>
      )}
    </Dialog>
  );
}

function LeaseRow({
  itemId,
  lease,
}: {
  itemId: string;
  lease: ItemSharedResponse['leases'][number];
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const release = async () => {
    setBusy(true);
    try {
      await runOwnerMutation(() => apiClient['leases.release']({ params: { id: lease.id } }), {
        success: `Released the lease on ${partLabel(lease.part)}.`,
        refetch: [queryKeys.itemShared(itemId)],
      });
      await qc.invalidateQueries({ queryKey: queryKeys.itemShared(itemId) });
    } catch (err) {
      showToast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lrow" data-lease={lease.id}>
      <span className="mono one">{lease.part}</span>
      <span className="src grow" title={isoTitle(lease.expires_at)}>
        {lease.holder ? `held by ${lease.holder} · ` : ''}until {formatClock(lease.expires_at)}
      </span>
      <Button size="sm" disabled={busy} onClick={() => void release()}>
        Release lease<span className="sr"> on {lease.part}</span>
      </Button>
    </div>
  );
}

interface Row {
  part: string;
  change: SharedChange;
  note: string;
  /** Decision 39: this change alters an approved design; `designNote` says which. */
  designed: boolean;
  designNote: string;
  disputed: boolean;
}

const blankRow = (): Row => ({
  part: '',
  change: 'change',
  note: '',
  designed: false,
  designNote: '',
  disputed: false,
});

/**
 * The declaration editor: the same rules as `declare_shared_changes` (the
 * owner may also register a new part here). Each save replaces the whole
 * declaration, and is undoable.
 */
function DeclarationDialog({
  itemId,
  project,
  declaration,
  onClose,
}: {
  itemId: string;
  project: string;
  declaration: ItemSharedResponse['declaration'];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const registry = useQuery({
    queryKey: queryKeys.sharedParts(project),
    queryFn: () => apiClient['sharedParts.list']({ params: { key: project } }),
  });
  const [none, setNone] = useState(declaration.state === 'none');
  const [rows, setRows] = useState<Row[]>(
    declaration.changes.length > 0
      ? declaration.changes.map((c) => ({
          part: c.part,
          change: c.change,
          note: c.note ?? '',
          designed: c.design_impact === 'changes_approved_design',
          designNote: c.design_note ?? '',
          disputed: !!c.disputed,
        }))
      : [blankRow()],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { list: useId(), none: useId() };
  // Removing a row unmounts its focused button: focus moves to *Add a part* so the
  // dialog's focus trap (and Esc) keep working (B34).
  const addRef = useRef<HTMLButtonElement>(null);
  const known = new Set((registry.data?.parts ?? []).map((p) => p.key));
  const set = (i: number, patch: Partial<Row>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const save = async () => {
    setError(null);
    let body: Parameters<(typeof apiClient)['itemShared.put']>[0]['body'];
    if (none) body = { none: true };
    else {
      const filled = rows.filter((r) => r.part.trim() !== '');
      if (filled.length === 0) {
        setError('Name at least one part, or choose “Changes no shared part”.');
        return;
      }
      const keys: string[] = [];
      for (const r of filled) {
        const k = normaliseSharedPartKey(r.part);
        if (!k.ok) {
          setError(`“${r.part}” ${k.error}.`);
          return;
        }
        if (r.designed && !r.designNote.trim()) {
          setError(`Say which design, decision or acceptance criterion ${k.key} changes.`);
          return;
        }
        keys.push(k.key);
      }
      // Decision 39: a member of a registered part isn't a new part.
      const fresh = [...new Set(keys.filter((k) => !splitPartMember(k, (key) => known.has(key))))];
      body = {
        changes: filled.map((r, i) => ({
          part: keys[i]!,
          change: r.change,
          ...(r.note.trim() ? { note: r.note.trim() } : {}),
          ...(r.designed
            ? {
                design_impact: 'changes_approved_design' as const,
                design_note: r.designNote.trim(),
              }
            : {}),
          ...(r.disputed ? { disputed: true } : {}),
        })),
        ...(fresh.length > 0 ? { new_parts: fresh.map((key) => ({ key })) } : {}),
      };
    }
    setBusy(true);
    try {
      const out = await runOwnerMutation(
        () => apiClient['itemShared.put']({ params: { id: itemId }, body }),
        {
          success: (r) =>
            r.declaration.state === 'none'
              ? `Declared no shared changes on ${itemId}.`
              : `Saved ${itemId}’s shared changes${r.registered.length ? ` · registered ${r.registered.join(', ')}` : ''}.`,
          refetch: [queryKeys.itemShared(itemId)],
        },
      );
      await qc.invalidateQueries({ queryKey: queryKeys.itemShared(itemId) });
      if (out) onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Shared changes · ${itemId}`}
      onClose={onClose}
      footer={
        <>
          <DialogCancel onClick={onClose} />
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <p className="src" style={{ marginTop: 0 }}>
        The tables, models, endpoints and shared files this item will change. Name parts as{' '}
        <span className="mono">kind:name</span>, for example{' '}
        <span className="mono">model:Token</span> or <span className="mono">table:decks</span>. Add
        a member when you can (<span className="mono">model:Token.expiresAt</span>): adding
        different members runs in parallel, and a bare part could touch anything in it.
      </p>
      <label className="row" htmlFor={ids.none} style={{ gap: 6, margin: '6px 0 10px' }}>
        <input
          id={ids.none}
          type="checkbox"
          checked={none}
          onChange={(e) => setNone(e.target.checked)}
        />
        Changes no shared part
      </label>
      {!none && (
        <div className="shared-edit">
          <datalist id={ids.list}>
            {(registry.data?.parts ?? []).map((p) => (
              <option key={p.key} value={p.key} />
            ))}
          </datalist>
          {rows.map((r, i) => (
            <fieldset key={i} className="shared-edit-row" aria-label={`Part ${i + 1}`}>
              <label className="f" htmlFor={`${ids.list}-p${i}`}>
                Part
              </label>
              <input
                id={`${ids.list}-p${i}`}
                className="input mono"
                list={ids.list}
                autoComplete="off"
                spellCheck={false}
                placeholder="model:Token"
                value={r.part}
                onChange={(e) => set(i, { part: e.target.value })}
              />
              <label className="f" htmlFor={`${ids.list}-c${i}`}>
                Change
              </label>
              <select
                id={`${ids.list}-c${i}`}
                value={r.change}
                onChange={(e) => set(i, { change: e.target.value as SharedChange })}
              >
                {SHARED_CHANGES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <label className="f" htmlFor={`${ids.list}-n${i}`}>
                Note
              </label>
              <input
                id={`${ids.list}-n${i}`}
                className="input"
                maxLength={500}
                value={r.note}
                onChange={(e) => set(i, { note: e.target.value })}
              />
              <div className="shared-edit-extra">
                <label className="row" htmlFor={`${ids.list}-d${i}`} style={{ gap: 6 }}>
                  <input
                    id={`${ids.list}-d${i}`}
                    type="checkbox"
                    checked={r.designed}
                    onChange={(e) => set(i, { designed: e.target.checked })}
                  />
                  Changes an approved design
                </label>
                <label className="row" htmlFor={`${ids.list}-o${i}`} style={{ gap: 6 }}>
                  <input
                    id={`${ids.list}-o${i}`}
                    type="checkbox"
                    checked={r.disputed}
                    onChange={(e) => set(i, { disputed: e.target.checked })}
                  />
                  Ownership is disputed
                </label>
                {r.designed && (
                  <div className="shared-edit-design">
                    <label className="f" htmlFor={`${ids.list}-w${i}`}>
                      Which design, decision or acceptance criterion
                    </label>
                    <input
                      id={`${ids.list}-w${i}`}
                      className="input"
                      maxLength={500}
                      value={r.designNote}
                      onChange={(e) => set(i, { designNote: e.target.value })}
                    />
                  </div>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRows((all) => all.filter((_, j) => j !== i));
                  addRef.current?.focus();
                }}
                disabled={rows.length === 1}
              >
                Remove<span className="sr"> part {i + 1}</span>
              </Button>
            </fieldset>
          ))}
          <Button
            ref={addRef}
            size="sm"
            icon="plus"
            onClick={() => setRows((all) => [...all, blankRow()])}
          >
            Add a part
          </Button>
          {registry.data && registry.data.parts.length === 0 && (
            <EmptyState text="No parts registered yet. A new key you type here is registered when you save." />
          )}
        </div>
      )}
      {error && (
        <Callout tone="bad" className="mt">
          {error}
        </Callout>
      )}
    </Dialog>
  );
}
