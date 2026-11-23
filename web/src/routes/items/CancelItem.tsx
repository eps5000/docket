import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ItemDetailResponse } from '@docket/shared';
import { Button, IconButton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { SplitDialog } from './SplitItem';

/**
 * The item header's "⋯" overflow with *Split ticket…* (decision 48) and
 * *Cancel item…* (UI_SPEC §6.3; owner decision 23; FR-064b). Cancel opens an inline confirm, "Cancel RCP-31?
 * Optional reason", with *Keep item* focused and *Cancel item*:
 * - an epic with open children lists them instead, with no Cancel button;
 * - an item an agent leads adds "codex is working on this; its run will be
 *   interrupted.";
 * - afterwards a toast with Undo (it restores the status, not the run).
 */
export function CancelMenu({ data }: { data: ItemDetailResponse }) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [split, setSplit] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (menu) first.current?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const root = trigger.current?.closest('.overflow');
      if (root && !root.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  const closeMenu = () => {
    setMenu(false);
    trigger.current?.focus();
  };

  return (
    <>
      <span className="overflow">
        <IconButton
          ref={trigger}
          icon="more"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        />
        {menu && (
          <div
            className="menu"
            role="menu"
            aria-label="More actions"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeMenu();
              }
            }}
          >
            {data.item.type !== 'Epic' && (
              <button
                ref={first}
                type="button"
                role="menuitem"
                onClick={() => {
                  // Focus returns here when the dialog closes.
                  closeMenu();
                  setSplit(true);
                }}
              >
                Split ticket…
              </button>
            )}
            <button
              ref={data.item.type === 'Epic' ? first : undefined}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                setConfirm(true);
              }}
            >
              Cancel item…
            </button>
          </div>
        )}
      </span>
      {split && <SplitDialog data={data} onClose={() => setSplit(false)} />}
      {confirm && (
        <CancelConfirm
          data={data}
          onDone={() => {
            setConfirm(false);
            trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}

function CancelConfirm({ data, onDone }: { data: ItemDetailResponse; onDone: () => void }) {
  const { item } = data;
  const queryClient = useQueryClient();
  const keep = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const openChildren =
    item.type === 'Epic'
      ? data.children.filter((c) => !['done', 'canceled'].includes(c.status))
      : [];
  const lead = item.lead;

  useEffect(() => {
    keep.current?.focus();
  }, []);

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await runOwnerMutation(
        () =>
          apiClient['items.cancel']({
            params: { id: item.id },
            body: {
              expected_version: item.version,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            },
          }),
        { success: `Canceled ${item.id}.`, refetch: [queryKeys.item(item.id)] },
      );
      if (res) await queryClient.invalidateQueries({ queryKey: queryKeys.all });
      onDone();
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : 'Couldn’t cancel. Try again.');
      setBusy(false);
    }
  };

  return (
    <div
      className="cancelconf"
      role="group"
      aria-label={`Cancel ${item.id}`}
      data-cancel-confirm=""
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onDone();
        }
      }}
    >
      <div className="card pad cancelbox">
        {openChildren.length > 0 ? (
          <>
            <div>
              <b>{item.id} can’t be canceled yet.</b> Finish or cancel its open items first:
            </div>
            <ul className="openkids">
              {openChildren.map((c) => (
                <li key={c.id}>
                  <Link to={paths.item(c.id)} className="mono">
                    {c.id}
                  </Link>{' '}
                  {c.title}
                </li>
              ))}
            </ul>
            <div className="row">
              <Button ref={keep} size="sm" onClick={onDone}>
                Keep item
              </Button>
            </div>
          </>
        ) : (
          <>
            <label htmlFor={reasonId}>
              <b>Cancel {item.id}?</b> Optional reason
            </label>
            {lead && (
              <div className="src" data-lead-warning="">
                {lead.client} is working on this; its run will be interrupted.
              </div>
            )}
            <input
              id={reasonId}
              className="input"
              value={reason}
              maxLength={4000}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Replaced by RCP-33"
              autoComplete="off"
            />
            <div className="row">
              <Button ref={keep} size="sm" onClick={onDone}>
                Keep item
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void cancel()}>
                Cancel item
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
