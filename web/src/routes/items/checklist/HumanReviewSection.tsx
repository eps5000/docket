import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { TEXT_LIMITS, type HumanReviewItem, type ItemDetailResponse } from '@docket/shared';
import { Button, HumanReviewChip, Icon, Provenance, Section } from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { queryKeys } from '../../../lib/api';
import { paths } from '../../../lib/paths';
import { plural } from '../../../lib/format';
import { runOwnerMutation, showToast } from '../../../lib/undo';
import type { ItemKind } from '../ItemPage';
import { AddRow } from './AddRow';
import { HelpLink } from '../../../help/HelpLink';

const LAST: Record<
  'approve' | 'changes' | 'defer',
  { kind: 'owner_approve' | 'owner_changes' | 'owner_defer'; verb: string }
> = {
  approve: { kind: 'owner_approve', verb: 'Looked good' },
  changes: { kind: 'owner_changes', verb: 'Needed changes' },
  defer: { kind: 'owner_defer', verb: 'Deferred · not verified' },
};

/**
 * Human review ("n items · packet ready · what you verify yourself"; *Open
 * packet* in the header when ready), with the notes under it (UI_SPEC
 * §6.3.1). Each row: person icon · text · who added it · state chip;
 * *Edit* and *Remove* while declared; a lock and "In the current packet"
 * while in a packet; the last decision underneath with its provenance.
 */
export function HumanReviewSection({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  const queryClient = useQueryClient();
  const { item } = data;
  const hrs = item.checklist.human_review;
  const packet = data.open_packet;
  const open = !['done', 'canceled'].includes(item.status);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.item(item.id) });
  const note = hrs.length
    ? packet
      ? open
        ? 'New items aren’t in the current packet; the agent includes them next round.'
        : null
      : open
        ? kind === 'epic'
          ? 'Epic-level review: verified once when the epic’s work is ready to merge.'
          : 'The agent writes a handoff packet when the work is built. This ticket can’t close until every item is decided.'
        : null
    : item.checklist.reviewed_with_epic
      ? `None on this ticket. It is reviewed with its epic: ◆ ${item.epic_title ?? item.checklist.reviewed_with_epic}`
      : kind === 'epic'
        ? 'None on the epic itself. Reviews, if any, live on its tickets.'
        : 'No human review declared. When its checks pass, the agent can close this without you.';

  const add = async (text: string) => {
    try {
      await runOwnerMutation(
        () => apiClient['humanReview.add']({ params: { id: item.id }, body: { text } }),
        { success: 'Added to human review.', refetch: [queryKeys.item(item.id)] },
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t add it. Try again.');
    }
    await refresh();
  };

  return (
    <Section
      sectionKey="humanrev"
      title="Human review"
      summary={`${hrs.length ? plural(hrs.length, 'item') : 'none'}${packet ? ' · packet ready' : ''} · what you verify yourself`}
      extraHead={
        <>
          {packet && (
            <Link className="btn primary sm" to={paths.review(item.id)}>
              <Icon name="packet" /> Open packet
            </Link>
          )}
          <HelpLink anchor="item.human-review" />
        </>
      }
    >
      {hrs.map((h) => (
        <HumanReviewRow key={h.id} itemId={item.id} hr={h} onChanged={refresh} />
      ))}
      {note && <div className="src">{note}</div>}
      {open && (
        <AddRow
          label="New human review item"
          placeholder={
            kind === 'epic'
              ? 'Add something you’ll verify, e.g. Walk through the whole feature before the PR merges'
              : 'Add something you’ll verify, e.g. Try it on your phone'
          }
          onAdd={(text) => void add(text)}
        />
      )}
    </Section>
  );
}

function HumanReviewRow({
  itemId,
  hr,
  onChanged,
}: {
  itemId: string;
  hr: HumanReviewItem;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(hr.text);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const editRef = useRef<HTMLButtonElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) areaRef.current?.focus();
    else if (wasEditing.current) editRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const last = hr.last_decision;
  const run = async (fn: () => Promise<{ mutation_id: string }>, success: string) => {
    setBusy(true);
    try {
      const res = await runOwnerMutation(fn, { success, refetch: [queryKeys.item(itemId)] });
      if (res) setEditing(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t save. Try again.');
    } finally {
      setBusy(false);
      await onChanged();
    }
  };
  const save = () => {
    const next = text.trim();
    if (!next || next === hr.text) {
      setEditing(false);
      return;
    }
    void run(
      () =>
        apiClient['humanReview.update']({
          params: { id: itemId, hrId: hr.id },
          body: { expected_version: hr.version, text: next },
        }),
      'Saved. Agents see it on their next read.',
    );
  };
  return (
    <div className="ck" data-hr={hr.id}>
      <span className="sicon" aria-hidden="true">
        <Icon name="person" small />
      </span>
      <div>
        {editing ? (
          <div className="hredit">
            <label className="sr" htmlFor={fieldId}>
              Edit human review item
            </label>
            <textarea
              id={fieldId}
              ref={areaRef}
              className="input"
              value={text}
              maxLength={TEXT_LIMITS.step}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setText(hr.text);
                  setEditing(false);
                }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
              }}
            />
            <div className="row" style={{ marginTop: 6 }}>
              <Button size="sm" variant="primary" onClick={save} disabled={busy}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setText(hr.text);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <b>{hr.text}</b>{' '}
            <span className="hrby">
              {hr.added_by === 'owner'
                ? 'added by you'
                : `added by ${hr.added_by_client ?? 'an agent'}`}
            </span>
          </>
        )}
        {last && (
          <div className="lastdec">
            <Provenance
              kind={LAST[last.kind].kind}
              label={`${LAST[last.kind].verb} · round ${last.round}`}
            />
            {last.note && <> “{last.note}”</>}
          </div>
        )}
        {hr.follow_up_item_id && (
          <div className="lastdec">
            → test ticket{' '}
            <Link to={paths.item(hr.follow_up_item_id)} className="mono">
              {hr.follow_up_item_id}
            </Link>
          </div>
        )}
      </div>
      <div className="hractions">
        {hr.state === 'ready' ? (
          <span className="hrlock">
            <Icon name="lock" small /> In the current packet
          </span>
        ) : (
          <>
            {hr.state === 'declared' && !editing && (
              <>
                <Button
                  ref={editRef}
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit “${hr.text}”`}
                  onClick={() => {
                    setText(hr.text);
                    setEditing(true);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove “${hr.text}”`}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        apiClient['humanReview.remove']({
                          params: { id: itemId, hrId: hr.id },
                          body: { expected_version: hr.version },
                        }),
                      'Removed from human review.',
                    )
                  }
                >
                  Remove
                </Button>
              </>
            )}
          </>
        )}
        <HumanReviewChip state={hr.state} />
      </div>
    </div>
  );
}
