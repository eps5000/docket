import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  SHARED_CHANGES,
  normaliseSharedPartKey,
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
  OVERLAP_STATE_TEXT,
  fileCount,
  findingText,
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
              {c.note && <span className="src grow">{c.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {decl.state === 'declared' && decl.declared_by && (
        <div className="src">Declared by {decl.declared_by}</div>
      )}

      <BranchRow itemId={itemId} branch={s.branch} closed={closed} />

      {live.length > 0 && (
        <>
          <h4>Overlaps</h4>
          {live.map((o) => {
            const other = o.items[0].id === itemId ? o.items[1] : o.items[0];
            return (
              <div key={o.id} className="lrow" data-overlap={o.id}>
                <span>
                  Overlaps <Link to={paths.item(other.id)}>{other.id}</Link> on {partsText(o.parts)}
                </span>
                <Chip kind={o.state === 'open' ? 'warn' : 'neutral'}>
                  {OVERLAP_STATE_TEXT[o.state]}
                </Chip>
              </div>
            );
          })}
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
          {s.findings.map((f) => {
            const { other, branch } = findingText(f, itemId);
            const mine = f.item_a?.id === itemId ? f.source_a : f.source_b;
            return (
              <div key={f.id} className="lrow" data-finding={f.id}>
                <Chip kind="bad">conflict ahead</Chip>
                <span>
                  Heading for a conflict with {other} ({branch}): {fileCount(f.files.length)}
                </span>
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
 * The item's branch for the conflict radar (B40): reported (by an agent or
 * you), found by the radar, or several matching (the radar then uses none).
 * *Set branch* reports one; *Clear* lets the radar look again. Both are
 * undoable.
 */
function BranchRow({
  itemId,
  branch: b,
  closed,
}: {
  itemId: string;
  branch: ItemSharedResponse['branch'];
  closed: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const reported = b.source === 'reported';
  const clear = async () => {
    setBusy(true);
    try {
      await runOwnerMutation(
        () => apiClient['itemShared.branch']({ params: { id: itemId }, body: { branch: null } }),
        {
          success: `Cleared ${itemId}’s branch; the radar looks for one.`,
          refetch: [queryKeys.itemShared(itemId)],
        },
      );
      await qc.invalidateQueries({ queryKey: queryKeys.itemShared(itemId) });
    } catch (err) {
      showToast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h4>Branch</h4>
      <div className="lrow" data-branch-source={b.source ?? 'none'}>
        {b.name === null ? (
          b.matches.length > 0 ? (
            <Callout tone="warn" className="grow">
              Several branches match; report the branch:{' '}
              <span className="mono">{b.matches.join(', ')}</span>
            </Callout>
          ) : (
            <span className="src grow">
              No branch yet. The radar looks for a local branch named after the item.
            </span>
          )
        ) : reported ? (
          <span className="grow">
            <span className="mono">{b.name}</span>
            {b.reported_by && (
              <span className="src">
                {' · reported by '}
                {b.reported_by === 'owner' ? 'you' : b.reported_by}
              </span>
            )}
          </span>
        ) : (
          <span className="grow">
            Branch found by the radar: <span className="mono">{b.name}</span>
          </span>
        )}
        {!closed && (
          <Button size="sm" onClick={() => setEditing(true)}>
            {reported ? 'Change branch' : 'Set branch'}
          </Button>
        )}
        {!closed && reported && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void clear()}>
            Clear<span className="sr"> branch</span>
          </Button>
        )}
      </div>
      {editing && (
        <BranchDialog
          itemId={itemId}
          initial={b.name ?? b.matches[0] ?? ''}
          suggestions={b.matches}
          onClose={() => setEditing(false)}
        />
      )}
    </>
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
        () => apiClient['itemShared.branch']({ params: { id: itemId }, body: { branch } }),
        {
          success: `Set ${itemId}’s branch to ${branch}.`,
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
      title={`Branch · ${itemId}`}
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
        The branch the conflict radar trial-merges for this item. It replaces any branch the radar
        found.
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
}

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
      ? declaration.changes.map((c) => ({ part: c.part, change: c.change, note: c.note ?? '' }))
      : [{ part: '', change: 'change', note: '' }],
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
        keys.push(k.key);
      }
      const fresh = [...new Set(keys.filter((k) => !known.has(k)))];
      body = {
        changes: filled.map((r, i) => ({
          part: keys[i]!,
          change: r.change,
          ...(r.note.trim() ? { note: r.note.trim() } : {}),
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
        <span className="mono">model:Token</span> or <span className="mono">table:decks</span>.
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
            onClick={() => setRows((all) => [...all, { part: '', change: 'change', note: '' }])}
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
